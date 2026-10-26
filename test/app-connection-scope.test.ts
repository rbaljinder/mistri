import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

function app(connection?: string, id = 'fixture'): AppHost {
  return {
    app: {
      path: '/private/operator/app.ts',
      app: {
        id,
        name: 'Fixture app',
        resources: { task: {} },
        views: {},
        nav: [],
        home: [],
        ui: {},
        ...(connection ? { connection } : {}),
      },
      pages: [],
      sources: {},
    },
    pages: [],
    loadError: 'Operator-only details: private_schema, secret_password',
  };
}

async function listening(registry: Registry, apps: AppHost[] | undefined, run: (base: string) => Promise<void>) {
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(`http://${bound.host}:${bound.port}`);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
  }
}

const get = (base: string, path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) });

test('standalone runtime preserves the connection inventory without opening a database', { timeout: 5_000 }, async (t) => {
  for (const apps of [undefined, []]) {
    const registry = new Registry();
    registry.add({ id: 'workbench', name: 'Workbench database', url: '/missing/workbench.db', source: 'config', writable: true });
    const opened = t.mock.method(registry, 'open', async () => {
      throw new Error('Unexpected database open');
    });
    const expected = JSON.parse(JSON.stringify(registry.list()));
    await listening(registry, apps, async (base) => {
      const runtime = await get(base, '/api/runtime');
      assert.equal(runtime.status, 200);
      assert.deepEqual(await runtime.json(), { appConfigured: false });
      const response = await get(base, '/api/connections');
      assert.equal(response.status, 200);
      const metadata = await response.json();
      assert.deepEqual(metadata.connections, expected);
      assert.equal(metadata.active, 'workbench');
      assert.equal(opened.mock.callCount(), 0);
    });
  }
});

test('app runtime exposes authored identities with no default across multiple apps', { timeout: 5_000 }, async (t) => {
  const registry = new Registry();
  registry.add({
    id: 'hidden',
    name: 'Hidden database',
    url: 'postgres://private_user:secret_password@private-host.example/private_db',
    schemas: ['private_schema'],
    source: 'config',
    writable: true,
  });
  registry.add({ id: 'bound-id', name: 'Bound database', url: '/private/operator/bound.db', source: 'argument', writable: true });
  registry.add({ id: 'bound-by-name', name: 'Named source', url: '/private/operator/shape.db', source: 'config', rows: false });
  const opened = t.mock.method(registry, 'open', async () => {
    throw new Error('Unexpected database open');
  });
  await listening(registry, [app('bound-id', 'first'), app('Named source', 'second')], async (base) => {
    const response = await get(base, '/api/runtime');
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.deepEqual(metadata, {
      appConfigured: true,
      active: null,
      apps: [
        { id: 'first', name: 'Fixture app', writable: true },
        { id: 'second', name: 'Fixture app', writable: false, rows: false },
      ],
    });
    assert.doesNotMatch(JSON.stringify(metadata), /hidden|private|secret|postgres|operator|schemas|dialect|loadError|config|argument/);
    const head = await fetch(`${base}/api/runtime`, { method: 'HEAD', signal: AbortSignal.timeout(2_000) });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${base}/api/runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(post.status, 405);
    await post.text();
    const ambiguous = await get(base, '/api/schema');
    assert.equal(ambiguous.status, 400);
    assert.match((await ambiguous.json()).error, /Choose an application/);
    assert.equal(opened.mock.callCount(), 0);
  });
});

test('missing app bindings never fall back to an unrelated active source', { timeout: 5_000 }, async (t) => {
  const registry = new Registry();
  registry.add({ id: 'unrelated', name: 'Unrelated private database', url: '/private/operator/unrelated.db', source: 'config' });
  const opened = t.mock.method(registry, 'open', async () => {
    throw new Error('Unexpected database open');
  });
  await listening(registry, [app('missing')], async (base) => {
    const response = await get(base, '/api/runtime');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      appConfigured: true,
      active: 'fixture',
      apps: [{ id: 'fixture', name: 'Fixture app', writable: false }],
    });
    for (const [path, status] of [
      ['/api/schema', 503],
      ['/api/schema?conn=unrelated', 400],
    ] as const) {
      const schema = await get(base, path);
      assert.equal(schema.status, status, path);
      await schema.text();
    }
    assert.equal(opened.mock.callCount(), 0);
  });
});

