/**
 * A source per schema (`sources.<name>.schema`), `resources` on a source, and
 * names that stay put when a source goes. The parse and SQLite halves run
 * everywhere; the per-schema halves need PostgreSQL (TABLEWALK_TEST_PG), in a
 * database this file owns.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl, type Control } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';

const ROOT = new URL('..', import.meta.url).pathname;
const list = (table: string) => ({ kind: 'list', from: table });
const parse = (config: Record<string, unknown>) => parseAppConfig({ id: 'desk', name: 'Desk', ...config }, 'app.ts');

test('several sources may share a connection, each seeing a schema of its own', () => {
  const app = parse({
    sources: { ops: { connection: 'main', schema: 'ops', default: true }, catalog: { connection: 'main', schema: 'catalog' } },
    resources: { stock_move: {}, 'catalog.product': {} },
    views: { moves: list('stock_move'), products: list('catalog.product') },
    home: 'moves',
  });
  assert.deepEqual(app.sources, {
    ops: { connection: 'main', default: true, schema: 'ops' },
    catalog: { connection: 'main', default: false, schema: 'catalog' },
  });
  assert.equal(app.connection, 'main');
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ a: { connection: 'main', schema: 'ops' }, b: { connection: 'main', schema: 'ops' } }, /repeats connection "main" and schema "ops"/],
    [{ a: { connection: 'main' }, b: { connection: 'main', schema: 'ops' } }, /each of them needs a "schema" of its own/],
    [{ a: { connection: 'main', schema: 'ops' }, b: { connection: 'main' } }, /each of them needs a "schema" of its own/],
    [{ a: { connection: 'main', schema: '' } }, /"schema" that is not a schema name/],
    [{ a: { connection: 'main', schema: 'ops.x' } }, /"schema" that is not a schema name/],
    [
      { a: { connection: 'main', schema: 'ops', default: true }, p: { connection: 'main', schema: 'people', realm: 'platform' } },
      /"realm": "platform" and shares connection "main"/,
    ],
  ];
  for (const [sources, message] of refused) assert.throws(() => parse({ sources, views: {} }), message);
});

test('a source brings in its tables by list or all of them, granting nothing', () => {
  const listed = parse({
    sources: { ops: { connection: 'ops', default: true }, stock: { connection: 'stock', resources: ['incident', 'bin'] } },
    resources: { incident: {}, 'stock.bin': {} },
    views: { stock: list('stock.incident'), bins: list('stock.bin'), incidents: list('incident') },
    home: 'incidents',
  });
  // An implicit block is exactly `{}`; a written one keeps what it says.
  assert.deepEqual(listed.resources!['stock.incident'], { source: 'stock' });
  assert.deepEqual(listed.resources!['stock.bin'], { source: 'stock' });
  assert.throws(
    () =>
      parse({
        sources: { ops: { connection: 'ops', default: true }, stock: { connection: 'stock', resources: ['incident'] } },
        views: { bins: list('stock.bin') },
        home: 'bins',
      }),
    /names "stock\.bin", which no resource block declares.*its source's "resources"/,
  );
  const all = parse({
    sources: { ops: { connection: 'ops', default: true, resources: 'all' }, stock: { connection: 'stock', resources: 'all' } },
    views: { stock: list('stock.anything'), mine: list('whatever') },
    home: 'mine',
  });
  // Each table a view names is declared by naming it; which exist is the catalog's to say.
  assert.deepEqual(all.resources, { 'stock.anything': { source: 'stock' }, whatever: { source: 'ops' } });
  for (const resources of [[], 'some', ['a', 'a'], ['a.b'], [1]]) {
    assert.throws(() => parse({ sources: { ops: { connection: 'ops', resources } }, views: {} }), /"resources"/);
  }
  assert.throws(
    () =>
      parse({
        sources: { ops: { connection: 'ops', default: true }, p: { connection: 'people', realm: 'platform', resources: 'all' } },
        views: {},
      }),
    /"realm": "platform", so each of its resources is a block of its own/,
  );
  // What a source brings in is a reviewed fact, like any grant.
  const lock = authorityReport(
    parse({
      sources: {
        ops: { connection: 'main', schema: 'ops', default: true, resources: ['stock_move', 'bin'] },
        catalog: { connection: 'main', schema: 'catalog', resources: 'all' },
      },
      views: { moves: list('stock_move') },
      home: 'moves',
    }),
  );
  for (const line of [
    'source catalog schema "catalog"',
    'source catalog resources all',
    'source ops resources bin, stock_move',
    'source ops schema "ops"',
  ]) {
    assert.ok(
      lock.split('\n').some((fact) => fact.startsWith(`${line} — `)),
      `${line} in:\n${lock}`,
    );
  }
});

/** Two SQLite files, an App over both, served; the sources' shapes are the test's to choose. */
async function serveSqlite(
  sources: Record<string, unknown>,
  rest: Record<string, unknown>,
  run: (base: string, dbs: Record<'ops' | 'stock', DatabaseSync>, registry: Registry) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-source-names-'));
  const dbs = { ops: new DatabaseSync(join(directory, 'ops.db')), stock: new DatabaseSync(join(directory, 'stock.db')) };
  const registry = new Registry();
  let server: Server | undefined;
  try {
    for (const [id, db] of Object.entries(dbs)) {
      db.exec(`CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, logged_on TEXT);
        INSERT INTO incident VALUES (1, '${id} incident', '2026-03-04')`);
      clearJournal(id);
      registry.add({ id, name: id, url: join(directory, `${id}.db`), writable: true, source: 'config' });
    }
    const app = parseAppConfig({ id: 'desk', name: 'Desk', sources, ...rest }, 'app.ts');
    server = createApp({
      registry,
      apps: [{ app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} }, pages: [] } as AppHost],
      bound: { host: '127.0.0.1', port: 0 },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`, dbs, registry);
  } finally {
    if (server) {
      const closed = new Promise((resolve) => server!.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await registry.closeAll();
    for (const [id, db] of Object.entries(dbs)) {
      db.close();
      clearJournal(id);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function call(base: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5_000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

test("without a default, every source keeps its qualified names, and the first is the App's home", { timeout: 20_000 }, async () => {
  await serveSqlite(
    { ops: { connection: 'ops' }, stock: { connection: 'stock' } },
    {
      resources: { 'ops.incident': {}, 'stock.incident': { access: 'write' } },
      views: { ops: list('ops.incident'), stock: list('stock.incident') },
      home: 'ops',
    },
    async (base, dbs) => {
      const schema = await call(base, '/api/schema?app=desk');
      assert.deepEqual(schema.json.tables.map((table: { id: string }) => table.id).sort(), ['ops.incident', 'stock.incident']);
      const updated = await call(base, '/api/update', { app: 'desk', table: 'stock.incident', key: { id: 1 }, values: { name: 'moved' } });
      assert.equal(updated.status, 200, JSON.stringify(updated.json));
      assert.equal(dbs.stock.prepare('SELECT name FROM incident').get()!.name, 'moved');
      assert.equal(dbs.ops.prepare('SELECT name FROM incident').get()!.name, 'ops incident');
    },
  );
  // The same App with its other source gone: the names it kept are the names it has.
  await serveSqlite(
    { stock: { connection: 'stock', default: false } },
    { resources: { 'stock.incident': {} }, views: { stock: list('stock.incident') }, home: 'stock' },
    async (base) => {
      const run = await call(base, '/api/run', { app: 'desk', q: 'stock.incident show id, name' });
      assert.deepEqual(run.json.rows, [{ id: 1, name: 'stock incident' }]);
    },
  );
});

test('declared dates ride with their own source through a shared runtime', { timeout: 20_000 }, async () => {
  await serveSqlite(
    { ops: { connection: 'ops' }, stock: { connection: 'stock' } },
    {
      resources: { 'ops.incident': {}, 'stock.incident': { types: { logged_on: 'date' } } },
      views: { ops: list('ops.incident'), stock: list('stock.incident') },
      home: 'ops',
    },
    async (base) => {
      const schema = await call(base, '/api/schema?app=desk');
      const type = (id: string) =>
        schema.json.tables
          .find((table: { id: string }) => table.id === id)
          .columns.find((column: { name: string }) => column.name === 'logged_on').type as string;
      assert.match(type('stock.incident'), / as date$/);
      assert.doesNotMatch(type('ops.incident'), / as date/);
      const grouped = await call(base, '/api/breakdown', {
        app: 'desk',
        def: { base: 'stock.incident', by: [{ path: 'logged_on', bucket: 'month' }], measures: [{ fn: 'count' }] },
      });
      assert.equal(grouped.status, 200, JSON.stringify(grouped.json));
      assert.equal(grouped.json.rows.length, 1, JSON.stringify(grouped.json));
    },
  );
});

test('a source that brings in every table serves one no block names; SQLite has no schema to choose', { timeout: 20_000 }, async () => {
  await serveSqlite(
    { ops: { connection: 'ops', default: true }, stock: { connection: 'stock', resources: 'all' } },
    { resources: { incident: {} }, views: { mine: list('incident'), theirs: list('stock.incident') }, home: 'mine' },
    async (base, _dbs, registry) => {
      const manifest = await call(base, '/api/app?app=desk');
      assert.equal(manifest.json.app.views.theirs.error, undefined);
      const run = await call(base, '/api/run', { app: 'desk', q: 'stock.incident show name' });
      assert.deepEqual(run.json.rows, [{ name: 'stock incident' }]);
      const scoped = parseAppConfig(
        {
          id: 'x',
          name: 'X',
          sources: { ops: { connection: 'ops', schema: 'main' } },
          resources: { incident: {} },
          views: { mine: list('incident') },
          home: 'mine',
        },
        'x.ts',
      );
      await assert.rejects(loadAppRuntimeResources(registry, scoped, 'ops'), /SQLite, which has no schemas/);
    },
  );
});

describe('a source per PostgreSQL schema', { skip: liveSkip('postgres', LIVE_PG) }, () => {
  let url: string;
  let control: Control;
  before(async () => {
    url = await ownedPostgresDatabase();
    control = await pgControl(url);
    await control.query(`
      CREATE SCHEMA ops; CREATE SCHEMA catalog; CREATE SCHEMA secret;
      CREATE TABLE secret.credential (id int PRIMARY KEY, token text NOT NULL);
      CREATE TABLE catalog.product (id int PRIMARY KEY, name text NOT NULL);
      CREATE TABLE catalog.partner (id int PRIMARY KEY, name text NOT NULL);
      CREATE TABLE ops.partner (id int PRIMARY KEY, name text NOT NULL);
      CREATE TABLE ops.stock_move (id int PRIMARY KEY, qty int NOT NULL, product_id int REFERENCES catalog.product(id),
        credential_id int REFERENCES secret.credential(id));
      INSERT INTO secret.credential VALUES (1, 'hunter2-token');
      INSERT INTO catalog.product VALUES (1, 'Bolt'); INSERT INTO catalog.partner VALUES (1, 'Catalog partner');
      INSERT INTO ops.partner VALUES (1, 'Ops partner'); INSERT INTO ops.stock_move VALUES (1, 5, 1, 1);
      CREATE TABLE catalog.sku (code text PRIMARY KEY, label text NOT NULL);
      CREATE TABLE ops.pick (id int PRIMARY KEY, sku_code text);
      INSERT INTO catalog.sku VALUES ('B-1', 'Bolt, boxed'), ('N-2', 'Nut');
      INSERT INTO ops.pick VALUES (1, 'B-1'), (2, 'N-2'), (3, 'GONE');`);
  });
  after(async () => {
    await control?.end();
  });

  /* catalog's `resources: 'all'` declares the tables a view names there, and
     no more: catalog.partner is served because a view shows it, and
     catalog.sku (named by no view) is not. */
  const deskApp = (extra: Record<string, unknown> = {}): AppDef =>
    parseAppConfig(
      {
        id: 'desk',
        name: 'Desk',
        sources: {
          ops: { connection: 'main', schema: 'ops', default: true },
          catalog: { connection: 'main', schema: 'catalog', resources: 'all' },
        },
        resources: { stock_move: {}, partner: {} },
        views: { moves: list('stock_move'), products: list('catalog.product'), partners: list('catalog.partner') },
        home: 'moves',
        ...extra,
      },
      'app.ts',
    );

  async function servePg(app: AppDef, run: (base: string, registry: Registry) => Promise<void>, schemas?: string[]) {
    const registry = new Registry();
    registry.add({ id: 'main', name: 'main', url, writable: true, source: 'config', ...(schemas ? { schemas } : {}) });
    clearJournal('main');
    const server = createApp({
      registry,
      apps: [{ app: { path: '/private/desk/app.ts', app, pages: [], sources: {} }, pages: [] } as AppHost],
      bound: { host: '127.0.0.1', port: 0 },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, registry);
    } finally {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal('main');
    }
  }
  const value = async (sql: string) => (await control.query(sql)).rows[0] as Record<string, unknown>;

  test(
    'one connection, two schemas: each source sees its own, names do not collide, and a key between them joins',
    { timeout: 30_000 },
    async () => {
      await servePg(deskApp(), async (base, registry) => {
        const schema = await call(base, '/api/schema?app=desk');
        assert.deepEqual(schema.json.tables.map((table: { id: string }) => table.id).sort(), [
          'catalog.partner',
          'catalog.product',
          'partner',
          'stock_move',
        ]);
        // The key out to a schema no source sees is not there at all.
        assert.doesNotMatch(JSON.stringify(schema.json), /secret|hunter2|"token"/);
        assert.deepEqual(
          schema.json.foreignKeys.map((fk: { from: { table: string }; to: { table: string } }) => `${fk.from.table}->${fk.to.table}`),
          ['stock_move->catalog.product'],
        );
        // The key from ops into catalog is one database's: it joins in SQL.
        const joined = await call(base, '/api/run', { app: 'desk', q: 'stock_move show id, product_id.name' });
        assert.deepEqual(joined.json.errors, []);
        assert.deepEqual(
          joined.json.rows.map((row: Record<string, unknown>) => Object.values(row)),
          [[1, 'Bolt']],
        );
        // Opened once, however many sources share it.
        assert.equal(registry.list().length, 1);
      });
    },
  );

  test(
    'a declared reference from one schema to another on the same connection joins in SQL, filters and sorts',
    { timeout: 30_000 },
    async () => {
      await servePg(
        deskApp({ resources: { stock_move: {}, partner: {}, pick: { references: { sku_code: { to: 'catalog.sku' } } } } }),
        async (base) => {
          const schema = await call(base, '/api/schema?app=desk');
          const edge = schema.json.foreignKeys.find((fk: { declared?: boolean }) => fk.declared);
          assert.equal(edge.to.table, 'catalog.sku');
          assert.equal(edge.stitched, undefined, 'one connection: joined, not stitched');
          const joined = await call(base, '/api/run', {
            app: 'desk',
            q: 'pick sku_code.label startsWith Bolt show id, sku_code.label sort sku_code.label',
          });
          assert.deepEqual(joined.json.errors, []);
          assert.deepEqual(joined.json.rows, [{ id: 1, 'sku_code.label': 'Bolt, boxed' }]);
        },
      );
    },
  );

  test("a source scoped to a schema never reads another schema's tables, by name, binding or path", { timeout: 30_000 }, async () => {
    await servePg(deskApp(), async (base) => {
      for (const table of ['credential', 'secret.credential', 'catalog.credential', 'ops.credential']) {
        const read = await call(base, '/api/query', { app: 'desk', table, limit: 10 });
        assert.doesNotMatch(JSON.stringify(read.json), /hunter2/, table);
        assert.notEqual(read.status, 200, `${table}: ${JSON.stringify(read.json)}`);
      }
      /* The engine resolves a structured view's paths against its whole
         connection, where the key to secret.credential is real: a filter or
         a count through it would be an oracle even with no row returned. So
         the refusal comes before any statement is sent, and it is the one a
         column with no key at all gets: the App's catalog has no such key,
         and an answer that said the key led somewhere else would say that
         it exists. */
      const structured = (column: string) => {
        const token = [[{ path: `${column}.token`, op: 'startsWith', value: 'hunter' }]];
        return Promise.all([
          call(base, '/api/view/run', {
            app: 'desk',
            view: { base: 'stock_move', columns: [{ path: 'id' }, { path: `${column}.token` }] },
          }),
          call(base, '/api/view/run', {
            app: 'desk',
            count: 'exact',
            view: { base: 'stock_move', columns: [{ path: 'id' }], filter: { groups: token } },
          }),
          call(base, '/api/breakdown', {
            app: 'desk',
            def: { base: 'stock_move', by: [{ path: `${column}.token` }], measures: [{ fn: 'count' }] },
          }),
          call(base, '/api/breakdown', {
            app: 'desk',
            def: { base: 'stock_move', by: [{ path: 'qty' }], measures: [{ fn: 'count' }], filter: { groups: token } },
          }),
        ]);
      };
      const [outward, keyless] = [await structured('credential_id'), await structured('qty')];
      outward.forEach((reply, index) => {
        assert.doesNotMatch(JSON.stringify(reply.json), /hunter2/);
        assert.ok(reply.json.errors?.length, JSON.stringify(reply.json));
        assert.equal(reply.status, keyless[index].status);
        assert.equal(JSON.stringify(reply.json), JSON.stringify(keyless[index].json).replaceAll('qty', 'credential_id'));
      });
      // Text is parsed against the App's own catalog, which has no such key.
      const text = await call(base, '/api/run', { app: 'desk', q: 'stock_move show credential_id.token' });
      assert.ok(text.json.errors?.length);
      assert.doesNotMatch(JSON.stringify(text.json), /hunter2/);
    });
    // A physical binding cannot reach out of the source's schema either.
    await servePg(deskApp({ resources: { stock_move: {}, cred: { physical: 'secret.credential' } } }), async (base) => {
      const manifest = await call(base, '/api/app?app=desk');
      assert.doesNotMatch(JSON.stringify(manifest.json), /hunter2/);
      const read = await call(base, '/api/query', { app: 'desk', table: 'cred', limit: 10 });
      assert.notEqual(read.status, 200);
      assert.doesNotMatch(JSON.stringify(read.json), /hunter2/);
    });
  });

  test('writes land in the schema their source names', { timeout: 30_000 }, async () => {
    // Writing is opt-in per resource: both partners say so, and no credential does.
    await servePg(
      deskApp({ resources: { stock_move: {}, partner: { access: 'write' }, 'catalog.partner': { access: 'write' } } }),
      async (base) => {
        const ops = await call(base, '/api/update', { app: 'desk', table: 'partner', key: { id: 1 }, values: { name: 'Ops renamed' } });
        const catalog = await call(base, '/api/update', {
          app: 'desk',
          table: 'catalog.partner',
          key: { id: 1 },
          values: { name: 'Catalog renamed' },
        });
        assert.equal(ops.status, 200, JSON.stringify(ops.json));
        assert.equal(catalog.status, 200, JSON.stringify(catalog.json));
        assert.equal((await value('SELECT name FROM ops.partner')).name, 'Ops renamed');
        assert.equal((await value('SELECT name FROM catalog.partner')).name, 'Catalog renamed');
        for (const secret of ['credential', 'secret.credential', 'catalog.credential']) {
          const refused = await call(base, '/api/update', { app: 'desk', table: secret, key: { id: 1 }, values: { token: 'stolen' } });
          assert.notEqual(refused.status, 200, secret);
          const inserted = await call(base, '/api/insert', { app: 'desk', table: secret, values: { id: 2, token: 'planted' } });
          assert.notEqual(inserted.status, 200, secret);
        }
        assert.deepEqual((await control.query('SELECT id, token FROM secret.credential')).rows, [{ id: 1, token: 'hunter2-token' }]);
      },
    );
  });

  test('two schemas on one connection are one transaction, attested, and it cannot reach a third', { timeout: 30_000 }, async () => {
    const registry = new Registry();
    registry.add({ id: 'main', name: 'main', url, writable: true, source: 'config' });
    try {
      const resources = await loadAppRuntimeResources(registry, deskApp(), 'main');
      assert.deepEqual(resources.connections, ['main']);
      assert.deepEqual(['partner', 'catalog.partner'].map(resources.connectionFor), ['main', 'main']);
      assert.equal(resources.toLogicalAt('catalog.partner', 'main'), 'catalog.partner');
      assert.equal(resources.toLogicalAt('ops.partner', 'main'), 'partner');
      assert.throws(() => resources.toLogicalAt('secret.credential', 'main'), /Unknown table/);
      const every = { groups: [[{ column: 'id', op: '>=' as const, value: 1 }]] };
      const writer = resources.forConnection('main');
      const beforeOps = (await value('SELECT name FROM ops.partner')).name;
      const beforeCatalog = (await value('SELECT name FROM catalog.partner')).name;
      const rolledBack = new Error('roll back');
      await assert.rejects(
        writer.scopeTransaction!({ partner: every, 'catalog.partner': every }, async (tx, evidence) => {
          // The evidence is the App's reach: the key out to secret is not in it, the key into catalog is.
          assert.ok(!evidence.tables.some((table) => /credential/.test(table.id)));
          assert.ok(evidence.foreignKeys.some((fk) => fk.from.table === 'stock_move' && fk.to.table === 'catalog.product'));
          await tx.update({ table: 'partner', key: { id: 1 }, values: { name: 'Both' } });
          await tx.update({ table: 'catalog.partner', key: { id: 1 }, values: { name: 'Both' } });
          throw rolledBack;
        }),
        (error) => error === rolledBack || (error as { cause?: unknown }).cause === rolledBack,
      );
      // A table outside every source has no name here, and the refusal takes the transaction's earlier writes with it.
      await assert.rejects(
        writer.scopeTransaction!({ partner: every }, async (tx) => {
          await tx.update({ table: 'partner', key: { id: 1 }, values: { name: 'Both' } });
          await tx.update({ table: 'secret.credential', key: { id: 1 }, values: { token: 'stolen' } }).catch(() => {});
        }),
        /Unknown app resource "secret\.credential"/,
      );
      assert.equal((await value('SELECT name FROM ops.partner')).name, beforeOps);
      assert.equal((await value('SELECT name FROM catalog.partner')).name, beforeCatalog);
      await writer.scopeTransaction!({ partner: every, 'catalog.partner': every }, async (tx) => {
        await tx.update({ table: 'partner', key: { id: 1 }, values: { name: 'Committed' } });
        await tx.update({ table: 'catalog.partner', key: { id: 1 }, values: { name: 'Committed' } });
      });
      assert.equal((await value('SELECT name FROM ops.partner')).name, 'Committed');
      assert.equal((await value('SELECT name FROM catalog.partner')).name, 'Committed');
      await control.query(`UPDATE ops.partner SET name = 'Ops partner'; UPDATE catalog.partner SET name = 'Catalog partner'`);
      assert.deepEqual((await control.query('SELECT token FROM secret.credential')).rows, [{ token: 'hunter2-token' }]);
    } finally {
      await registry.closeAll();
    }
  });

  test('a schema the connection does not read is refused with the line that adds it', { timeout: 30_000 }, async () => {
    await servePg(
      deskApp(),
      async (_base, registry) => {
        await assert.rejects(
          loadAppRuntimeResources(registry, deskApp(), 'main'),
          /schema "catalog", which connection "main" does not read\. Add "catalog" to its "schemas"/,
        );
      },
      ['ops'],
    );
  });

  test(
    '--scaffold-app over one database with several schemas drafts a source per schema on that one connection',
    { timeout: 120_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scaffold-schemas-'));
      try {
        const config = join(directory, 'mistri.json');
        writeFileSync(config, JSON.stringify({ connections: [{ name: 'main', url }] }));
        const project = join(directory, 'desk');
        const run = (args: string[]) =>
          spawnSync(
            process.execPath,
            ['--import', import.meta.resolve('tsx'), join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
            {
              cwd: ROOT,
              encoding: 'utf8',
              timeout: 90_000,
              env: { ...process.env, NO_COLOR: '1' },
            },
          );
        const out = run(['--config', config, '--scaffold-app', project]);
        assert.equal(out.status, 0, out.stderr);
        const app = readFileSync(join(project, 'app.ts'), 'utf8');
        for (const schema of ['catalog', 'ops', 'secret'])
          assert.match(app, new RegExp(`${schema}: \\{ connection: 'main', schema: '${schema}'`));
        assert.doesNotMatch(readFileSync(config, 'utf8'), /catalog|ops/);
        // npm install stood in for by a link to this checkout, as the scaffold's own test does.
        mkdirSync(join(project, 'node_modules'));
        mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
        symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
        const check = run(['check', '--app', project, '--config', config]);
        assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
