import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POSTGRES_STYLE, type Adapter, type QueryResult, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { compileView, resolveAggregate, type ViewDef } from '../packages/engine/src/shared/view.js';
import { textToView, viewToTextWithSchema } from '../packages/engine/src/shared/viewtext.js';
import { metricView, type PageDef } from '../packages/engine/src/shared/page.js';
import { compileBreakdown } from '../packages/engine/src/shared/breakdown.js';
import { appResourceCatalog, createAppResources } from '../packages/mistri/src/server/app/appResources.js';

function table(name: string, schema = 'public'): TableMeta {
  return {
    id: `${schema}.${name}`,
    name,
    schema,
    isView: false,
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'name', type: 'text', nullable: false, primaryKey: false },
    ],
  };
}

function catalog(): DatabaseSchema {
  const parent = table('customer');
  const child = table('ticket');
  child.columns.push({
    name: 'customer_id',
    type: 'integer',
    nullable: true,
    primaryKey: false,
    references: { table: parent.id, column: 'id' },
  });
  return {
    dialect: 'postgres',
    label: 'Example',
    readAt: '2026-09-06',
    tables: [parent, child],
    foreignKeys: [
      {
        name: 'ticket_customer_fk',
        from: { table: child.id, columns: ['customer_id'] },
        to: { table: parent.id, columns: ['id'] },
        onDelete: 'restrict',
      },
    ],
  };
}

function collidingCatalog(): DatabaseSchema {
  const schema = catalog();
  schema.foreignKeys[0].name = 'other.customer_id';
  const other = structuredClone(schema.tables[1]);
  other.id = 'public.other';
  other.name = 'other';
  schema.tables.push(other);
  schema.foreignKeys.push({
    ...structuredClone(schema.foreignKeys[0]),
    name: 'other_fk',
    from: { table: other.id, columns: ['customer_id'] },
  });
  return schema;
}

test('text aggregates preserve the selected edge across logical names and physical constraint collisions', () => {
  const { schema } = appResourceCatalog(collidingCatalog());
  for (const child of ['ticket', 'other']) {
    const parsed = textToView(schema, `customer show id count ${child} via customer_id`);
    assert.deepEqual(parsed.errors, []);
    const aggregate = parsed.view!.aggregates![0];
    assert.equal(aggregate.via, `${child}.customer_id`);
    assert.equal(resolveAggregate(schema, 'customer', aggregate).child.id, child);
    const text = viewToTextWithSchema(schema, parsed.view!);
    assert.match(text, new RegExp(`count ${child} via customer_id`));
    const roundTrip = textToView(schema, text);
    assert.deepEqual(roundTrip.errors, []);
    assert.deepEqual(roundTrip.view!.aggregates, parsed.view!.aggregates);
  }
});

test('page metric aggregates preserve their selected child when a constraint collides with another alias', () => {
  const { schema } = appResourceCatalog(collidingCatalog());
  const page: PageDef = { id: 'customer', name: 'Customer', base: 'customer', sections: [] };
  for (const child of ['ticket', 'other']) {
    const planned = metricView(schema, page, { kind: 'metric', fn: 'sum', column: 'id', from: child, path: 'customer_id' }, { id: 1 }, 0);
    assert.equal(planned.error, undefined);
    const aggregate = planned.view!.aggregates![0];
    assert.equal(aggregate.via, `${child}.customer_id`);
    assert.equal(resolveAggregate(schema, 'customer', aggregate).child.id, child);
  }
});

const result: QueryResult = {
  columns: ['name'],
  rows: [{ name: 'public.customer', extra: { table: 'public.ticket' } }],
  ms: 1,
  sql: { text: 'SELECT name FROM "public"."customer"', params: ['public.ticket'] },
};

function reader(schema = catalog()): Adapter {
  return { dialect: 'postgres', introspect: async () => schema, query: async () => result, count: async () => 3, close: async () => {} };
}

test('logical catalog preserves references, column metadata and the physical catalog', () => {
  const physical = catalog();
  const original = structuredClone(physical);
  const resource = appResourceCatalog(physical);
  assert.deepEqual(
    resource.schema.tables.map((t) => [t.id, t.name, t.schema]),
    [
      ['customer', 'customer', ''],
      ['ticket', 'ticket', ''],
    ],
  );
  assert.equal(resource.schema.tables[1].columns[2].references?.table, 'customer');
  assert.equal(resource.schema.foreignKeys[0].from.table, 'ticket');
  assert.equal(resource.schema.foreignKeys[0].to.table, 'customer');
  assert.equal(resource.schema.foreignKeys[0].onDelete, 'restrict');
  assert.equal(resource.toPhysical('customer'), 'public.customer');
  assert.equal(resource.toLogical('public.ticket'), 'ticket');
  assert.throws(() => resource.toPhysical('public.customer'), /Unknown app resource/);
  assert.throws(() => resource.toPhysical('missing'), /Unknown app resource/);
  assert.throws(() => resource.toLogical('secret.customer'), /Unknown table/);
  assert.deepEqual(physical, original);
});

