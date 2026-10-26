import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { FROM_SOURCE, devClient } from '../packages/engine/src/server/devclient.js';
import { CLIENT_FILES } from '../packages/mistri/src/server/clientFiles.js';
import { createApp } from './support/createApp.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { AddressMount } from '../packages/engine/src/shared/mount.js';

const appId = 'browser-proof';
async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function fixture(t: TestContext, browser = true, mount?: AddressMount, suite?: { port: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-browser-host-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  } finally {
    db.close();
  }
  const source = { id: 'business', connection: 'fixture-business' };
  provisionSqliteTenantStore(business, { appId, source, storeId: 'fixture-store' });
  const port = suite?.port ?? (await portFor()),
    origin = `http://127.0.0.1:${port}`;
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  t.after(async () => {
    try {
      owner?.server.closeAllConnections();
      await owner?.retire();
    } finally {
      auth?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Browser proof',
        auth: {
          store,
          signUp: 'open',
          rows: 'tenant',
          roles: { member: { read: true } },
          ...(mount ? { tenancy: { label: 'Dealer' } } : {}),
        },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'browser fixture',
    ),
  };
  auth = await createAppAuth(loaded, {
    baseURL: `${origin}${mount?.base ?? ''}`,
    trustedOrigins: [origin],
    environment: { BETTER_AUTH_SECRET: 'synthetic-browser-host-secret-at-least-thirty-two-characters' },
  });
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    ...(suite ? { sourceClient: false as const } : {}),
    ...(browser ? { browser: true } : {}),
    ...(mount ? { mount } : {}),
    bound: { host: '127.0.0.1', port },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: 'fixture-store',
        ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => ({ item: true }),
        resolveRows: () => ({ item: true }),
      }),
      source: { ...source, existingPath: business },
      deployment: 'browser-generation',
      roles: ['member'],
      maxLifetimeMs: 60000,
    },
  });
  if (!suite) {
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
  }
  const get = (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, signal: AbortSignal.timeout(10000) });
  const signup = async (base = '') => {
    const response = await get(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Browser User', email: 'browser@example.test', password: 'browser-test-password-123' }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  };
  return { owner, auth, get, signup, origin, port };
}

test('private browser opt-in serves shell, deep links and source assets with safe HEAD', async (t) => {
  const f = await fixture(t);
  for (const path of ['/', '/browser-proof/item/~42', '/browser-proof/@detail~42']) {
    const response = await f.get(path),
      html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.match(html, /<!doctype html/i);
    assert.equal(response.headers.get('x-mistri-tenant'), null);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const head = await f.get(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  // Built, the entry is named for its content; index.html is where it is found.
  const entry = FROM_SOURCE
    ? '/boot.js'
    : (/<script type="module"[^>]*\ssrc="([^"]+)"/.exec(await (await f.get('/browser-proof')).text())?.[1] ?? '/no-entry-named.js');
  const asset = await f.get(entry);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.ok((await asset.text()).length > 0);
  const headAsset = await f.get(entry, { method: 'HEAD' });
  assert.equal(headAsset.status, 200);
  assert.equal(await headAsset.text(), '');
});

test("a tenant App's page carries no data: the reader chooses the tenant first, and every read after carries its context", async (t) => {
  const f = await fixture(t);
  for (const cookie of ['', await f.signup()]) {
    for (const path of ['/browser-proof', '/browser-proof/items']) {
      const response = await f.get(path, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.doesNotMatch(await response.text(), /tablewalk-first-paint/);
    }
  }
});

test('browser root GET and HEAD redirect to the canonical encoded App path', async (t) => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/?app=wrong&tenant=not-selected']) {
      const response = await f.get(path, { method, redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), `/${encodeURIComponent(appId)}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('x-mistri-tenant'), null);
    }
  }
});

test('a trailing slash is the same address without it, query kept', async (t) => {
  const f = await fixture(t);
  const app = `/${encodeURIComponent(appId)}`;
  for (const [path, resolved] of [
    [`${app}/`, app],
    [`${app}//`, app],
    [`${app}/item/?tenant=north`, `${app}/item?tenant=north`],
  ]) {
    const response = await f.get(path, { redirect: 'manual' });
    assert.equal(response.status, 308, path);
    const to = new URL(response.headers.get('location')!, `http://x${path}`);
    assert.equal(to.pathname + to.search, resolved, path);
  }
});

test('browser disabled retains API-only behavior and original WHOAMI envelopes', async (t) => {
  const f = await fixture(t, false);
  const root = await f.get('/');
  assert.ok(root.status >= 400);
  assert.doesNotMatch(await root.text(), /<!doctype html/i);
  const signedOut = await f.get(`/api/whoami?app=${appId}`);
  assert.equal(signedOut.status, 200);
  assert.deepEqual(await signedOut.json(), {
    signedIn: false,
    accountId: null,
    appId,
    who: null,
    header: null,
    signIn: { app: 'Browser proof', providers: ['email'], signUp: 'open' },
  });
  const cookie = await f.signup();
  const signedIn = await f.get(`/api/whoami?app=${appId}`, { headers: { cookie } });
  const value = await signedIn.json();
  assert.equal(value.signedIn, true);
  assert.equal(Object.hasOwn(value, 'tenant'), false);
  assert.equal(Object.hasOwn(value, 'appName'), false);
});

test('only successful browser WHOAMI replies advertise tenant capability without selecting a tenant', async (t) => {
  const f = await fixture(t);
  for (const cookie of ['', await f.signup()]) {
    const response = await f.get(`/api/whoami?app=${appId}`, { headers: { cookie } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.tenant, true);
    assert.equal(body.signedIn, Boolean(cookie));
    assert.equal(body.appName, 'Browser proof');
    for (const field of ['tenantId', 'tabId', 'context', 'roles', 'sessionId']) assert.equal(Object.hasOwn(body, field), false);
    for (const header of ['tenant', 'tab', 'context']) assert.equal(response.headers.get(`x-mistri-${header}`), null);
  }
  const failure = await f.get('/api/whoami?app=wrong');
  assert.ok(failure.status >= 400);
  assert.equal(Object.hasOwn(await failure.json(), 'tenant'), false);
});

test('static opt-in cannot turn API refusals into an HTML or Registry fallback', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api',
    '/api/missing',
    '/api/query',
    '/api/connections',
    '/api/schema',
    '/api/tenant/bootstrap',
    '/%61pi/query',
    '/api%2fquery',
    '/%2fapi/query',
    '/alias%2f..%2fapi/query',
  ]) {
    const response = await f.get(path),
      text = await response.text();
    assert.ok(response.status >= 400, `${path}: ${text}`);
    assert.doesNotMatch(text, /<!doctype html|physical_item|fixture-business/i);
    assert.match(response.headers.get('content-type')!, /application\/json/);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await f.get('/browser-proof/item', { method });
    assert.equal(response.status, 405);
    assert.doesNotMatch(await response.text(), /<!doctype html/i);
  }
});

