/** A storefront Host is presentation intent, even with a real staff cookie. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig, signInOf } from '../packages/mistri/src/shared/app.js';
import { assignableRoles } from '../packages/mistri/src/shared/accountAdministration.js';
import { parseTestApp } from './support/commandCatalog.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, createSuiteAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { provisionSuiteGrantStore, openSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { FIRST_PAINT_ELEMENT } from '../packages/engine/src/shared/firstPaint.js';

const publicURL = 'http://localhost:4111';
const loaded = (app: LoadedApp['app']): LoadedApp => ({ path: 'public-host-test', app, pages: [], sources: {} });

function call(
  port: number,
  host: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new Promise<{ status: number; body: any; text: string; cookies: string[]; account: string | string[] | undefined }>(
    (resolve, reject) => {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: options.method ?? (body === undefined ? 'GET' : 'POST'),
          headers: {
            host,
            origin: host === 'staff.example' && path.startsWith('/api/auth/') ? publicURL : `http://${host}`,
            'content-type': 'application/json',
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
            ...options.headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({
              status: res.statusCode!,
              body: parsed,
              text,
              cookies: res.headers['set-cookie'] ?? [],
              account: res.headers['x-mistri-account'],
            });
          });
        },
      );
      /* Generous: a public page's first request is drawn through the dev client's
         transforms, which a cold, shared CI runner can take seconds over. */
      req.setTimeout(30000, () => req.destroy(new Error('Public host request timed out.')));
      req.on('error', reject);
      req.end(body);
    },
  );
}

function upgrade(port: number, host: string, path: string, cookie: string, protocol?: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Public host upgrade timed out.')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('close', () => resolve(text));
    socket.on('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`,
      ),
    );
  });
}