test("a name two schemas share is qualified for both, never silently one schema's; an alias names either", () => {
  const physical = catalog();
  physical.tables.push(table('customer', 'archive'));
  const inferred = appResourceCatalog(physical);
  assert.equal(inferred.toPhysical('public_customer'), 'public.customer');
  assert.equal(inferred.toPhysical('archive_customer'), 'archive.customer');
  assert.throws(() => inferred.toPhysical('customer'), /Unknown app resource/);
  /* Binding one copy leaves its twin's inferred name where it was. */
  const aliases = appResourceCatalog(physical, { archived_customers: 'archive.customer' });
  assert.equal(aliases.toPhysical('public_customer'), 'public.customer');
  assert.equal(appResourceCatalog(physical, { customer: 'public.customer' }).toPhysical('customer'), 'public.customer');
  assert.equal(aliases.toPhysical('archived_customers'), 'archive.customer');
  assert.equal(aliases.schema.tables[2].name, 'archived_customers');
  assert.throws(() => appResourceCatalog(physical, { ticket: 'archive.customer' }), /ambiguous/);
  assert.throws(() => appResourceCatalog(physical, { absent: 'no.customer' }), /unknown table/);
  assert.throws(() => appResourceCatalog(catalog(), { one: 'public.customer', two: 'public.customer' }), /multiple app resource/);
  assert.throws(() => appResourceCatalog(catalog(), { 'public.customer': 'public.customer' }), /simple identifier/);
});

test('facade maps read/count/profile identities and preserves values and optional capabilities', async () => {
  const physical = reader();
  const calls: unknown[] = [];
  physical.query = async (request) => {
    calls.push(request);
    return result;
  };
  physical.count = async (table, filter) => {
    calls.push([table, filter]);
    return 3;
  };
  physical.estimateCount = async (table) => {
    calls.push(table);
    return undefined;
  };
  physical.profile = async (table) => ({ table, columns: [], source: 'statistics', ms: 1 });
  const { adapter, schema } = createAppResources(physical, catalog());
  const filter = { groups: [[{ column: 'name', op: '=' as const, value: 'public.customer' }]] };
  const answer = await adapter.query({ table: 'customer', filter, limit: 5, offset: 0 });
  assert.strictEqual(answer, result);
  assert.deepEqual(calls[0], { table: 'public.customer', filter, limit: 5, offset: 0 });
  assert.equal(await adapter.count('ticket', filter), 3);
  assert.deepEqual(calls[1], ['public.ticket', filter]);
  assert.equal(await adapter.estimateCount!('ticket'), undefined);
  assert.equal(calls[2], 'public.ticket');
  assert.equal((await adapter.profile!('customer')).table, 'customer');
  assert.strictEqual(await adapter.introspect(), schema);
  assert.equal(adapter.update, undefined);
  assert.equal(adapter.transaction, undefined);
  assert.equal(adapter.runView, undefined);
  assert.equal(adapter.runSql, undefined);
});

test('forward views compile physical joins but return logical metadata and untouched rows', async () => {
  const physicalSchema = catalog();
  const physical = reader(physicalSchema);
  let query = '';
  let offset: number | undefined;
  physical.runView = async (view, at) => {
    offset = at;
    const compiled = compileView(physicalSchema, view, POSTGRES_STYLE);
    query = compiled.text;
    return { ...result, resolved: compiled.columns, joins: compiled.joins };
  };
  const { adapter } = createAppResources(physical, physicalSchema, { accounts: 'public.customer', issues: 'public.ticket' });
  const view: ViewDef = { id: 'v', name: 'V', base: 'issues', columns: [{ path: 'customer_id.name' }] };
  const answer = await adapter.runView!(view, 4);
  assert.match(query, /FROM "public"\."ticket"/);
  assert.match(query, /LEFT JOIN "public"\."customer"/);
  assert.equal(answer.resolved[0].table, 'accounts');
  assert.equal(answer.joins[0].table, 'accounts');
  assert.strictEqual(answer.rows, result.rows);
  assert.strictEqual(answer.sql.params, result.sql.params);
  assert.equal(offset, 4);
  assert.equal(view.base, 'issues');
});

