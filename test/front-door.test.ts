/**
 * The front door (http/frontDoor.ts): every server that takes a person's
 * request is made by it, so the same few things hold on all of them whatever
 * they serve. The table starts the four on `listen(0)`: the single-App
 * server, a tenant App's browser host (the authenticated one, which holds the
 * tenant data server inside it), the tenant data server on its own, and the
 * suite. Each is asked the same questions: the baseline headers on a page, a
 * 404 and a refusal; the transport pin only from a trusted proxy's word; a
 * Host the server does not serve; and another site's write.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { retireDevClient } from '../packages/engine/src/server/devclient.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { PERMISSIONS_POLICY, REFERRER_POLICY, STRICT_TRANSPORT } from '../packages/engine/src/server/http/baselineHeaders.js';
import type { Bound } from '../packages/engine/src/server/http/trust.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createApp } from './support/createApp.js';

const scratch = mkdtempSync(join(tmpdir(), 'mistri-front-door-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Answer {
  status: number;
  headers: IncomingMessage['headers'];
}

function ask(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error('front door request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function listening(server: Server): Promise<number> {
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return (server.address() as { port: number }).port;
}

type Started = { port: number; close: () => Promise<void> };

async function app(): Promise<Started> {
  const directory = mkdtempSync(join(scratch, 'app-'));
  const data = join(directory, 'app.db');
  const db = new DatabaseSync(data);
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.close();
  const dir = join(directory, 'app');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      name: 'Door',
      resources: { item: { access: 'write' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  const registry = new Registry();
  registry.add({ name: 'rw', url: data, writable: true, source: 'config' });
  registry.setActive('rw');
  await registry.open('rw');
  const where: Bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [{ app: await loadApp(dir), pages: [] }], bound: where });
  where.port = await listening(server);
  return {
    port: where.port,
    close: async () => {
      server.closeAllConnections();
      await retireDevClient(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
    },
  };
}

async function suite(): Promise<Started> {
  const inner: Bound = { host: '127.0.0.1', port: 0 };
  /* The child answers a page through its own source client under tsx (Vite), which its close must retire. */
  const child = createApp({ registry: new Registry(), bound: inner });
  const made = await createSuite(
    [{ id: 'wb', open: async () => ({ server: child, stop: async () => {}, close: () => retireDevClient(child) }) }],
    {
      mounts: { wb: '/' },
    },
  );
  inner.port = await listening(made.server);
  await made.start();
  return { port: inner.port, close: () => made.close() };
}

/** A tenant App over SQLite, as door.test.ts stands one up: its store, its sign-in and one tenant-owned table. */
async function tenantFixture() {
  const appId = 'front-door';
  const directory = mkdtempSync(join(scratch, 'tenant-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  db.close();
  const source = { id: 'business', connection: 'fixture-business' };
  provisionSqliteTenantStore(business, { appId, source, storeId: 'fixture-store' });
  const probe = createServer();
  const port = await listening(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Front door',
        auth: { store, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'front door fixture',
    ),
  };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId,
    storeId: 'fixture-store',
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => ({ item: true }),
    resolveRows: () => ({ item: true }),
  });
  const enrollmentInput = {
    policy,
    source: { ...source, existingPath: business },
    deployment: 'front-door-generation',
    roles: ['member'],
    maxLifetimeMs: 60000,
  };
  return { port, loaded, enrollmentInput };
}

async function tenantBrowser(): Promise<Started> {
  const { port, loaded, enrollmentInput } = await tenantFixture();
  const origin = `http://127.0.0.1:${port}`;
  const auth: AppAuthRuntime = await createAppAuth(loaded, {
    baseURL: origin,
    trustedOrigins: [origin],
    environment: { BETTER_AUTH_SECRET: 'synthetic-front-door-secret-at-least-thirty-two-characters' },
  });
  const owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port },
    enrollment: enrollmentInput,
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');
  return {
    port,
    close: async () => {
      owner.server.closeAllConnections();
      await retireDevClient(owner.server);
      await owner.retire();
      auth.close();
    },
  };
}

