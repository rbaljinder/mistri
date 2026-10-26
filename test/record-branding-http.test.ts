import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { transpile, typecheck } from './support/tsc.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { fromRecord } from '../packages/mistri/src/shared/branding.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { builtClient, withHead } from '../packages/engine/src/server/clientHttp.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { baseRecordBranding, closeRecordBranding, type BrandingPresentation } from '../packages/mistri/src/server/http/recordBranding.js';
import { retireDevClient } from '../packages/engine/src/server/devclient.js';
import type { HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseTestApp } from './support/commandCatalog.js';

const hostile = '</script><script>alert(1)</script> & "dealer"';
const branding = (by: 'host' | 'tenant' = 'host') =>
  fromRecord('dealer_site', {
    by,
    tenantField: 'dealer_id',
    publishedField: 'published',
    fallback: { preset: 'sage' },
    fields: { accent: 'color', name: 'name', heading: 'headline', tagline: 'tagline', hours: 'hours', about: 'about' },
  });
function definition(
  options: { denied?: boolean; static?: boolean; tenant?: boolean; policy?: boolean | 'live'; form?: boolean } = {},
): AppDef {
  return (options.form ? parseTestApp : parseAppConfig)(
    {
      id: 'site',
      name: 'Base store',
      ...(options.policy || options.form ? { sources: { main: { connection: 'brand-data' } } } : { connection: 'brand-data' }),
      resources: { dealer_site: {} },
      auth: {
        ...(options.policy ? { rows: 'policy' } : {}),
        roles: { admin: { read: true } },
        public: {
          read: ['dealer_site'],
          ...(options.denied
            ? {
                fields: {
                  dealer_site: { read: ['id', 'dealer_id', 'version', 'published', 'name', 'headline', 'tagline', 'hours', 'about'] },
                },
              }
            : {}),
        },
      },
      ui: { theme: options.static ? { preset: 'sage' } : branding(options.tenant ? 'tenant' : 'host') },
      views: {
        ...(options.form
          ? {
              contact: {
                kind: 'form',
                public: true,
                label: 'Contact',
                done: { title: 'Thanks' },
                command: { id: 'contact', version: 1, input: { name: { type: 'text', label: 'Name' } } },
                steps: [{ id: 'details', label: 'Details', fields: ['name'] }],
              },
            }
          : {}),
        sites: { kind: 'list', from: 'dealer_site' },
        welcome: {
          kind: 'landing',
          hero: {
            heading: 'Base heading',
            description: 'Base tagline',
            highlights: ['{hours}'],
            actions: [{ label: 'Staff', signIn: true }],
          },
          sections: [
            { kind: 'text', title: 'About', text: '{about}' },
            { kind: 'faq', items: [{ question: 'Fixed question', answer: 'Fixed answer' }] },
          ],
        },
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'sites' }],
      nav: ['sites'],
    },
    'branding HTTP fixture',
  );
}
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
type Ask = (path: string, host?: string, method?: string, headers?: Record<string, string>) => Promise<Reply>;
async function fixture(
  run: (value: { ask: Ask; db: DatabaseSync; app: AppDef; signIn(): void }) => Promise<void>,
  options: Parameters<typeof definition>[0] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-branding-http-'));
  const file = join(directory, 'records.db');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE dealer_site (id TEXT PRIMARY KEY, dealer_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, published BOOLEAN NOT NULL, color TEXT, name TEXT, headline TEXT, tagline TEXT, hours TEXT, about TEXT)',
  );
  const insert = db.prepare('INSERT INTO dealer_site VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)');
  insert.run('north-row', 'north', '#1d3f8c', 'North dealer', hostile, 'North tagline', '9–5', 'North about');
  insert.run('south-row', 'south', '#006b73', 'South dealer', 'South heading', 'South tagline', '10–6', 'South about');
  const registry = new Registry();
  registry.add({ id: 'brand-data', name: 'Brand data', url: file, source: 'config' });
  const app = definition(options);
  let signedIn = false;
  const host: AppHost = {
    app: { path: 'branding-fixture.ts', app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: 'unused',
      handler: async () => {},
      close() {},
      session: async () => (signedIn ? { id: 'staff', who: 'staff@example.test', role: 'admin' } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: ['north.example.test', 'south.example.test'] };
  const policyFile = join(directory, 'policy.mjs');
  if (options.policy === 'live')
    writeFileSync(
      policyFile,
      `export default {appId:'site',
    resolveRows:()=>({dealer_site:false}),resolvePublicRows:intent=>intent?{dealer_site:{groups:[
      [{column:'dealer_id',op:'=',value:intent.tenant},{column:'published',op:'=',value:true}]]}}:{}};`,
    );
  const policy =
    options.policy === 'live'
      ? await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: host.auth!.session })
      : options.policy
        ? ({
            matches: () => true,
            appId: 'site',
            withContext: async () => {
              throw new Error('Private denial detail');
            },
            withPublicContext: async () => {
              throw new Error('Public denial detail');
            },
          } as unknown as HttpAppPolicy)
        : undefined;
  const child = createApp({ registry, bound, apps: [host], ...(policy ? { policy } : {}) });
  const router = createTenantHostRouter([
    { host: 'north.example.test', app: 'site', tenant: 'north' },
    { host: 'south.example.test', app: 'site', tenant: 'south' },
  ]);
  const server = createServer((req, res) => {
    if (!router.accept(req)) {
      res.writeHead(403).end();
      return;
    }
    child.emit('request', req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const ask: Ask = (path, host = 'north.example.test', method = 'GET', headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: bound.port, path, method, headers: { host, 'accept-encoding': 'identity', ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  try {
    await run({
      ask,
      db,
      app,
      signIn() {
        signedIn = true;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retireDevClient(child);
    await policy?.retire?.();
    closeRecordBranding(registry);
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const headBrand = (html: string): BrandingPresentation => {
  const match = /<script type="application\/json" id="mistri-branding">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'head has its request presentation');
  return JSON.parse(match[1]);
};

test(
  'cold HTTP head, App and landing resolve one host without leaking a sibling or changing shared definitions',
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ ask, app }) => {
      const original = JSON.stringify(app);
      const north = await ask('/site/welcome');
      assert.equal(north.status, 200);
      const resolved = headBrand(north.body);
      assert.equal(resolved.value.status, 'resolved');
      assert.equal(resolved.value.identity.tenant, 'north');
      assert.equal(resolved.value.content.heading, hostile);
      assert.match(north.body, /<title>North dealer<\/title>/);
      assert.ok(north.body.indexOf('id="mistri-branding"') < north.body.indexOf('Runs before styles'));
      assert.ok(north.body.includes('--accent:#1d3f8c'));
      assert.ok(!north.body.includes(hostile));
      const south = headBrand((await ask('/site/welcome', 'south.example.test')).body);
      assert.equal(south.value.identity.tenant, 'south');
      assert.equal(south.value.content.name, 'South dealer');
      const payload = JSON.parse((await ask('/api/app')).body).app;
      assert.equal(payload.name, 'North dealer');
      assert.equal(payload.ui.theme.branding.identity.tenant, 'north');
      assert.equal(payload.ui.branding, undefined);
      const landing = JSON.parse((await ask('/api/landing')).body);
      assert.equal(landing.landing.hero.heading, hostile);
      assert.deepEqual(landing.landing.hero.highlights, ['9–5']);
      assert.equal(landing.landing.sections[0].text, 'North about');
      assert.deepEqual(landing.landing.hero.actions, app.landing!.content.hero.actions);
      assert.deepEqual(landing.landing.sections[1], app.landing!.content.sections![1]);
      assert.equal(JSON.stringify(app), original);
      const mismatch = headBrand((await ask('/site/welcome?tenant=south')).body);
      assert.equal(mismatch.value.status, 'fallback');
      assert.equal(mismatch.value.identity.recordKey, null);
      assert.equal((await ask('/site/welcome', 'unknown.example.test')).status, 403);
    });
  },
);

test(
  'each HTTP request observes saves/unpublication and conditional landing responses cannot retain old content',
  { timeout: 60_000 },
  async () => {
    await fixture(async ({ ask, db }) => {
      const before = await ask('/api/landing');
      assert.equal((await ask('/api/landing', undefined, 'GET', { 'if-none-match': String(before.headers.etag) })).status, 304);
      db.prepare('UPDATE dealer_site SET name=?, version=version+1 WHERE dealer_id=?').run('Updated north', 'north');
      const changed = await ask('/api/landing', undefined, 'GET', { 'if-none-match': String(before.headers.etag) });
      assert.equal(changed.status, 200);
      assert.equal(JSON.parse(changed.body).app.name, 'Updated north');
      assert.equal(headBrand((await ask('/site/welcome')).body).value.identity.version, '2');
      db.exec("UPDATE dealer_site SET published=0 WHERE dealer_id='north'");
      const unpublished = headBrand((await ask('/site/welcome')).body);
      assert.equal(unpublished.value.status, 'fallback');
      assert.deepEqual(unpublished.value.content, {});
      const head = await ask('/site/welcome', undefined, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal((await ask('/api/landing', undefined, 'HEAD')).body, '');
    });
  },
);

test('denied public fields and failed policy owners fall back rather than borrowing signed-in grants', { timeout: 60_000 }, async () => {
  for (const options of [{ denied: true }, { policy: true }])
    await fixture(async ({ ask, signIn }) => {
      signIn();
      const presentation = headBrand((await ask('/site/welcome')).body);
      assert.equal(presentation.value.status, 'fallback');
      assert.deepEqual(presentation.value.content, {});
      const landing = JSON.parse((await ask('/api/landing')).body);
      assert.equal(landing.app.name, 'Base store');
      assert.equal(landing.app.theme.branding.status, 'fallback');
    }, options);
});

test(
  'a private ordinary head needs an authorized session and selector, and is no-store without first-paint data',
  { timeout: 60_000 },
  async () => {
    await fixture(
      async ({ ask, signIn }) => {
        const anonymous = headBrand((await ask('/site/welcome?tenant=north', 'localhost')).body);
        assert.equal(anonymous.value.status, 'fallback');
        signIn();
        const page = await ask('/site/sites?tenant=north', 'localhost');
        assert.equal(headBrand(page.body).value.status, 'resolved');
        assert.equal(page.headers['cache-control'], 'private, no-store');
        assert.equal(page.headers.vary, 'Cookie');
        assert.ok(!page.body.includes('id="mistri-first-paint"'));
        const none = headBrand((await ask('/site/sites', 'localhost')).body);
        assert.equal(none.value.status, 'fallback');
      },
      { tenant: true },
    );
  },
);

test('public policy branding uses freshly scoped public rows during staff visits and after saves', { timeout: 60_000 }, async () => {
  for (const denied of [false, true])
    await fixture(
      async ({ ask, db, signIn }) => {
        signIn();
        for (const [host, name] of [
          ['north.example.test', 'North dealer'],
          ['south.example.test', 'South dealer'],
        ]) {
          const reply = await ask('/site/welcome', host);
          assert.equal(reply.status, 200);
          const presentation = headBrand(reply.body);
          assert.equal(presentation.value.status, denied ? 'fallback' : 'resolved');
          assert.equal(presentation.value.content.name, denied ? undefined : name);
          assert.equal(presentation.private, false);
        }
        db.exec("UPDATE dealer_site SET name='Saved north',version=2 WHERE dealer_id='north'");
        const saved = JSON.parse((await ask('/api/landing')).body);
        assert.equal(saved.app.name, denied ? 'Base store' : 'Saved north');
        db.exec("UPDATE dealer_site SET published=0 WHERE dealer_id='north'");
        assert.equal(headBrand((await ask('/site/welcome')).body).value.status, 'fallback');
        assert.equal(headBrand((await ask('/site/welcome', 'localhost')).body).value.status, 'fallback');
      },
      { policy: 'live', denied },
    );
});

test('static App responses remain static and carry no request-branding block', { timeout: 60_000 }, async () => {
  await fixture(
    async ({ ask }) => {
      const landing = JSON.parse((await ask('/api/landing')).body);
      assert.equal(landing.app.name, 'Base store');
      assert.deepEqual(landing.app.theme, { preset: 'sage' });
      assert.ok(!(await ask('/site/welcome')).body.includes('id="mistri-branding"'));
    },
    { static: true },
  );
});

test('private record-branding payloads and fallbacks never revalidate or emit an ETag, including HEAD', async () => {
  await fixture(
    async ({ ask, db, signIn }) => {
      signIn();
      const headers = (reply: Reply) => {
        assert.equal(reply.status, 200, reply.body);
        assert.equal(reply.headers['cache-control'], 'private, no-store');
        assert.equal(reply.headers.etag, undefined);
      };
      const path = '/api/app?tenant=north';
      const first = await ask(path, 'localhost');
      headers(first);
      assert.equal(JSON.parse(first.body).app.name, 'North dealer');
      // Reconstruct the validator emitted by the old implementation: unchanged
      // authorized bytes must still produce 200, rather than the former 304.
      const { createHash } = await import('node:crypto');
      const { principalOf } = await import('../packages/engine/src/server/http/context.js');
      const principal = principalOf({ id: 'staff', who: 'staff@example.test', role: 'admin' });
      const tag = `"${createHash('sha256').update(principal).update('\0').update(first.body).digest('base64url').slice(0, 32)}"`;
      const same = await ask(path, 'localhost', 'GET', { 'if-none-match': tag });
      headers(same);
      assert.equal(same.body, first.body);
      db.exec("UPDATE dealer_site SET name='Current north',version=2 WHERE dealer_id='north'");
      const changed = await ask(path, 'localhost', 'GET', { 'if-none-match': tag });
      headers(changed);
      assert.equal(JSON.parse(changed.body).app.name, 'Current north');
      const head = await ask(path, 'localhost', 'HEAD', { 'if-none-match': tag });
      headers(head);
      assert.equal(head.body, '');
      assert.equal(head.headers['content-length'], changed.headers['content-length']);
      // No selector, or a row that becomes invalid after a successful resolution,
      // keeps the private storage boundary while discarding the previous look.
      db.exec("UPDATE dealer_site SET color='invalid' WHERE dealer_id='north'");
      for (const fallbackPath of ['/api/app', path]) {
        const fallback = await ask(fallbackPath, 'localhost', 'GET', { 'if-none-match': tag });
        headers(fallback);
        const value = JSON.parse(fallback.body).app.ui.theme.branding;
        assert.equal(value.status, 'fallback');
        assert.deepEqual(value.content, {});
        assert.equal(value.identity.recordKey, null);
        const fallbackTag = `"${createHash('sha256').update(principal).update('\0').update(fallback.body).digest('base64url').slice(0, 32)}"`;
        headers(await ask(fallbackPath, 'localhost', 'GET', { 'if-none-match': fallbackTag }));
        const fallbackHead = await ask(fallbackPath, 'localhost', 'HEAD', { 'if-none-match': fallbackTag });
        headers(fallbackHead);
        assert.equal(fallbackHead.body, '');
      }
    },
    { tenant: true },
  );
});

test('public forms carry the same public look as their cold head, including staff visits', { timeout: 60_000 }, async () => {
  await fixture(
    async ({ ask, db, signIn }) => {
      signIn();
      /* At the root the App's id is no part of a form's address: `/site/form/contact` is the id said twice and moves here. */
      const head = headBrand((await ask('/form/contact')).body);
      const form = JSON.parse((await ask('/api/forms/contact')).body);
      assert.equal(form.app.name, 'North dealer');
      assert.deepEqual(form.app.theme.branding, head.value);
      assert.equal(form.form.label, 'Contact');
      db.exec("UPDATE dealer_site SET published=0 WHERE dealer_id='north'");
      const after = JSON.parse((await ask('/api/forms/contact')).body);
      assert.equal(after.app.theme.branding.status, 'fallback');
      assert.deepEqual(after.form, form.form);
    },
    { form: true },
  );
});

test('private reader choices stay scoped to their tenant and public looks ignore them', () => {
  const filename = new URL('../packages/kit/src/client/visualTheme.ts', import.meta.url);
  const compiled = transpile(readFileSync(filename, 'utf8'));
  const exports: Record<string, unknown> = {};
  const storage = new Map<string, string>([['mistri.visual-theme', 'mono']]);
  const require = createRequire(filename);
  const root = { dataset: {}, setAttribute() {}, removeAttribute() {} };
  runInNewContext(compiled, {
    exports,
    /* The page's root comes through the shell's host seam (shellHost.ts), which reads this sandbox's document. */
    require: (id: string) =>
      id.includes('/copy/') ? { say: () => 'Default' } : id.endsWith('/shellHost.js') ? { shellRoot: () => root } : require(id),
    document: { documentElement: root },
    window: {
      dispatchEvent() {},
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
    Event: class {},
    console,
  });
  const themes = exports as unknown as typeof import('../packages/kit/src/client/visualTheme.js');
  themes.initVisualTheme();
  const scope = (tenant: string) => JSON.stringify(['branding', 'deployment', 'site', tenant]);
  themes.configureVisualThemes([], 'sage', true, undefined, scope('north'), { isolated: true });
  assert.equal(themes.visualThemeChoice(), 'sage');
  themes.setVisualTheme('mono');
  assert.equal(themes.visualThemeChoice(), 'mono');
  themes.configureVisualThemes([], 'sage', true, undefined, scope('south'), { isolated: true });
  assert.equal(themes.visualThemeChoice(), 'sage');
  themes.initVisualTheme();
  themes.configureVisualThemes([], 'sage', true, undefined, scope('north'), { isolated: true });
  assert.equal(themes.visualThemeChoice(), 'mono');
  themes.configureVisualThemes([], 'sage', true, undefined, scope('north'), { isolated: true, locked: true });
  themes.setVisualTheme('mono');
  assert.equal(themes.visualThemeChoice(), 'sage');
  assert.equal(themes.visualThemesOffered(), false);
});

test('built GET/HEAD/cache headers and startup ignore previous tenant colors, even with hostile text', async () => {
  const app = definition();
  const base = baseRecordBranding(app)!;
  const source = readFileSync(new URL('../packages/kit/src/client/index.html', import.meta.url), 'utf8');
  const html = withHead(source, { branding: base });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((match) => match[1].includes('Runs before styles'))![1];
  const styles = new Map<string, string>();
  runInNewContext(script, {
    document: {
      documentElement: {
        dataset: {},
        style: { setProperty: (key: string, value: string) => styles.set(key, value), getPropertyValue: (key: string) => styles.get(key) },
        hasAttribute: () => false,
      },
      getElementById: (id: string) => (id === 'mistri-branding' ? { textContent: JSON.stringify(base) } : null),
      querySelector: () => null,
    },
    matchMedia: () => ({ matches: false }),
    location: { pathname: '/site' },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => JSON.stringify({ background: '#ff0000', text: '#000000' }) },
    CSS: { supports: () => true },
    setTimeout() {},
  });
  assert.equal(styles.get('--startup-ground'), base.value.theme.light.ground);
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-branding-built-'));
  writeFileSync(join(directory, 'index.html'), source);
  const serve = builtClient(directory);
  let presentation = base;
  const server = createServer((req, res) => {
    void serve(req, res, req.method === 'HEAD', { branding: presentation });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag')!;
    await first.text();
    const again = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('etag'), etag);
    assert.equal(await head.text(), '');
    presentation = { ...base, private: true };
    const privateHead = await fetch(url, { method: 'HEAD', headers: { 'if-none-match': etag } });
    assert.equal(privateHead.status, 200);
    assert.equal(privateHead.headers.get('cache-control'), 'private, no-store');
    assert.equal(privateHead.headers.get('etag'), null);
    assert.match(privateHead.headers.get('vary')!, /Cookie/);
    assert.throws(() =>
      withHead(source, {
        branding: {
          ...base,
          value: {
            ...base.value,
            theme: { ...base.value.theme, light: { ...base.value.theme.light, accent: '#fff;</style><script>evil()</script>' } },
          },
        },
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('integration files pass an isolated TypeScript check', () => {
  const files = [
    '../packages/mistri/src/server/http/recordBranding.ts',
    '../packages/engine/src/server/clientHttp.ts',
    '../packages/mistri/src/server/http/handler.ts',
    '../packages/mistri/src/server/http/appProjection.ts',
    '../packages/mistri/src/server/http/landingRoutes.ts',
    '../packages/mistri/src/server/http/formRoutes.ts',
    '../packages/mistri/src/server/http/publicHead.ts',
    '../packages/mistri/src/server/tenant/tenantHttp.ts',
    '../packages/mistri/src/server/tenant/tenantPublicHttp.ts',
    '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
    '../packages/kit/src/client/visualTheme.ts',
    './record-branding-http.test.ts',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  assert.equal(typecheck(files, { project: fileURLToPath(new URL('../tsconfig.json', import.meta.url)), only: true }), '');
});
