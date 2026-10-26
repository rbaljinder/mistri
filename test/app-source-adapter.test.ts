import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Adapter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-source-adapter-'));
  const opened: SqliteAdapter[] = [];
  t.after(async () => {
    await Promise.all(opened.map((adapter) => adapter.close()));
    rmSync(dir, { recursive: true, force: true });
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const [source, person] of [
    ['operations', 'Primary person'],
    ['inventory', 'Inventory person'],
  ]) {
    const file = join(dir, `${source}.db`);
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE physical_person (id INTEGER PRIMARY KEY, name TEXT NOT NULL); ' +
        'CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER REFERENCES physical_person(id));',
    );
    db.prepare('INSERT INTO physical_person VALUES (?, ?)').run(1, person);
    db.prepare('INSERT INTO physical_ticket VALUES (?, ?, ?)').run(1, 'inventory.person', 1);
    db.close();
    const adapter = new SqliteAdapter(file, source);
    opened.push(adapter);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: { person: 'physical_person', ticket: 'physical_ticket' },
    };
  }
  return { sources, runtime: createAppSourceAdapter(sources, 'operations') };
}

test('same-named resources route independent real CRUD without altering values or registry lifecycle', async (t) => {
  const { runtime } = await fixture(t);
  const primary = await runtime.adapter.query({ table: 'person', limit: 10, offset: 0 });
  const secondary = await runtime.adapter.query({ table: 'inventory.person', limit: 10, offset: 0 });
  assert.equal(primary.rows[0].name, 'Primary person');
  assert.equal(secondary.rows[0].name, 'Inventory person');
  assert.deepEqual(runtime.sourceFor('inventory.person'), {
    source: 'inventory',
    group: 'inventory',
    table: 'person',
    physicalTable: 'physical_person',
  });
  const inserted = await runtime.adapter.insert!({ table: 'inventory.ticket', values: { name: 'public.ticket', owner_id: 1 } });
  assert.equal(await runtime.adapter.count('inventory.ticket'), 2);
  assert.equal(await runtime.adapter.count('ticket'), 1);
  await runtime.adapter.update!({
    table: 'inventory.ticket',
    key: inserted.key,
    values: { name: 'operations.person' },
    expected: { name: 'public.ticket' },
  });
  const rows = await runtime.adapter.query({ table: 'inventory.ticket', limit: 10, offset: 0 });
  assert.equal(rows.rows.find((row) => row.id === inserted.key.id)?.name, 'operations.person');
  await runtime.adapter.remove!({ table: 'inventory.ticket', key: inserted.key });
  assert.equal(await runtime.adapter.count('inventory.ticket'), 1);
  assert.equal(runtime.adapter.transaction, undefined);
  assert.equal(runtime.adapter.runSql, undefined);
  assert.equal(runtime.adapter.explainSql, undefined);
  assert.equal(runtime.adapter.ddl, undefined);
  await runtime.adapter.close();
  await runtime.forSource('inventory').close();
  assert.equal(await runtime.adapter.count('person'), 1, 'Registry-owned adapters remain open');
});

test('forward views and breakdowns retain source identity and use only local relationships', async (t) => {
  const { runtime } = await fixture(t);
  const view: ViewDef = { id: 'owners', name: 'Owners', base: 'inventory.ticket', columns: [{ path: 'name' }, { path: 'owner_id.name' }] };
  const rows = await runtime.adapter.runView!(view);
  assert.equal(rows.rows[0].name, 'inventory.person');
  assert.equal(rows.rows[0]['owner_id.name'], 'Inventory person');
  assert.deepEqual(
    rows.resolved.map((column) => column.table),
    ['inventory.ticket', 'inventory.person'],
  );
  assert.equal(rows.joins[0].table, 'inventory.person');
  assert.equal(await runtime.adapter.countView!(view), 1);
  const breakdown = { base: 'inventory.ticket', by: [{ path: 'owner_id.name' }], measures: [{ fn: 'count' as const }] };
  const grouped = await runtime.adapter.runBreakdown!(breakdown);
  assert.equal(grouped.rows[0]['owner_id.name'], 'Inventory person');
  assert.equal(await runtime.adapter.countBreakdown!(breakdown), 1);
  assert.equal(view.base, 'inventory.ticket');
  assert.equal((await runtime.adapter.profile!('inventory.person')).table, 'inventory.person');
});