async function tenantData(): Promise<Started> {
  const { loaded, enrollmentInput } = await tenantFixture();
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app: loaded.app,
    pages: [],
    ...enrollmentInput,
    verifySession: async () => null,
  });
  const bound: Bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({ app: loaded.app, enrollment, bound, verifySessionInstance: () => null });
  bound.port = await listening(owner.server);
  return {
    port: bound.port,
    close: async () => {
      owner.server.closeAllConnections();
      await retireDevClient(owner.server);
      await new Promise<void>((resolve) => owner.server.close(() => resolve()));
      await owner.retire();
      await enrollment.retire();
    },
  };
}

const SERVERS: { name: string; start: () => Promise<Started>; page: string; missing: string; write: string }[] = [
  { name: 'the single-App server', start: app, page: '/', missing: '/api/no-such-route', write: '/api/insert' },
  { name: 'the suite', start: suite, page: '/', missing: '/api/no-such-route', write: '/api/query' },
  { name: 'a tenant App’s browser host', start: tenantBrowser, page: '/', missing: '/api/no-such-route', write: '/api/query' },
  { name: 'the tenant data server', start: tenantData, page: '/api/schema', missing: '/api/no-such-route', write: '/api/query' },
];

const BASELINE = (headers: IncomingMessage['headers'], where: string) => {
  assert.equal(headers['referrer-policy'], REFERRER_POLICY, `${where}: referrer policy`);
  // An App's own page may ask for the camera (clientHttp.ts); everything else keeps the baseline.
  const policy = String(headers['permissions-policy']);
  assert.ok(policy === PERMISSIONS_POLICY || policy === PERMISSIONS_POLICY.replace('camera=()', 'camera=(self)'), `${where}: ${policy}`);
  assert.match(policy, /microphone=\(\)/, where);
  assert.equal(headers['strict-transport-security'], undefined, `${where}: plain http is never pinned to https`);
};

for (const row of SERVERS) {
  describe(row.name, () => {
    let started: Started;
    test('starts on a port of its own', async () => {
      started = await row.start();
      assert.ok(started.port > 0);
    });
    after(() => started?.close());

    test('a page, a missing route and a bad target each carry the baseline headers', async () => {
      for (const path of [row.page, row.missing, '//no-such-host/x']) {
        const answer = await ask(started.port, path);
        BASELINE(answer.headers, path);
      }
    });

    test('the transport pin follows a trusted proxy’s word that it forwarded https, and nothing else', async () => {
      const proxied = await ask(started.port, row.missing, { 'x-forwarded-proto': 'https' });
      assert.equal(proxied.headers['strict-transport-security'], STRICT_TRANSPORT);
      const plain = await ask(started.port, row.missing, { 'x-forwarded-proto': 'http' });
      assert.equal(plain.headers['strict-transport-security'], undefined);
    });

    test('a Host it does not serve is refused, with the baseline on the refusal', async () => {
      const answer = await ask(started.port, row.page, { host: 'evil.example' });
      assert.equal(answer.status, 403);
      BASELINE(answer.headers, 'wrong host');
    });

    test('another site’s write is refused, with the baseline on the refusal', async () => {
      const answer = await ask(
        started.port,
        row.write,
        { origin: 'http://evil.example', 'content-type': 'application/json' },
        'POST',
        '{}',
      );
      assert.equal(answer.status, 403);
      BASELINE(answer.headers, 'cross-origin write');
    });
  });
}

describe('the suite’s own probes', () => {
  let started: Started;
  after(() => started?.close());
  test('/readyz carries the baseline headers too', async () => {
    started = await suite();
    const answer = await ask(started.port, '/readyz');
    assert.equal(answer.status, 200);
    BASELINE(answer.headers, '/readyz');
  });
});