test('reverse aggregates preserve logical default output names and map child identifiers', async () => {
  const physicalSchema = catalog();
  const physical = reader(physicalSchema);
  const captured: ViewDef[] = [];
  physical.runView = async (view) => {
    captured.push(view);
    const compiled = compileView(physicalSchema, view, POSTGRES_STYLE);
    return { ...result, resolved: compiled.columns, joins: compiled.joins };
  };
  physical.countView = async (view) => {
    captured.push(view);
    compileView(physicalSchema, view, POSTGRES_STYLE);
    return 2;
  };
  const { adapter } = createAppResources(physical, physicalSchema, { accounts: 'public.customer', issues: 'public.ticket' });
  const view: ViewDef = {
    id: 'v',
    name: 'V',
    base: 'accounts',
    columns: [{ path: 'id' }],
    aggregates: [{ fn: 'count', via: 'issues.customer_id' }],
  };
  const answer = await adapter.runView!(view);
  assert.equal(captured[0].base, 'public.customer');
  assert.equal(captured[0].aggregates?.[0].via, 'public.ticket.customer_id');
  assert.equal(captured[0].aggregates?.[0].alias, 'count(issues)');
  assert.equal(answer.resolved[1].name, 'count(issues)');
  assert.equal(answer.resolved[1].table, 'issues');
  assert.equal(await adapter.countView!(view), 2);
  assert.equal(view.aggregates?.[0].via, 'issues.customer_id');
});

test('breakdowns keep reference paths, filters, aliases and values unchanged', async () => {
  const physicalSchema = catalog();
  const physical = reader(physicalSchema);
  let base: string | undefined;
  physical.runBreakdown = async (definition) => {
    base = definition.base;
    const compiled = compileBreakdown(physicalSchema, definition, POSTGRES_STYLE);
    return { ...result, resolved: compiled.columns };
  };
  physical.countBreakdown = async (definition) => {
    base = definition.base;
    return 1;
  };
  const { adapter } = createAppResources(physical, physicalSchema);
  const definition = { base: 'ticket', by: [{ path: 'customer_id.name', alias: 'public.customer' }], measures: [{ fn: 'count' as const }] };
  const answer = await adapter.runBreakdown!(definition);
  assert.equal(base, 'public.ticket');
  assert.equal(answer.resolved[0].name, 'public.customer');
  assert.strictEqual(answer.rows, result.rows);
  assert.equal(await adapter.countBreakdown!(definition), 1);
  assert.equal(definition.base, 'ticket');
});

test('all write methods and transaction callbacks map only table identities', async () => {
  const physical = reader();
  const calls: unknown[] = [];
  const tx: WriteTransaction = {
    query: async (request) => {
      calls.push(request);
      return result;
    },
    count: async (table, filter) => {
      calls.push({ table, filter });
      return 1;
    },
    update: async (request) => {
      calls.push(request);
      return { affected: 1, applied: request.values, sql: result.sql };
    },
    insert: async (request) => {
      calls.push(request);
      return { key: { id: 3 }, applied: request.values, sql: result.sql };
    },
    remove: async (request) => {
      calls.push(request);
      return { affected: 1, sql: result.sql };
    },
  };
  Object.assign(physical, tx);
  physical.transaction = (run) => run(tx);
  const { adapter } = createAppResources(physical, catalog());
  const update = { table: 'customer', key: { id: 1 }, values: { name: 'public.customer' }, expected: { name: 'public.ticket' } };
  const insert = { table: 'ticket', values: { name: 'public.customer' } };
  const remove = { table: 'ticket', key: { id: 2 } };
  await adapter.update!(update);
  await adapter.insert!(insert);
  await adapter.remove!(remove);
  const answer = await adapter.transaction!(async (wrapped) => {
    await wrapped.update(update);
    await wrapped.insert(insert);
    await wrapped.remove(remove);
    await wrapped.query({ table: 'customer', limit: 1, offset: 0 });
    assert.equal(await wrapped.count('ticket'), 1);
    return 'done';
  });
  assert.equal(answer, 'done');
  const expected = [
    { ...update, table: 'public.customer' },
    { ...insert, table: 'public.ticket' },
    { ...remove, table: 'public.ticket' },
  ];
  assert.deepEqual(calls, [
    ...expected,
    ...expected,
    { table: 'public.customer', limit: 1, offset: 0 },
    { table: 'public.ticket', filter: undefined },
  ]);
  assert.equal(update.table, 'customer');
});

test('raw SQL capability and lifecycle remain bound to the original adapter', async () => {
  const physical = reader();
  let closed = false;
  const rawRows = [['public.customer']];
  physical.close = async () => {
    closed = true;
  };
  physical.runSql = async function (request) {
    assert.strictEqual(this, physical);
    assert.equal(request.text, 'SELECT name FROM public.customer');
    return { ...result, rows: rawRows, bounded: true, truncated: false };
  };
  physical.ddl = async (table) => table;
  const { adapter } = createAppResources(physical, catalog());
  const statement = { text: 'SELECT name FROM public.customer', limit: 1 };
  assert.strictEqual((await adapter.runSql!(statement)).rows, rawRows);
  assert.equal(await adapter.ddl!('ticket'), 'public.ticket');
  await adapter.close();
  assert.equal(closed, true);
});