test('empty standalone and app listeners can bootstrap without a database', { timeout: 5_000 }, async (t) => {
  for (const apps of [undefined, [app()]]) {
    const registry = new Registry();
    const opened = t.mock.method(registry, 'open', async () => {
      throw new Error('Unexpected database open');
    });
    await listening(registry, apps, async (base) => {
      const runtime = await get(base, '/api/runtime');
      assert.equal(runtime.status, 200);
      assert.deepEqual(
        await runtime.json(),
        apps
          ? { appConfigured: true, active: 'fixture', apps: [{ id: 'fixture', name: 'Fixture app', writable: false }] }
          : { appConfigured: false },
      );
      const schema = await get(base, '/api/schema');
      assert.equal(schema.status, apps ? 503 : 409);
      await schema.text();
      const connections = await get(base, '/api/connections');
      assert.equal(connections.status, apps ? 403 : 200);
      const metadata = await connections.json();
      if (!apps) assert.deepEqual(metadata.connections, []);
      assert.equal(opened.mock.callCount(), 0);
    });
  }
});

test('app connection management is denied for every method and subpath before opening a database', { timeout: 10_000 }, async (t) => {
  const registry = new Registry();
  registry.add({ id: 'bound', name: 'Bound database', url: '/missing/bound.db', source: 'config' });
  const before = registry.configs();
  const opened = t.mock.method(registry, 'open', async () => {
    throw new Error('Unexpected database open');
  });
  await listening(registry, [app('bound')], async (base) => {
    const suffixes = ['', '/', '/test', '/create', '/select', '/refresh', '/update', '/remove', '/save', '/demo', '/unknown'];
    for (const suffix of suffixes) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(`${base}/api/connections${suffix}?conn=bound`, {
          method,
          signal: AbortSignal.timeout(2_000),
          ...(!['GET', 'HEAD'].includes(method)
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: 'bound', name: 'Forbidden', url: '/missing/forbidden.db' }),
              }
            : {}),
        });
        assert.equal(response.status, 403, `${method} /api/connections${suffix}`);
        await response.text();
      }
    }
    assert.equal(opened.mock.callCount(), 0);
    assert.deepEqual(registry.configs(), before);
  });
});

test('bound schema remains available while unbound GET and POST requests never open a source', { timeout: 5_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-runtime-'));
  const path = join(directory, 'bound.db');
  const fixture = new DatabaseSync(path);
  fixture.exec('CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  fixture.close();
  try {
    const registry = new Registry();
    registry.add({ id: 'hidden', name: 'Hidden database', url: '/missing/hidden.db', source: 'config' });
    registry.add({ id: 'bound', name: 'Bound database', url: path, source: 'config' });
    const open = registry.open.bind(registry);
    const opened = t.mock.method(registry, 'open', async (id: string) => {
      assert.equal(id, 'bound');
      return open(id);
    });
    await listening(registry, [app('bound')], async (base) => {
      assert.equal(registry.active, 'hidden');
      const defaultSchema = await get(base, '/api/schema');
      assert.equal(defaultSchema.status, 200);
      assert.equal((await defaultSchema.json()).tables[0].name, 'task');
      const schema = await get(base, '/api/schema?app=fixture');
      assert.equal(schema.status, 200);
      assert.equal((await schema.json()).tables[0].name, 'task');
      const count = opened.mock.callCount();
      assert.ok(count > 0);
      for (const endpoint of ['/api/schema?conn=hidden', '/api/app?conn=hidden']) {
        const response = await get(base, endpoint);
        assert.equal(response.status, 400, endpoint);
        await response.text();
      }
      const response = await fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conn: 'hidden', q: 'task' }),
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(response.status, 400);
      await response.text();
      const missing = await get(base, '/api/schema?app=hidden');
      assert.equal(missing.status, 404);
      await missing.text();
      assert.equal(opened.mock.callCount(), count);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