test('reverse aggregate child names and default output aliases survive source-local compilation', async (t) => {
  const { runtime } = await fixture(t);
  const view: ViewDef = {
    id: 'counts',
    name: 'Counts',
    base: 'inventory.person',
    columns: [{ path: 'id' }],
    aggregates: [{ fn: 'count', via: 'inventory.ticket.owner_id' }],
  };
  const result = await runtime.adapter.runView!(view);
  assert.deepEqual(result.columns, ['id', 'count(inventory.ticket)']);
  assert.equal(result.rows[0]['count(inventory.ticket)'], 1);
  assert.equal(result.resolved[1].table, 'inventory.ticket');
  assert.equal(await runtime.adapter.countView!(view), 1);
  await assert.rejects(runtime.adapter.runView!({ ...view, base: 'person' }), /Nothing called/);
  assert.equal(view.aggregates?.[0].via, 'inventory.ticket.owner_id');
});

test('related filters and aggregate sorting preserve merged aliases through both logical facades', async (t) => {
  const { runtime } = await fixture(t);
  await runtime.adapter.insert!({ table: 'inventory.ticket', values: { name: 'Second', owner_id: 1 } });
  const view: ViewDef = {
    id: 'related',
    name: 'Related',
    base: 'inventory.ticket',
    columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'Owner' }],
    aggregates: [{ fn: 'count', via: 'inventory.ticket.owner_id', on: 'owner_id' }],
    filter: { groups: [[{ path: 'owner_id.name', op: '=', value: 'Inventory person' }]] },
    orderBy: [
      { path: 'count(owner_id.inventory.ticket)', direction: 'desc', alias: true },
      { path: 'id', direction: 'desc' },
    ],
    limit: 1,
  };
  const before = structuredClone(view);
  const result = await runtime.adapter.runView!(view, 1);
  assert.deepEqual(result.columns, ['id', 'Owner', 'count(owner_id.inventory.ticket)']);
  assert.deepEqual(result.rows, [{ id: 1, Owner: 'Inventory person', 'count(owner_id.inventory.ticket)': 2 }]);
  assert.deepEqual(
    result.resolved.map((column) => column.table),
    ['inventory.ticket', 'inventory.person', 'inventory.ticket'],
  );
  assert.equal(result.resolved[1].path, 'owner_id.name');
  assert.equal(result.joins[0].path, 'owner_id');
  assert.equal(await runtime.adapter.countView!(view), 2);
  assert.deepEqual(
    await runtime.adapter.runView!({ ...view, filter: { groups: [[{ path: 'owner_id.name', op: '=', value: 'Primary person' }]] } }).then(
      (result) => result.rows,
    ),
    [],
  );
  assert.deepEqual(view, before);
});

test('transactions require an anchored source and cross-source writes roll back earlier steps', async (t) => {
  const { runtime } = await fixture(t);
  const inventory = runtime.forSource('inventory');
  assert.strictEqual(inventory, runtime.forSource('inventory'));
  assert.equal(inventory.runSql, undefined);
  assert.equal(inventory.ddl, undefined);
  assert.deepEqual(
    (await inventory.introspect()).tables.map((table) => table.id),
    ['inventory.person', 'inventory.ticket'],
  );
  await inventory.transaction!(async (tx) => {
    await tx.update({ table: 'inventory.person', key: { id: 1 }, values: { name: 'Updated' } });
    await tx.insert({ table: 'inventory.ticket', values: { name: 'Created', owner_id: 1 } });
    await tx.remove({ table: 'inventory.ticket', key: { id: 1 } });
    assert.equal(await tx.count('inventory.ticket'), 1);
    assert.equal((await tx.query({ table: 'inventory.person', limit: 1, offset: 0 })).rows[0].name, 'Updated');
  });
  assert.equal(await inventory.count('inventory.ticket'), 1);
  assert.equal((await inventory.query({ table: 'inventory.person', limit: 1, offset: 0 })).rows[0].name, 'Updated');
  await assert.rejects(
    inventory.transaction!(async (tx) => {
      await tx.insert({ table: 'inventory.ticket', values: { name: 'Must roll back', owner_id: 1 } });
      await tx.update({ table: 'person', key: { id: 1 }, values: { name: 'Wrong source' } });
    }),
    /Cross-source transactions are not supported/,
  );
  assert.equal(await runtime.adapter.count('inventory.ticket'), 1);
  for (const read of [
    (tx: WriteTransaction) => tx.query({ table: 'person', limit: 1, offset: 0 }),
    (tx: WriteTransaction) => tx.count('person'),
  ]) {
    await assert.rejects(
      inventory.transaction!(async (tx) => {
        await tx.insert({ table: 'inventory.ticket', values: { name: 'Read must roll back', owner_id: 1 } });
        await read(tx);
      }),
      /Cross-source transactions are not supported/,
    );
    assert.equal(await runtime.adapter.count('inventory.ticket'), 1);
  }
  assert.equal((await runtime.adapter.query({ table: 'person', limit: 1, offset: 0 })).rows[0].name, 'Primary person');
  await assert.rejects(inventory.query({ table: 'person', limit: 1, offset: 0 }), /belongs to source "operations"/);
  assert.throws(() => runtime.forSource('missing'), /Unknown app source/);
});

