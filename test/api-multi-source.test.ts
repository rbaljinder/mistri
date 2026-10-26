/**
 * An App API over two sources on two connections: each request reads or
 * commits on the one connection its operation was fixed to when the catalog
 * was checked, every other connection refuses inside that request, and the
 * documents say so (`x-mistri-source`, `x-mistri-consistency`) — for an
 * App of several sources only; a one-source App's are unchanged
 * (api-single-source-golden.test.ts). SQLite here; the same on PostgreSQL,
 * in databases of its own, under TABLEWALK_TEST_PG.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, int } from '../packages/mistri/src/server/commands/commandShapes.js';
import { laneResources } from '../packages/mistri/src/server/api/apiSourceLanes.js';
import { checkApiCommandCatalog } from '../packages/mistri/src/server/api/apiCommandCatalog.js';
import { appSourceConnections } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { apiOwnerFixture, bodyOf, commandOwner, readOwner, type Engine } from './support/apiOwnerFixture.js';
import { pgClient } from './support/tenantDialects.js';
import { liveSkip } from './live.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

const SALES = `CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
   CREATE TABLE invoice(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), total INTEGER NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
   INSERT INTO customer(id,name) VALUES (1,'Acme'),(2,'Brill');
   INSERT INTO invoice(id,customer_id,total,status) VALUES (1,1,50,'open'),(2,2,150,'open');`;
const STOCK = `CREATE TABLE item(id INTEGER PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);
   INSERT INTO item(id,sku,qty) VALUES (1,'LNT-01',5),(2,'STV-02',0),(3,'VLT-07',2);`;

const twoBooks = (store: string) => ({
  id: 'twobooks',
  name: 'Two books',
  sources: { sales: { connection: 'sales', default: true }, stock: { connection: 'stock' } },
  resources: { customer: {}, invoice: { access: 'write' }, 'stock.item': { access: 'write' } },
  views: {
    invoices: { kind: 'list', from: 'invoice', sort: 'id asc' },
    items: { kind: 'list', from: 'stock.item', sort: 'id asc' },
  },
  home: 'invoices',
  auth: { store, roles: { clerk: { read: true, commands: ['settle', 'restock'] }, reader: { read: true } } },
  api: {
    version: 1,
    roles: ['clerk', 'reader'],
    resources: {
      customer: { fields: ['id', 'name'], sorts: ['id', 'name'] },
      invoice: { fields: ['id', 'customer_id', 'customer_id.name', 'total', 'status'], filters: ['status'], sorts: ['id'] },
      'stock.item': { fields: ['id', 'sku', 'qty'], sorts: ['id'] },
    },
    views: ['items'],
    commands: [
      { id: 'settle', version: 1, target: 'invoice', input: {} },
      { id: 'restock', version: 1, target: 'stock.item', input: {} },
    ],
    events: ['item.restocked'],
  },
});

const restocked = defineEvent('item.restocked', shape({ id: int() }));
const commands = () =>
  defineCommands({
    settle: defineCommand({
      source: 'sales',
      target: 'invoice',
      input: {},
      output: shape({ id: int() }),
      async handle(context) {
        const id = Number(context.record.id);
        await context.tx.update({ table: 'invoice', key: { id }, values: { status: 'paid', version: Number(context.record.version) + 1 } });
        return { id };
      },
    }),
    restock: defineCommand({
      source: 'stock',
      target: 'item',
      input: {},
      output: shape({ id: int() }),
      events: { restocked: defineEventProjection(restocked, (output: { id: number }) => ({ id: output.id })) },
      async handle(context) {
        const id = Number(context.record.id);
        await context.tx.update({
          table: 'item',
          key: { id },
          values: { qty: Number(context.record.qty) + 10, version: Number(context.record.version) + 1 },
        });
        return { id };
      },
    }),
  });

async function twoBooksFixture(t: TestContext, engine: Engine) {
  const f = await apiOwnerFixture(t, {
    engine,
    app: twoBooks,
    connections: {
      sales: { sql: SALES, writable: true, journal: true },
      stock: { sql: STOCK, writable: true, events: { sourceId: 'stock' } },
    },
    commands: commands(),
    events: { sourceId: 'stock' },
    accounts: { clerk: 'clerk', reader: 'reader' },
  });
  return { f, clerk: await f.issue('clerk', ['clerk']), reader: await f.issue('reader', ['reader']) };
}

/** One statement on a test's own business database, outside the API. */
async function exec(engine: Engine, url: string, sql: string): Promise<Record<string, unknown>[]> {
  if (engine === 'sqlite') {
    const db = new DatabaseSync(url);
    try {
      if (!/^\s*select/i.test(sql)) return (db.exec(sql), []);
      return db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  }
  const client = await pgClient(url);
  try {
    return (await client.query(postgresRuntimeSql(sql))).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

const json = (said: Parameters<typeof bodyOf>[0]) => JSON.parse(bodyOf(said));

async function servesBothSources(t: TestContext, engine: Engine) {
  const { f, clerk, reader } = await twoBooksFixture(t, engine);
  const reads = await readOwner(f, engine, 'number');
  const owner = await commandOwner(f, engine, 'number');

  // Each operation is read on its own source's connection.
  assert.deepEqual(json(await reads.item(reader, 'item:invoice', '2')), {
    id: 2,
    customer_id: 2,
    'customer_id.name': 'Brill',
    total: 150,
    status: 'open',
  });
  assert.deepEqual(json(await reads.item(reader, 'item:stock.item', '3')), { id: 3, sku: 'VLT-07', qty: 2 });
  const first = json(await reads.list(reader, 'list:stock.item', 'limit=2&sort=id'));
  assert.deepEqual(
    first.items.map((row: { id: number }) => row.id),
    [1, 2],
  );
  const next = encodeURIComponent(first.next);
  assert.deepEqual(
    json(await reads.list(reader, 'list:stock.item', `limit=2&sort=id&cursor=${next}`)).items.map((row: { id: number }) => row.id),
    [3],
  );
  // A cursor sealed on one source's list is no cursor on another's.
  // (PostgreSQL's owner answers every malformed request as unavailable, as it always has.)
  assert.deepEqual(await reads.list(reader, 'list:customer', `limit=2&sort=id&cursor=${next}`), {
    refused: engine === 'sqlite' ? 'invalid_request' : 'temporarily_unavailable',
  });
  assert.equal(json(await reads.list(reader, 'view:items', '')).items.length, 3);

  // The documents say which source each operation reads, and what a request may assume.
  const spec = json(await owner.spec(clerk));
  assert.equal(spec['x-mistri-consistency'], 'single-source-per-request');
  const sources = Object.values(spec.paths as Record<string, Record<string, { operationId: string; 'x-mistri-source': string }>>)
    .flatMap((entry) => Object.values(entry))
    .map((operation) => [operation.operationId.split('_')[0], operation['x-mistri-source']]);
  assert.ok(sources.length > 4 && sources.every(([, source]) => source === 'sales' || source === 'stock'), JSON.stringify(sources));
  assert.ok(sources.some(([kind, source]) => kind === 'command' && source === 'stock'));
  const tools = json(await owner.tools(clerk)).tools as { name: string; description: string }[];
  assert.ok(
    tools.length && tools.every((tool) => / source "(sales|stock)" alone; nothing is promised across calls\.$/.test(tool.description)),
  );

  // A command commits on its target's connection, and its receipt is recovered from that connection's journal.
  const key = { id: 2 };
  const prepared = json(await owner.prepare(clerk, { command: 'restock', commandVersion: 1, key }));
  const run = {
    command: 'restock',
    commandVersion: 1,
    key,
    input: {},
    idempotencyKey: 'two-books-attempt-0001',
    expectedVersion: prepared.version,
  };
  const applied = await owner.execute(clerk, run);
  assert.equal(bodyOf(applied) && (applied as { status: number }).status, 200);
  assert.deepEqual(await exec(engine, f.urls.stock, 'SELECT qty, version FROM item WHERE id = 2'), [{ qty: 10, version: 1 }]);
  assert.equal(json(await owner.execute(clerk, run)).receipt.replayed, true);
  const recovered = json(await owner.recover(clerk, { command: 'restock', commandVersion: 1, idempotencyKey: run.idempotencyKey }));
  assert.equal(recovered.receipt.id, json(applied).receipt.id);
  const settled = await owner.execute(clerk, {
    command: 'settle',
    commandVersion: 1,
    key: { id: 1 },
    input: {},
    idempotencyKey: 'two-books-attempt-0002',
    expectedVersion: 0,
  });
  assert.equal((settled as { status: number }).status, 200, bodyOf(settled));
  assert.deepEqual(await exec(engine, f.urls.sales, 'SELECT status FROM invoice WHERE id = 1'), [{ status: 'paid' }]);
  // Each journal holds its own command's receipt, and only that one.
  const receipts = (url: string) => exec(engine, url, `SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`);
  assert.equal(Number((await receipts(f.urls.stock))[0].n), 1);
  assert.equal(Number((await receipts(f.urls.sales))[0].n), 1);

  // The feed reads the store beside the source its emitting command runs on.
  const feed = json(await reads.events(clerk, ''));
  assert.deepEqual(
    feed.items.map((item: { name: string; resource: string }) => [item.name, item.resource]),
    [['item.restocked', 'stock.item']],
  );
  // A read after the command sees it: each request reads afresh, nothing is held across them.
  assert.deepEqual(json(await reads.item(reader, 'item:stock.item', '2')), { id: 2, sku: 'STV-02', qty: 10 });
}

async function ddlRetires(t: TestContext, engine: Engine, changed: 'sales' | 'stock') {
  const { f, reader } = await twoBooksFixture(t, engine);
  const reads = await readOwner(f, engine, 'number');
  assert.equal(json(await reads.item(reader, 'item:customer', '1')).name, 'Acme');
  assert.equal(json(await reads.item(reader, 'item:stock.item', '1')).sku, 'LNT-01');
  await exec(engine, f.urls[changed], `ALTER TABLE ${changed === 'stock' ? 'item' : 'customer'} ADD COLUMN note TEXT`);
  // The changed lane's next read sees it, and the owner — one document set — retires whole.
  const here = changed === 'stock' ? ['item:stock.item', '1'] : ['item:customer', '1'];
  const there = changed === 'stock' ? ['item:customer', '1'] : ['item:stock.item', '1'];
  assert.deepEqual(await reads.item(reader, here[0], here[1]), { refused: 'temporarily_unavailable' });
  assert.deepEqual(await reads.item(reader, there[0], there[1]), { refused: 'temporarily_unavailable' });
}

test('two sources on SQLite: each request on its own connection, documented, commands and feed beside their source', async (t) => {
  await servesBothSources(t, 'sqlite');
});

test('two sources on SQLite: a schema change on either connection retires the owner', async (t) => {
  for (const changed of ['stock', 'sales'] as const) await t.test(changed, (t) => ddlRetires(t, 'sqlite', changed));
});

test('a request is bound to its lane: every other connection refuses inside it', async (t) => {
  const { f } = await twoBooksFixture(t, 'sqlite');
  const bindings = appSourceConnections(f.registry, f.app);
  const catalogs = new Map(await Promise.all(['sales', 'stock'].map(async (id) => [id, (await f.registry.open(id)).schema] as const)));
  const sales = (await f.registry.open('sales')).adapter;
  const lane = laneResources(f.app, 'sales', bindings, catalogs, 'sales', sales);
  // The App's whole catalog is named, so planning and documents see every resource…
  assert.deepEqual(lane.schema, f.resources.schema);
  // …but only the lane's connection is read.
  assert.ok((await lane.forConnection('sales').query({ table: 'customer', limit: 5 } as never)).rows.length);
  await assert.rejects(lane.forConnection('stock').query({ table: 'item', limit: 5 } as never), Refusal);
  assert.ok(lane.adapter.runView);
  await assert.rejects(
    lane.adapter.runView!({ kind: 'list', from: 'stock.item', query: '', select: ['id'], limit: 5 } as never),
    (error: Error) => error instanceof Refusal || /another connection|not support/i.test(error.message),
  );
});

test('an exposed command may not look up another connection before its transaction', async (t) => {
  const { f } = await twoBooksFixture(t, 'sqlite');
  assert.equal(checkApiCommandCatalog(f.app.api!, f.app, f.resources.schema, commands(), f.evidence).operations.length, 2);
  const looking = defineCommands({
    ...commands(),
    settle: defineCommand({
      source: 'sales',
      target: 'invoice',
      input: {},
      sources: { stock: ['item'] },
      output: shape({ id: int() }),
      async lookup() {
        return {};
      },
      async handle(context) {
        return { id: Number(context.record.id) };
      },
    }),
  });
  assert.throws(
    () => checkApiCommandCatalog(f.app.api!, f.app, f.resources.schema, looking, f.evidence),
    /api\.commands\.settle: looks up source "stock", on another connection.*\[api-multi-source\]/,
  );
});

test('two sources on PostgreSQL, each in a database of its own', { skip: liveSkip('postgres', LIVE), timeout: 180000 }, async (t) => {
  await servesBothSources(t, 'postgres');
});

test(
  'PostgreSQL: a request on one connection does not wait on the other',
  { skip: liveSkip('postgres', LIVE), timeout: 180000 },
  async (t) => {
    const { f, reader } = await twoBooksFixture(t, 'postgres');
    const reads = await readOwner(f, 'postgres', 'number');
    const holder = await pgClient(f.urls.stock);
    // The stock table is locked against every reader until this transaction ends.
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE item IN ACCESS EXCLUSIVE MODE');
    try {
      assert.equal(json(await reads.item(reader, 'item:invoice', '1'))['customer_id.name'], 'Acme');
      assert.equal(json(await reads.list(reader, 'list:customer', 'sort=id')).items.length, 2);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    assert.equal(json(await reads.item(reader, 'item:stock.item', '1')).sku, 'LNT-01');
  },
);

test(
  'PostgreSQL: a schema change on either connection retires the owner',
  { skip: liveSkip('postgres', LIVE), timeout: 240000 },
  async (t) => {
    for (const changed of ['stock', 'sales'] as const) await t.test(changed, (t) => ddlRetires(t, 'postgres', changed));
  },
);