async function fixture(t: TestContext, policy: boolean | 'placement' = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-public-host-'));
  const grantsDb = new DatabaseSync(join(directory, 'grants.db'));
  provisionSuiteGrantStore(grantsDb, 'shared');
  const grants = openSuiteGrantStore(grantsDb, 'shared');
  const environment = { BETTER_AUTH_SECRET: 'test-public-host-secret-longer-than-thirty-two-characters' };
  const native = await createAppAuth(
    loaded(
      parseAppConfig(
        {
          id: 'shared',
          name: 'Shared',
          auth: { store: join(directory, 'auth.db'), providers: ['email'], signUp: 'open', roles: { user: { read: true } } },
          resources: { unused: {} },
          views: { home: { kind: 'list', from: 'unused' } },
          home: 'home',
        },
        'test native',
      ),
    ),
    { baseURL: publicURL, trustedOrigins: [publicURL], environment },
  );
  let suite: Awaited<ReturnType<typeof createSuite>> | undefined;
  t.after(async () => {
    try {
      await suite?.close();
    } finally {
      native.close();
      grantsDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const file = join(directory, 'store.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT, secret TEXT);
    INSERT INTO item VALUES(1, 'Public product', 'staff-only-secret');
    CREATE TABLE application(id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);`);
  if (policy === 'placement') db.exec("INSERT INTO item VALUES(2, 'South product', 'south-staff-secret');");
  db.close();
  migrateSqliteCommandJournal(file);
  const input = { name: { type: 'text', max: 80 } } as const;
  const commands = defineCommands({
    save: defineCommand({
      targets: 'none',
      source: 'data',
      target: 'application',
      read: ['application'],
      write: ['application'],
      public: true,
      input,
      output: shape({ message: literal('Saved.') }),
      async handle({ db, draft }, values) {
        assert.ok(draft);
        if (draft.root) await db.application.update(await db.application.get(draft.root), values);
        else await db.application.insert({ ...values, ...draft.start });
        return { message: 'Saved.' as const };
      },
    }),
    submit: defineCommand({
      targets: 'none',
      source: 'data',
      target: 'application',
      read: ['application'],
      write: ['application'],
      public: true,
      input: {},
      output: shape({ reference: text(), message: literal('Submitted.') }),
      async handle({ db, draft }) {
        await db.application.update(await db.application.get(draft!.root!), { status: 'submitted' });
        return { reference: randomUUID(), message: 'Submitted.' as const };
      },
    }),
  });
  const store = loaded(
    parseTestApp(
      {
        id: 'store',
        name: 'Store',
        sources: { data: { connection: 'data' } },
        resources: { item: { access: 'write' }, application: { access: 'write' } },
        auth: {
          providers: ['email'],
          signUp: 'open',
          ...(policy ? { rows: 'policy' } : {}),
          roles: { staff: { read: true, write: ['item'] } },
          public: { read: ['item'], fields: { item: { read: ['id', 'name'] } } },
        },
        views: {
          items: { kind: 'list', from: 'item' },
          ...(policy
            ? {}
            : {
                apply: {
                  kind: 'form',
                  label: 'Apply',
                  public: true,
                  command: { id: 'submit', version: 1, input: {} },
                  steps: [{ id: 'name', label: 'Name', command: { id: 'save', version: 1, input } }],
                  resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress' },
                  draft: { status: 'draft' },
                },
              }),
        },
        home: [{ view: 'items', signedOut: true }, { view: 'items' }],
      },
      'store fixture',
    ),
  );
  const policyFile = policy ? join(directory, 'policy.mjs') : undefined;
  if (policyFile)
    writeFileSync(
      policyFile,
      `export default {appId:'store',resolveRows:()=>({item:true,application:true})${
        policy === 'placement'
          ? ",resolvePublicRows:intent=>!intent?{}:{item:{groups:[[{column:'id',op:'=',value:intent.tenant==='opaque'?1:2}]]}}"
          : ''
      }};`,
    );
  const tenantFile = join(directory, 'dealer.db');
  const tenantDb = new DatabaseSync(tenantFile);
  tenantDb.exec(`CREATE TABLE item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT);
    INSERT INTO item VALUES('one','north','private-tenant-product');`);
  tenantDb.close();
  provisionSqliteTenantStore(tenantFile, { appId: 'dealer', source: { id: 'data', connection: 'data' }, storeId: 'tenant-store' });
  const dealer = loaded(
    parseAppConfig(
      {
        id: 'dealer',
        name: 'Dealer',
        sources: { data: { connection: 'data' } },
        auth: { providers: ['email'], signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        resources: { item: { owner: 'tenant', fields: { read: ['id', 'name'] } } },
        views: {
          items: { kind: 'list', from: 'item' },
          welcome: { kind: 'landing', hero: { heading: 'Public dealer', actions: [{ label: 'Staff', signIn: true }] } },
        },
        home: [{ view: 'welcome', signedOut: true }, { view: 'items' }],
      },
      'dealer fixture',
    ),
  );
  let membershipCalls = 0,
    upgradeCalls = 0;
  const children: Server[] = [];
  suite = await createSuite(
    [
      {
        id: 'store',
        public: true,
        open: async (basePath, { allowedHosts }) => {
          const registry = new Registry({ environment });
          registry.add({ name: 'data', url: file, writable: true, source: 'config' });
          const suiteAuth = createSuiteAppAuth(native, {
            appId: 'store',
            spec: signInOf(store.app.auth)!,
            roles: assignableRoles(store.app.auth),
            basePath,
            suiteBase: '',
            grant: grants.read,
          });
          const child = await openSuiteApp({
            app: store,
            registry,
            suiteAuth,
            basePath,
            publicURL,
            environment,
            policyFile,
            ...(policy ? {} : { commands: { appId: 'store', registry: commands } }),
            bound: { host: '127.0.0.1', port: 0, allowedHosts, identityHeader: 'x-forwarded-user' },
          });
          child.server.on('upgrade', (_req, socket) => {
            upgradeCalls++;
            socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
          });
          children.push(child.server);
          return child;
        },
      },
      {
        id: 'dealer',
        public: true,
        open: async (basePath, { allowedHosts }) => {
          const suiteAuth = createSuiteAppAuth(native, {
            appId: 'dealer',
            spec: signInOf(dealer.app.auth)!,
            roles: assignableRoles(dealer.app.auth),
            basePath,
            suiteBase: '',
            grant: grants.read,
          });
          const child = await createTenantAuthenticatedHttpServer({
            loaded: dealer,
            auth: suiteAuth,
            browser: true,
            sourceClient: false,
            mount: { base: basePath, apps: { dealer: '' } },
            bound: { host: '127.0.0.1', port: 0, allowedHosts },
            enrollment: {
              policy: defineAppTenantPolicy({
                kind: 'tenant',
                appId: 'dealer',
                storeId: 'tenant-store',
                ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
                resolveMembershipRows: () => {
                  membershipCalls++;
                  return { item: true };
                },
                resolveRows: () => ({ item: true }),
              }),
              source: { id: 'data', connection: 'data', existingPath: tenantFile },
              deployment: 'public-host-test',
              roles: ['member'],
              maxLifetimeMs: 60000,
            },
          });
          child.server.on('upgrade', (_req, socket) => {
            upgradeCalls++;
            socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
          });
          children.push(child.server);
          return { server: child.server, stop: child.retire, close: child.retire };
        },
      },
    ],
    {
      mounts: { store: '', dealer: 'dealer' },
      publicOrigin: 'https://staff.example',
      hosts: [
        { host: 'shop.example', app: 'store', tenant: 'opaque' },
        { host: 'dealer.example', app: 'dealer', tenant: 'north' },
        ...(policy === 'placement' ? [{ host: 'south.example', app: 'store', tenant: 'south' }] : []),
      ],
    },
    {
      route(req, res) {
        return req.url?.startsWith('/api/auth/') ? native.handler(req, res) : undefined;
      },
      close() {},
    },
  );
  await new Promise<void>((resolve) => suite!.server.listen(0, '127.0.0.1', resolve));
  const port = (suite.server.address() as { port: number }).port;
  const signed = await call(port, 'staff.example', '/api/auth/sign-up/email', {
    body: {
      name: 'Staff',
      email: 'staff@example.test',
      password: 'public-host-test-password',
    },
  });
  assert.equal(signed.status, 200, signed.text);
  const cookie = signed.cookies.map((value) => value.split(';')[0]).join('; '),
    subjectId = signed.body.user.id as string;
  assert.match(cookie, /mistri-shared.session_token=/);
  for (const [appId, roles] of [
    ['store', ['staff']],
    ['dealer', ['member']],
  ] as const) {
    grants.change({ appId, subjectId, roles: [...roles], declaredRoles: [...roles], actorId: 'operator', expectedRevision: 0 });
  }
  const seed = new DatabaseSync(tenantFile);
  seed.prepare(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant')`).run();
  seed
    .prepare(`INSERT INTO "${TENANT_TABLES.membership}" VALUES('membership','north',?,'active','1','["member"]',?,'member',NULL,NULL,NULL)`)
    .run(subjectId, Date.now() + 120000);
  seed.close();
  return { port, cookie, subjectId, file, children, membershipCalls: () => membershipCalls, upgradeCalls: () => upgradeCalls };
}

for (const policy of [false, true])
  test(`mapped ordinary host ignores valid suite cookies and trusted proxy identity (${policy ? 'row policy' : 'role grant'})`, async (t) => {
    const f = await fixture(t, policy);
    const staff = await call(f.port, 'staff.example', '/api/whoami', { cookie: f.cookie });
    assert.equal(staff.body.signedIn, true);
    assert.equal(staff.body.accountId, f.subjectId);
    const query = (host: string, q: string, cookie = f.cookie) =>
      call(f.port, host, '/api/run', {
        cookie,
        headers: { 'x-forwarded-user': 'staff@example.test', 'x-mistri-account': f.subjectId },
        body: { app: 'store', q, limit: 10, offset: 0 },
      });
    const privateRead = await query('staff.example', 'item show id, secret');
    assert.equal(privateRead.status, 200, privateRead.text);
    assert.match(privateRead.text, /staff-only-secret/);
    for (const cookie of ['', f.cookie]) {
      const who = await call(f.port, 'shop.example', '/api/whoami', { cookie, headers: { 'x-forwarded-user': 'staff@example.test' } });
      assert.equal(who.status, 200);
      assert.equal(who.body.signedIn, false);
      assert.equal(who.body.accountId, null);
      assert.equal(who.body.who, null);
      assert.equal(who.account, undefined);
      const publicRead = await query('shop.example', 'item show id, name', cookie);
      assert.equal(publicRead.status, 200, publicRead.text);
      assert.deepEqual(publicRead.body.rows, [{ id: 1, name: 'Public product' }]);
      assert.equal(publicRead.account, undefined);
      const hidden = await query('shop.example', 'item show id, secret', cookie);
      assert.ok(hidden.status >= 400 || hidden.body.errors?.length, hidden.text);
      assert.doesNotMatch(hidden.text, /staff-only-secret/);
    }
    for (const [path, body] of [
      ['/api/update', { table: 'item', key: { id: 1 }, values: { name: 'stolen' } }],
      ['/api/commands/prepare', {}],
      ['/api/export', { q: 'item' }],
      ['/api/accounts', undefined],
      ['/api/tenant/context/open?app=store&tenant=opaque', {}],
      ['/api/auth/admin/list-users', undefined],
    ] as const) {
      const reply = await call(f.port, 'shop.example', path, {
        cookie: f.cookie,
        body,
        headers: { 'x-forwarded-user': 'staff@example.test' },
      });
      assert.ok(reply.status >= 400, `${path}: ${reply.text}`);
    }
    const update = await call(f.port, 'staff.example', '/api/update', {
      cookie: f.cookie,
      body: { app: 'store', table: 'item', key: { id: 1 }, values: { name: 'Staff edit' } },
    });
    assert.equal(update.status, 200, update.text);
  });

test('two storefront hosts scope fetched and first-paint rows independently of staff cookies and query hints', async (t) => {
  const f = await fixture(t, 'placement');
  for (const [host, id, name, hidden] of [
    ['shop.example', 1, 'Public product', 'South product'],
    ['south.example', 2, 'South product', 'Public product'],
  ] as const) {
    const rows = await call(f.port, host, '/api/run', {
      cookie: f.cookie,
      body: { app: 'store', q: 'item show id, name', limit: 10, offset: 0 },
      headers: { 'x-forwarded-user': 'staff@example.test' },
    });
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(rows.body.rows, [{ id, name }]);
    assert.deepEqual(rows.cookies, []);
    const guessed = await call(f.port, host, '/api/query', {
      cookie: f.cookie,
      body: {
        table: 'item',
        columns: ['id', 'name'],
        filter: { groups: [[{ column: 'id', op: '=', value: id === 1 ? 2 : 1 }]] },
        limit: 10,
        offset: 0,
      },
    });
    assert.equal(guessed.status, 200, guessed.text);
    assert.deepEqual(guessed.body.rows, []);
    const hinted = await call(f.port, host, '/api/run?tenant=someone-else', {
      body: { app: 'store', q: 'item show id, name', limit: 10, offset: 0 },
    });
    assert.ok(hinted.status >= 400 || hinted.body.rows?.every((row: { id: number }) => row.id === id), hinted.text);
    const page = await call(f.port, host, '/items', { cookie: f.cookie });
    assert.equal(page.status, 200, page.text.slice(0, 300));
    const block = new RegExp(`<script type="application/json" id="${FIRST_PAINT_ELEMENT}">([\\s\\S]*?)</script>`).exec(page.text);
    assert.ok(block, 'public page carries its first-paint data');
    assert.ok(block[1].includes(name), 'first paint carries the admitted storefront row');
    assert.ok(!block[1].includes(hidden), 'first paint cannot carry another storefront');
    assert.ok(!block[1].includes('staff-secret') && !block[1].includes('staff-only-secret'));
    assert.deepEqual(page.cookies, []);
  }
  const neutral = await call(f.port, 'staff.example', '/api/run', {
    body: { app: 'store', q: 'item show id, name', limit: 10, offset: 0 },
  });
  assert.equal(neutral.status, 200, neutral.text);
  assert.deepEqual(neutral.body.rows, []);
  const privateRows = await call(f.port, 'staff.example', '/api/run', {
    cookie: f.cookie,
    body: { app: 'store', q: 'item show id, secret', limit: 10, offset: 0 },
  });
  assert.equal(privateRows.status, 200, privateRows.text);
  assert.equal(privateRows.body.rows.length, 2);
});

test('mapped ordinary public saved forms retain draft cookies alongside a private suite cookie', async (t) => {
  const f = await fixture(t);
  const read = await call(f.port, 'shop.example', '/api/forms/apply', { cookie: f.cookie });
  assert.equal(read.status, 200, read.text);
  const saved = await call(f.port, 'shop.example', '/api/forms/apply/steps/name', {
    cookie: f.cookie,
    body: { input: { name: 'Applicant' }, submission: randomUUID() },
  });
  assert.equal(saved.status, 200, saved.text);
  const draft = saved.cookies.find((value) => value.startsWith('tw_form_apply='))?.split(';')[0];
  assert.ok(draft);
  for (const cookie of [draft, `${f.cookie}; ${draft}`]) {
    const resumed = await call(f.port, 'shop.example', '/api/forms/apply/resume', { cookie, body: {} });
    assert.equal(resumed.status, 200, resumed.text);
    assert.deepEqual(resumed.body, { saved: ['name'] });
  }
  const submitted = await call(f.port, 'shop.example', '/api/forms/apply', {
    cookie: `${f.cookie}; ${draft}`,
    body: { input: {}, submission: randomUUID() },
  });
  assert.equal(submitted.status, 200, submitted.text);
  const db = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM application WHERE name=?').get('Applicant')?.status, 'submitted');
  } finally {
    db.close();
  }
});

test('mapped tenant hosts cannot acquire memberships, contexts, administration or support with staff cookies', async (t) => {
  const f = await fixture(t);
  const staffWho = await call(f.port, 'staff.example', '/dealer/api/whoami?app=dealer', { cookie: f.cookie });
  assert.equal(staffWho.body.signedIn, true);
  const opened = await call(f.port, 'staff.example', '/dealer/api/tenant/context/open?app=dealer&tenant=north', {
    cookie: f.cookie,
    headers: { 'x-mistri-account': f.subjectId },
    body: {},
  });
  assert.equal(opened.status, 200, opened.text);
  const context = {
    'x-mistri-account': f.subjectId,
    'x-mistri-tab': opened.body.tabId,
    'x-mistri-context': opened.body.context,
    'x-mistri-lease-revision': String(opened.body.revision),
  };
  const rows = await call(f.port, 'staff.example', '/dealer/api/query?app=dealer&tenant=north', {
    cookie: f.cookie,
    headers: context,
    body: { table: 'item' },
  });
  assert.equal(rows.status, 200, rows.text);
  assert.match(rows.text, /private-tenant-product/);
  const before = f.membershipCalls();
  for (const method of ['GET', 'HEAD']) {
    const who = await call(f.port, 'dealer.example', '/dealer/api/whoami?app=dealer', { cookie: f.cookie, method });
    assert.equal(who.status, 200);
    assert.equal(who.account, undefined);
    if (method === 'GET') {
      assert.equal(who.body.signedIn, false);
      assert.equal(who.body.accountId, null);
    }
  }
  const landing = await call(f.port, 'dealer.example', '/dealer/api/landing', { cookie: f.cookie });
  assert.equal(landing.status, 200, landing.text);
  assert.match(landing.text, /Public dealer/);
  for (const path of [
    '/api/tenant/context/open?app=dealer&tenant=north',
    '/api/query?app=dealer&tenant=north',
    '/api/tenant/memberships?app=dealer',
    '/api/tenant/administration',
    '/api/tenant/invitations',
    '/api/tenant/support',
    '/api/v1/dealer/items',
    '/api/commands/prepare',
  ]) {
    const response = await call(f.port, 'dealer.example', `/dealer${path}`, { cookie: f.cookie, headers: context, body: {} });
    assert.equal(response.status, 403, `${path}: ${response.text}`);
    assert.doesNotMatch(response.text, /private-tenant-product/);
  }
  assert.equal(f.membershipCalls(), before, 'public-host refusals never enter membership/context policy');
});

test('all mapped-host websocket upgrades stop before any App upgrade listener; staff origin still dispatches', async (t) => {
  const f = await fixture(t);
  for (const [host, path] of [
    ['shop.example', '/socket'],
    ['dealer.example', '/dealer/socket'],
  ]) {
    for (const protocol of [undefined, 'private-app', 'vite-hmr', 'vite-ping']) {
      assert.equal(await upgrade(f.port, host, path, f.cookie, protocol), '');
    }
  }
  assert.equal(f.upgradeCalls(), 0);
  assert.match(await upgrade(f.port, 'staff.example', '/socket', f.cookie, 'private-app'), /^HTTP\/1.1 101/);
  assert.equal(f.upgradeCalls(), 1);
});