test('write defense requires explicit permission even when an underlying adapter can write', async (t) => {
  const { sources } = await fixture(t);
  sources.inventory.writable = false;
  delete sources.operations.writable;
  const runtime = createAppSourceAdapter(sources, 'operations');
  for (const table of ['person', 'inventory.person']) {
    await assert.rejects(runtime.adapter.update!({ table, key: { id: 1 }, values: { name: 'Refused' } }), /read-only/);
    await assert.rejects(runtime.adapter.insert!({ table, values: { name: 'Refused' } }), /read-only/);
    await assert.rejects(runtime.adapter.remove!({ table, key: { id: 1 } }), /read-only/);
  }
  await assert.rejects(
    runtime.forSource('inventory').transaction!(async () => 'unreachable'),
    /read-only/,
  );
  assert.equal(await runtime.adapter.count('inventory.person'), 1);
});

test('mixed adapters preserve per-source dialect, unsupported capabilities and failure isolation', async (t) => {
  const { sources } = await fixture(t);
  let fakeReads = 0;
  const fake: Adapter = {
    dialect: 'postgres',
    introspect: async () => ({ ...sources.inventory.schema, dialect: 'postgres' }),
    query: async (request) => {
      fakeReads += 1;
      assert.equal(request.table, 'physical_person');
      throw new Error('Secondary unavailable');
    },
    count: async (table) => {
      assert.equal(table, 'physical_person');
      return 7;
    },
    close: async () => {
      throw new Error('Registry owns close');
    },
  };
  sources.operations.adapter.estimateCount = async () => 5;
  sources.inventory = { ...sources.inventory, adapter: fake, schema: { ...sources.inventory.schema, dialect: 'postgres' } };
  const runtime = createAppSourceAdapter(sources, 'operations');
  assert.equal(runtime.adapter.dialect, 'sqlite');
  assert.equal(runtime.forSource('inventory').dialect, 'postgres');
  assert.equal(runtime.forSource('inventory').runView, undefined);
  assert.equal(runtime.forSource('inventory').transaction, undefined);
  assert.equal(await runtime.adapter.count('inventory.person'), 7);
  assert.equal(await runtime.adapter.estimateCount!('person'), 5);
  assert.equal(await runtime.adapter.estimateCount!('inventory.person'), undefined);
  await assert.rejects(
    runtime.adapter.runView!({ id: 'v', name: 'V', base: 'inventory.person', columns: [{ path: 'id' }] }),
    /source "inventory" does not support views/,
  );
  await assert.rejects(
    runtime.adapter.update!({ table: 'inventory.person', key: { id: 1 }, values: { name: 'No method' } }),
    /does not support updates/,
  );
  await assert.rejects(runtime.adapter.query({ table: 'inventory.person', limit: 1, offset: 0 }), /Secondary unavailable/);
  assert.equal(fakeReads, 1);
  assert.equal(await runtime.adapter.count('person'), 1);
  await assert.rejects(runtime.adapter.query({ table: 'physical_person', limit: 1, offset: 0 }), /Unknown app resource/);
  assert.equal(fakeReads, 1);
  await runtime.adapter.close();
});
