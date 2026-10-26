import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { assertAppScopes, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* The App's write scope as resource ceilings over the two resources its
   views show: `true` writes both, `false`
   reads both, a list writes exactly those. */
function ceilings(writable: boolean | string[]) {
  const declared = { incident: {}, 'inventory.incident': {} };
  // Deleting is opt-in per resource, whoever decides the writes.
  if (writable === true)
    return { resources: { incident: { access: 'write', delete: true }, 'inventory.incident': { access: 'write', delete: true } } };
  const names = writable === false ? ['incident', 'inventory.incident'] : writable;
  return {
    resources: {
      ...declared,
      ...Object.fromEntries(names.map((name) => [name, writable === false ? {} : { access: 'write', delete: true }])),
    },
  };
}

function app(writable: boolean | string[] = true): LoadedApp {
  return {
    path: '/private/operator/multisource/app.ts',
    app: parseAppConfig(
      {
        id: 'multisource',
        name: 'Multisource app',
        sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
        ...ceilings(writable),
        views: {
          incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
          'inventory-incidents': { kind: 'list', from: 'inventory.incident', label: 'Inventory incidents' },
        },
        home: 'incidents',
        nav: ['incidents', 'inventory-incidents'],
      },
      'multisource fixture',
    ),
    pages: [],
    sources: {},
  };
}

async function fixture(
  options: { opsWritable?: boolean; stockWritable?: boolean; appWritable?: boolean | string[]; failStock?: boolean },
  run: (base: string, databases: Record<'ops' | 'stock', DatabaseSync>, registry: Registry, host: AppHost) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-multisource-'));
  const databases = {
    ops: new DatabaseSync(join(directory, 'private-ops.db')),
    stock: new DatabaseSync(join(directory, 'private-stock.db')),
  };
  const registry = new Registry();
  let server: Server | undefined;
  try {
    for (const [id, db] of Object.entries(databases)) {
      db.exec("CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')");
      db.prepare('INSERT INTO incident (id, name) VALUES (1, ?)').run(`${id} original incident`);
      clearJournal(id);
    }
    // The active database deliberately differs from the app's entrypoint.
    registry.add({
      id: 'stock',
      name: 'Stock database',
      url: join(directory, 'private-stock.db'),
      writable: options.stockWritable !== false,
      source: 'config',
    });
    registry.add({
      id: 'ops',
      name: 'Operational database',
      url: join(directory, 'private-ops.db'),
      writable: options.opsWritable !== false,
      source: 'config',
    });
    if (options.failStock) {
      const open = registry.open.bind(registry);
      registry.open = async (id) => {
        if (id === 'stock') throw new Error(`private-secret-password at ${directory}/private-stock.db`);
        return open(id);
      };
    }
    const host: AppHost = { app: app(options.appWritable), pages: [] };
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, apps: [host], bound });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(`http://${bound.host}:${bound.port}`, databases, registry, host);
  } finally {
    if (server) {
      const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await registry.closeAll();
    for (const [id, db] of Object.entries(databases)) {
      db.close();
      clearJournal(id);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function request(base: string, path: string, body?: Record<string, unknown>, status = 200) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(3_000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(json)}`);
  return json;
}

function name(db: DatabaseSync, id = 1) {
  return db.prepare('SELECT name FROM incident WHERE id = ?').get(id)?.name;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('aborting while a secondary opens releases late leases and does not execute the write', { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases, registry) => {
    const pendingStock = signal();
    const resumeStock = signal();
    const opsAcquired = signal();
    const opsReleased = signal();
    const stockReleased = signal();
    const acquisitions: string[] = [];
    const releases: string[] = [];
    const dataCalls: string[] = [];
    const open = registry.open.bind(registry);
    registry.open = async (id) => {
      if (id === 'stock') {
        pendingStock.resolve();
        await resumeStock.promise;
      }
      const opened = await open(id);
      const query = opened.adapter.query.bind(opened.adapter);
      opened.adapter.query = async (...args) => {
        dataCalls.push(`${id}:query`);
        return query(...args);
      };
      const update = opened.adapter.update?.bind(opened.adapter);
      if (update)
        opened.adapter.update = async (...args) => {
          dataCalls.push(`${id}:update`);
          return update(...args);
        };
      return opened;
    };
    const lease = registry.lease.bind(registry);
    registry.lease = (id) => {
      const release = lease(id);
      acquisitions.push(id);
      if (id === 'ops') opsAcquired.resolve();
      return () => {
        releases.push(id);
        release();
        if (id === 'ops') opsReleased.resolve();
        if (id === 'stock') stockReleased.resolve();
      };
    };
    const controller = new AbortController();
    const aborted = assert.rejects(
      fetch(`${base}/api/update`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'multisource', table: 'inventory.incident', key: { id: 1 }, values: { name: 'must not write' } }),
      }),
      { name: 'AbortError' },
    );
    try {
      await Promise.all([pendingStock.promise, opsAcquired.promise]);
      controller.abort();
      await aborted;
      // Wait for the server to observe the disconnect before completing the slow open.
      await opsReleased.promise;
      resumeStock.resolve();
      await stockReleased.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(acquisitions.sort(), ['ops', 'stock']);
      assert.deepEqual(releases.sort(), ['ops', 'stock']);
      assert.deepEqual(dataCalls, []);
      assert.equal(name(databases.ops), 'ops original incident');
      assert.equal(name(databases.stock), 'stock original incident');
      assert.deepEqual(history('ops'), []);
      assert.deepEqual(history('stock'), []);
    } finally {
      controller.abort();
      resumeStock.resolve();
      await aborted;
    }
  });
});

test('secondary-only schema refresh invalidates the resolved app manifest cache', { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases, registry, host) => {
    host.app.app = parseAppConfig(
      {
        id: 'multisource',
        name: 'Multisource app',
        sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
        resources: { 'inventory.incident': {} },
        views: { 'inventory-incidents': { kind: 'list', from: 'inventory.incident', show: ['name', 'asset_tag'] } },
        home: 'inventory-incidents',
        nav: ['inventory-incidents'],
      },
      'secondary schema refresh fixture',
    );
    const primaryReadAt = (await registry.open('ops')).schema.readAt;
    const before = await request(base, '/api/app?app=multisource');
    assert.match(before.app.views['inventory-incidents'].error, /asset_tag/);
    databases.stock.exec('ALTER TABLE incident ADD COLUMN asset_tag TEXT');
    await registry.refresh('stock');
    assert.equal((await registry.open('ops')).schema.readAt, primaryReadAt);
    const after = await request(base, '/api/app?app=multisource');
    assert.equal(after.app.views['inventory-incidents'].error, undefined);
    assert.deepEqual(after.app.views['inventory-incidents'].show, ['name', 'asset_tag']);
  });
});

test(
  'one app entrypoint merges logical source schemas and concurrent reads never switch active connections',
  { timeout: 10_000 },
  async () => {
    await fixture({}, async (base, _databases, registry) => {
      assert.equal(registry.active, 'stock');
      const runtime = await request(base, '/api/runtime');
      assert.equal(runtime.active, 'multisource');
      assert.deepEqual(
        runtime.apps.map((app: { id: string }) => app.id),
        ['multisource'],
      );
      const schema = await request(base, '/api/schema?app=multisource');
      assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['incident', 'inventory.incident']);
      assert.doesNotMatch(JSON.stringify(schema), /private-ops|private-stock|private-secret|connectionString/);
      const manifest = await request(base, '/api/app?app=multisource');
      assert.deepEqual(
        Object.values(manifest.app.views).map((view) => (view as { table: string }).table),
        ['incident', 'inventory.incident'],
      );
      assert.ok(Object.values(manifest.app.views).every((view) => !(view as { error?: string }).error));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          request(base, '/api/run', {
            app: 'multisource',
            q: `${index % 2 ? 'inventory.incident' : 'incident'} show id, name`,
          }),
        ),
      );
      results.forEach((result, index) => {
        assert.deepEqual(result.errors, []);
        assert.equal(result.table, index % 2 ? 'inventory.incident' : 'incident');
        assert.deepEqual(result.rows, [{ id: 1, name: `${index % 2 ? 'stock' : 'ops'} original incident` }]);
      });
      assert.equal(registry.active, 'stock');
    });
  },
);

test("source-local updates reach each source's own physical table, and nothing is journaled", { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases) => {
    const operations = await request(base, '/api/update', {
      app: 'multisource',
      table: 'incident',
      key: { id: 1 },
      values: { name: 'ops updated' },
    });
    const inventory = await request(base, '/api/update', {
      app: 'multisource',
      table: 'inventory.incident',
      key: { id: 1 },
      values: { name: 'stock updated' },
    });
    assert.equal(operations.affected, 1);
    assert.equal(inventory.affected, 1);
    assert.equal(name(databases.ops), 'ops updated');
    assert.equal(name(databases.stock), 'stock updated');
    assert.deepEqual([history('ops'), history('stock')], [[], []]);
  });
});

test('inserts and deletes stay within the selected logical source', { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases) => {
    for (const [source, table, other] of [
      ['ops', 'incident', 'stock'],
      ['stock', 'inventory.incident', 'ops'],
    ] as const) {
      const id = source === 'ops' ? 98 : 99;
      const inserted = await request(base, '/api/insert', { app: 'multisource', table, values: { id, name: `${source} created` } });
      assert.deepEqual(inserted.key, { id });
      assert.equal(name(databases[source], id), `${source} created`);
      assert.equal(name(databases[other], id), undefined);
      const untouched = name(databases[other]);
      const deleted = await request(base, '/api/delete', { app: 'multisource', table, key: { id: 1 }, confirm: true });
      assert.equal(deleted.deleted, true);
      assert.equal(name(databases[source]), undefined);
      assert.equal(name(databases[other]), untouched);
    }
  });
});

test('a writable app entrypoint cannot override a read-only secondary database', { timeout: 10_000 }, async () => {
  await fixture({ stockWritable: false }, async (base, databases) => {
    const stock = await request(base, '/api/run', { app: 'multisource', q: 'inventory.incident show name' });
    assert.deepEqual(stock.rows, [{ name: 'stock original incident' }]);
    for (const [path, body] of [
      ['/api/update', { key: { id: 1 }, values: { name: 'forbidden' } }],
      ['/api/insert', { values: { id: 99, name: 'forbidden' } }],
      ['/api/delete', { key: { id: 1 }, confirm: true }],
    ] as const) {
      await request(base, path, { app: 'multisource', table: 'inventory.incident', ...body }, 403);
    }
    const own = await request(base, '/api/update', { app: 'multisource', table: 'incident', key: { id: 1 }, values: { name: 'allowed' } });
    assert.equal(own.affected, 1);
    assert.equal(name(databases.ops), 'allowed');
    assert.equal(name(databases.stock), 'stock original incident');
    assert.equal(name(databases.stock, 99), undefined);
    assert.deepEqual(history('stock'), []);
  });
});

test('forged client permissions and source labels cannot enable writes to a read-only source', { timeout: 10_000 }, async () => {
  await fixture({ stockWritable: false }, async (base, databases) => {
    const manifest = await request(base, '/api/app?app=multisource');
    assert.deepEqual(manifest.app.writableTables, ['incident']);
    for (const source of ['operations', 'inventory']) {
      await request(
        base,
        '/api/update',
        {
          app: 'multisource',
          table: 'inventory.incident',
          key: { id: 1 },
          values: { name: 'forged write' },
          source,
          connection: 'ops',
          writable: true,
          role: 'admin',
          permissions: { writable: true, update: true },
        },
        403,
      );
    }
    await request(
      base,
      '/api/update',
      {
        app: { writable: true },
        table: 'inventory.incident',
        key: { id: 1 },
        values: { name: 'forged identity' },
      },
      400,
    );
    assert.equal(name(databases.stock), 'stock original incident');
    assert.equal(name(databases.ops), 'ops original incident');
    assert.deepEqual(history('stock'), []);
    assert.deepEqual(history('ops'), []);
  });
});

test('a read-only default source does not disable writable secondary resources', { timeout: 10_000 }, async () => {
  await fixture({ opsWritable: false }, async (base, databases) => {
    const runtime = await request(base, '/api/runtime');
    assert.equal(runtime.apps.find((app: { id: string }) => app.id === 'multisource').writable, true);
    const manifest = await request(base, '/api/app?app=multisource');
    assert.deepEqual(manifest.app.writableTables, ['inventory.incident']);
    await request(
      base,
      '/api/update',
      {
        app: 'multisource',
        table: 'incident',
        key: { id: 1 },
        values: { name: 'forbidden' },
        writable: true,
      },
      403,
    );
    const updated = await request(base, '/api/update', {
      app: 'multisource',
      table: 'inventory.incident',
      key: { id: 1 },
      values: { name: 'stock allowed' },
    });
    assert.equal(updated.affected, 1);
    assert.equal(name(databases.stock), 'stock allowed');
    assert.equal(name(databases.ops), 'ops original incident');
  });
});

test('application write scope is enforced on the server even when both databases are writable', { timeout: 10_000 }, async () => {
  await fixture({ appWritable: ['incident'] }, async (base, databases) => {
    const manifest = await request(base, '/api/app?app=multisource');
    assert.deepEqual(manifest.app.writableTables, ['incident']);
    await request(
      base,
      '/api/update',
      {
        app: 'multisource',
        table: 'inventory.incident',
        key: { id: 1 },
        values: { name: 'outside app scope' },
        writable: ['inventory.incident'],
        permissions: { writable: true },
      },
      403,
    );
    const allowed = await request(base, '/api/update', {
      app: 'multisource',
      table: 'incident',
      key: { id: 1 },
      values: { name: 'within app scope' },
    });
    assert.equal(allowed.affected, 1);
    assert.equal(name(databases.ops), 'within app scope');
    assert.equal(name(databases.stock), 'stock original incident');
    assert.deepEqual(history('stock'), []);
  });
});

test('a secondary physical connection is never an app request entrypoint', { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases, registry) => {
    for (const path of ['/api/schema?conn=stock', '/api/app?conn=stock']) await request(base, path, undefined, 400);
    await request(base, '/api/run', { conn: 'stock', q: 'incident' }, 400);
    await request(base, '/api/update', { conn: 'stock', table: 'incident', key: { id: 1 }, values: { name: 'forbidden' } }, 400);
    await request(base, '/api/run', { app: 'stock', q: 'incident' }, 404);
    assert.equal(name(databases.stock), 'stock original incident');
    assert.equal(name(databases.ops), 'ops original incident');
    assert.equal(registry.active, 'stock');
  });
});

test('an unavailable secondary catalog fails explicitly instead of falling back to the default database', { timeout: 10_000 }, async () => {
  await fixture({ failStock: true }, async (base, databases) => {
    for (const [path, body] of [
      ['/api/schema?app=multisource', undefined],
      ['/api/run', { app: 'multisource', q: 'inventory.incident' }],
      ['/api/update', { app: 'multisource', table: 'inventory.incident', key: { id: 1 }, values: { name: 'forbidden' } }],
    ] as const) {
      const result = await request(base, path, body, 503);
      assert.equal(result.error, 'Application data source "inventory" is unavailable.');
      assert.doesNotMatch(JSON.stringify(result), /private|password|secret|private-stock/);
    }
    assert.equal(name(databases.ops), 'ops original incident');
    assert.equal(name(databases.stock), 'stock original incident');
  });
});

test('source bindings that use both ID and name for one physical connection are rejected', () => {
  const loaded = app();
  loaded.app = parseAppConfig(
    {
      name: 'Duplicate source app',
      sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'Operational database' } },
      resources: { incident: {} },
      views: { incidents: { kind: 'list', from: 'incident' } },
      home: 'incidents',
    },
    'duplicate fixture',
  );
  assert.throws(
    () => assertAppScopes([loaded], (reference) => (reference === 'Operational database' ? 'ops' : reference)),
    /source|connection/i,
  );
});

test('a secondary resource alias reload keeps writing the original physical table', { timeout: 10_000 }, async () => {
  await fixture({}, async (base, databases, _registry, host) => {
    const updated = await request(base, '/api/update', {
      app: 'multisource',
      table: 'inventory.incident',
      key: { id: 1 },
      values: { name: 'stock before alias reload' },
    });
    assert.equal(updated.affected, 1);
    host.app.app = parseAppConfig(
      {
        id: 'multisource',
        name: 'Multisource app',
        sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
        resources: { incident: { access: 'write' }, 'inventory.asset': { physical: 'incident', access: 'write' } },
        views: { incidents: { kind: 'list', from: 'incident' }, assets: { kind: 'list', from: 'inventory.asset' } },
        home: 'incidents',
        nav: ['incidents', 'assets'],
      },
      'reloaded fixture',
    );
    const schema = await request(base, '/api/schema?app=multisource');
    assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['incident', 'inventory.asset']);
    const manifest = await request(base, '/api/app?app=multisource');
    assert.deepEqual(
      Object.values(manifest.app.views).map((view) => (view as { table: string }).table),
      ['incident', 'inventory.asset'],
    );
    const saved = await request(base, '/api/update', {
      app: 'multisource',
      table: 'inventory.asset',
      key: { id: 1 },
      values: { name: 'stock after alias reload' },
    });
    assert.equal(saved.affected, 1);
    assert.equal(name(databases.stock), 'stock after alias reload');
    assert.equal(name(databases.ops), 'ops original incident');
  });
});