test('static routes retain raw canonical-path and Host checks', async (t) => {
  const f = await fixture(t);
  for (const [path, host, status] of [
    ['/one/../', `127.0.0.1:${f.port}`, 400],
    ['/', 'untrusted.example', 403],
  ] as const) {
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path, headers: { host } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.status, status);
    assert.doesNotMatch(response.text, /<!doctype html/i);
  }
});

test('browser opt-in is strictly true and hostile option accessors never execute', async () => {
  for (const browser of [false, undefined, null, 1, 'true', {}]) {
    await assert.rejects(createTenantAuthenticatedHttpServer({ browser } as never), TenantContextError);
  }
  let called = false;
  const options = Object.defineProperty({}, 'browser', {
    enumerable: true,
    get: () => {
      called = true;
      return true;
    },
  });
  await assert.rejects(createTenantAuthenticatedHttpServer(options as never), TenantContextError);
  assert.equal(called, false);
});

test('retirement drains an accepted static transform before closing native auth', { skip: !FROM_SOURCE }, async (t) => {
  const f = await fixture(t),
    auth = captureAppAuthRuntime(f.auth);
  const vite = await devClient(CLIENT_FILES);
  const original = vite.transformIndexHtml;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vite.transformIndexHtml = async (url, html) => {
    enter();
    await held;
    return original.call(vite, url, html);
  };
  const response = f.get('/slow-deep-link').then(async (res) => ({ status: res.status, text: await res.text() }));
  try {
    await entered;
    let retired = false;
    const retirement = f.owner.retire().then(() => {
      retired = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retired, false);
    auth.assertCurrent();
    release();
    const answer = await response;
    assert.equal(answer.status, 200);
    assert.match(answer.text, /<!doctype html/i);
    // The transform and full body have completed; reap its now-idle socket
    // without interrupting the accepted work whose lifetime this test checks.
    f.owner.server.closeIdleConnections();
    await retirement;
    assert.throws(auth.assertCurrent, TenantContextError);
  } finally {
    release();
    vite.transformIndexHtml = original;
    await response.catch(() => {});
  }
});

test('ordinary index uses the same client shell without acquiring any Registry adapter', async (t) => {
  const registry = new Registry();
  registry.open = async () => {
    throw new Error('Static requests must not acquire a database');
  };
  const server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.closeAll();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(origin + '/ordinary/deep-link');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html/i);
  const head = await fetch(origin + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

/* The one App at the root, and under a proxy's base path, as the ordinary
   App server serves it (shared/mount.ts); the chooser drawn in the App's
   look and in its word for a tenant (KS-OBSERVE #3). */
test('a mounted tenant App is served at the root of its base, its page carrying its mount and name, and who-am-I its look and tenant label', async (t) => {
  const f = await fixture(t, true, { base: '/tools', apps: { [appId]: '' } });
  const home = await f.get('/tools/', { redirect: 'manual' });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(
    html,
    /<meta name="mistri-mount" content="\{&quot;base&quot;:&quot;\/tools&quot;,&quot;apps&quot;:\{&quot;browser-proof&quot;:&quot;&quot;\}\}">/,
  );
  assert.match(html, /<title>Browser proof<\/title>/);
  assert.equal((await f.get('/tools/items')).status, 200, 'a view at the root is a page of the App, not an App id');
  assert.equal((await f.get('/items')).status, 404, 'outside the base names nothing');
  const signedOut = (await (await f.get(`/tools/api/whoami?app=${appId}`)).json()) as { signIn: { look?: { id: string } } };
  assert.equal(signedOut.signIn.look?.id, appId, "the door is in the App's own look");
  const cookie = await f.signup('/tools');
  const me = (await (await f.get(`/tools/api/whoami?app=${appId}`, { headers: { cookie } })).json()) as Record<string, unknown>;
  assert.equal(me.signedIn, true);
  assert.equal(me.tenantLabel, 'Dealer');
  assert.equal((me.look as { id?: string }).id, appId);
});

test('two enrolled tenant browser hosts share suite transport while keeping sign-in and retirement isolated', async (t) => {
  const port = await portFor();
  const root = await fixture(t, true, { base: '', apps: { [appId]: '' } }, { port });
  const child = await fixture(t, true, { base: '/child', apps: { [appId]: '' } }, { port });
  const suite = await createSuite(
    [
      { id: 'root', open: async () => ({ server: root.owner.server, stop: root.owner.retire, close: async () => {} }) },
      { id: 'child', open: async () => ({ server: child.owner.server, stop: child.owner.retire, close: async () => {} }) },
    ],
    { mounts: { root: '/', child: '/child' } },
  );
  t.after(() => suite.close());
  suite.server.listen(port, '127.0.0.1');
  await once(suite.server, 'listening');
  try {
    const cookie = await root.signup();
    const own = await root.get(`/api/whoami?app=${appId}`, { headers: { cookie } });
    assert.equal((await own.json()).signedIn, true);
    const other = await root.get(`/child/api/whoami?app=${appId}`, { headers: { cookie } });
    assert.equal((await other.json()).signedIn, false);
    const childCookie = await child.signup('/child');
    const childWho = await child.get(`/child/api/whoami?app=${appId}`, { headers: { cookie: childCookie } });
    assert.equal((await childWho.json()).signedIn, true);
    for (const path of ['/', '/child/']) {
      const page = await root.get(path);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<!doctype html/i);
    }
    // Retiring one child must not tear down the shared source client or its sibling.
    await child.owner.retire();
    const remaining = await root.get(`/api/whoami?app=${appId}`, { headers: { cookie } });
    assert.equal((await remaining.json()).signedIn, true);
    if (FROM_SOURCE) {
      const asset = await root.get('/boot.js');
      assert.equal(asset.status, 200);
      await asset.text();
    }
  } finally {
    await suite.close();
  }
});
