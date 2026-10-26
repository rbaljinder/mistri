import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSI_STYLE, type Adapter } from '../packages/engine/src/adapters/adapter.js';
import { accessibleSchema, AppAccessDenied, authorizeResources, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { compileView, type ViewDef } from '../packages/engine/src/shared/view.js';
import { compileBreakdown, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import type { DatabaseSchema, ForeignKey, TableMeta } from '../packages/engine/src/shared/schema.js';

const table = (id: string, names = ['id', 'name']): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: names.map((name) => ({
    name,
    type: name === 'id' || name.endsWith('_id') ? 'integer' : 'text',
    nullable: name !== 'id',
    primaryKey: name === 'id',
  })),
});
const edge = (name: string, from: string, column: string, to: string, onDelete?: ForeignKey['onDelete']): ForeignKey => ({
  name,
  from: { table: from, columns: [column] },
  to: { table: to, columns: ['id'] },
  ...(onDelete ? { onDelete } : {}),
});
const graph = (): DatabaseSchema => {
  const incident = table('incident', ['id', 'name', 'secret_id', 'service_id']);
  incident.columns.find((column) => column.name === 'secret_id')!.references = { table: 'secret', column: 'id' };
  incident.columns.find((column) => column.name === 'service_id')!.references = { table: 'service', column: 'id' };
  return {
    label: 'Fixture',
    dialect: 'sqlite',
    readAt: '2026-09-06',
    tables: [incident, table('service'), table('secret'), table('note', ['id', 'incident_id', 'body'])],
    foreignKeys: [
      edge('incident_secret', 'incident', 'secret_id', 'secret'),
      edge('incident_service', 'incident', 'service_id', 'service'),
      edge('note_incident', 'note', 'incident_id', 'incident', 'cascade'),
    ],
  };
};
const grant = (readable: string[], writable: string[] = []): ResourceAccess => ({
  readable: new Set(readable),
  writable: new Set(writable),
});
const view = (changes: Partial<ViewDef> = {}): ViewDef => ({
  id: 'fixture',
  name: 'Fixture',
  base: 'incident',
  columns: [{ path: 'name' }],
  ...changes,
});
const breakdown = (changes: Partial<BreakdownDef> = {}): BreakdownDef => ({
  base: 'incident',
  by: [],
  measures: [{ fn: 'count' }],
  ...changes,
});

function fixture(schema = graph()) {
  const calls: string[] = [];
  const sql = { text: 'fixture', params: [] };
  const adapter: Adapter = {
    dialect: 'sqlite',
    introspect: async () => schema,
    close: async () => {
      calls.push('close');
    },
    query: async (request) => {
      calls.push(`query:${request.table}`);
      return { columns: [], rows: [], ms: 0, sql };
    },
    count: async (name) => {
      calls.push(`count:${name}`);
      return 0;
    },
    estimateCount: async (name) => {
      calls.push(`estimate:${name}`);
      return 0;
    },
    profile: async (name) => {
      calls.push(`profile:${name}`);
      return { table: name, columns: [], source: 'scan', ms: 0 };
    },
    runView: async (def) => {
      calls.push('view');
      const compiled = compileView(schema, def, ANSI_STYLE);
      return {
        columns: compiled.columns.map((column) => column.name),
        rows: [],
        ms: 0,
        sql: { text: compiled.text, params: compiled.params },
        resolved: compiled.columns,
        joins: compiled.joins,
      };
    },
    countView: async (def) => {
      calls.push('countView');
      compileView(schema, def, ANSI_STYLE);
      return 0;
    },
    runBreakdown: async (def) => {
      calls.push('breakdown');
      const compiled = compileBreakdown(schema, def, ANSI_STYLE);
      return { columns: compiled.columns.map((column) => column.name), rows: [], ms: 0, sql, resolved: compiled.columns };
    },
    countBreakdown: async (def) => {
      calls.push('countBreakdown');
      compileBreakdown(schema, def, ANSI_STYLE);
      return 0;
    },
    insert: async (request) => {
      calls.push(`insert:${request.table}`);
      return { key: { id: 1 }, applied: request.values, sql };
    },
    update: async (request) => {
      calls.push(`update:${request.table}`);
      return { affected: 1, applied: request.values, sql };
    },
    remove: async (request) => {
      calls.push(`remove:${request.table}`);
      return { affected: 1, sql };
    },
    runSql: async () => {
      calls.push('sql');
      return { columns: [], rows: [], ms: 0, bounded: true, truncated: false, sql };
    },
    explainSql: async () => {
      calls.push('explain');
      return { plan: [], ms: 0 };
    },
    ddl: async () => {
      calls.push('ddl');
      return '';
    },
    transaction: async (run) => {
      calls.push('transaction');
      return run({ query: adapter.query, count: adapter.count, insert: adapter.insert!, update: adapter.update!, remove: adapter.remove! });
    },
  };
  const resources: RuntimeResources = {
    schema,
    adapter,
    connections: ['operations'],
    toPhysical: (name) => name,
    toLogical: (name) => name,
    connectionFor: () => 'operations',
    toLogicalAt: (name) => name,
    forConnection: (owner) => {
      assert.equal(owner, 'operations');
      return adapter;
    },
  };
  return { calls, resources, guarded: (access: ResourceAccess) => authorizeResources(resources, access) };
}

test('visible schema removes hidden tables and both forms of relationship metadata without mutating the catalog', async () => {
  const schema = graph();
  const before = structuredClone(schema);
  const allowed = grant(['incident', 'service']);
  const visible = accessibleSchema(schema, allowed);
  assert.deepEqual(
    visible.tables.map((item) => item.id),
    ['incident', 'service'],
  );
  assert.deepEqual(
    visible.foreignKeys.map((fk) => fk.name),
    ['incident_service'],
  );
  assert.equal(visible.tables[0].columns.find((column) => column.name === 'secret_id')!.references, undefined);
  assert.equal(visible.tables[0].columns.find((column) => column.name === 'service_id')!.references?.table, 'service');
  assert.deepEqual(schema, before);
  assert.deepEqual(await fixture(schema).guarded(allowed).adapter.introspect(), visible);
});

test('direct reads, statistics and profiles refuse hidden resources before executing', async () => {
  const { calls, guarded } = fixture();
  const adapter = guarded(grant(['incident'])).adapter;
  for (const operation of [
    () => adapter.query({ table: 'secret', limit: 10, offset: 0 }),
    () => adapter.count('secret'),
    () => adapter.estimateCount!('secret'),
    () => adapter.profile!('secret'),
  ])
    await assert.rejects(async () => operation(), AppAccessDenied);
  assert.deepEqual(calls, []);
  await adapter.query({ table: 'incident', limit: 10, offset: 0 });
  assert.deepEqual(calls, ['query:incident']);
});

test('view projections, relation filters, sorting and reverse aggregates cannot traverse hidden resources', async () => {
  const { calls, guarded } = fixture();
  const adapter = guarded(grant(['incident', 'service'])).adapter;
  const denied = [
    view({ columns: [{ path: 'secret_id.name' }] }),
    view({ filter: { groups: [[{ path: 'secret_id.name', op: '=', value: 'private' }]] } }),
    view({ orderBy: [{ path: 'secret_id.name', direction: 'asc' }] }),
    view({ aggregates: [{ fn: 'count', via: 'note_incident' }] }),
    view({ base: 'secret' }),
  ];
  for (const def of denied) {
    await assert.rejects(async () => adapter.runView!(def));
    await assert.rejects(async () => adapter.countView!(def));
  }
  assert.deepEqual(calls, []);
  const result = await adapter.runView!(view({ columns: [{ path: 'service_id.name' }] }));
  assert.equal(result.resolved[0].table, 'service');
  assert.deepEqual(calls, ['view']);
});

test('breakdown grouping, measures and filters are checked on both execution and count paths', async () => {
  const { calls, guarded } = fixture();
  const adapter = guarded(grant(['incident', 'service'])).adapter;
  for (const def of [
    breakdown({ by: [{ path: 'secret_id.name' }] }),
    breakdown({ measures: [{ fn: 'count', path: 'secret_id.id' }] }),
    breakdown({ filter: { groups: [[{ path: 'secret_id.name', op: '=', value: 'private' }]] } }),
    // A funnel's stage is a condition of its own (`count when [...]`), held to the reader's grants as the filter is.
    breakdown({
      measures: [{ fn: 'count', alias: 'stage_1', where: { groups: [[{ path: 'secret_id.name', op: '=', value: 'private' }]] } }],
    }),
  ]) {
    await assert.rejects(async () => adapter.runBreakdown!(def));
    await assert.rejects(async () => adapter.countBreakdown!(def));
  }
  assert.deepEqual(calls, []);
  await adapter.runBreakdown!(breakdown({ by: [{ path: 'service_id.name' }] }));
  assert.deepEqual(calls, ['breakdown']);
});

test('default view projection stays on the readable base table without adding hidden joins', async () => {
  const { calls, guarded } = fixture();
  const adapter = guarded(grant(['incident'])).adapter;
  const def = view({ columns: [] });
  const result = await adapter.runView!(def);
  assert.deepEqual(result.columns, ['id', 'name', 'secret_id', 'service_id']);
  assert.ok(result.resolved.every((column) => column.table === 'incident' && column.hops === 0));
  assert.deepEqual(result.joins, []);
  assert.doesNotMatch(result.sql.text, /JOIN/);
  await adapter.countView!(def);
  assert.deepEqual(calls, ['view', 'countView']);
});

test('deletes require writable cascade targets and refuse unknown dependent actions', async () => {
  for (const onDelete of ['cascade', 'set null', 'set default', undefined] as const) {
    const schema = graph();
    schema.foreignKeys = [edge('note_incident', 'note', 'incident_id', 'incident', onDelete)];
    const { calls, guarded } = fixture(schema);
    for (const allowed of [grant(['incident'], ['incident']), grant(['incident', 'note'], ['incident'])]) {
      await assert.rejects(async () => guarded(allowed).adapter.remove!({ table: 'incident', key: { id: 1 } }), AppAccessDenied);
    }
    assert.deepEqual(calls, []);
    await guarded(grant(['incident', 'note'], ['incident', 'note'])).adapter.remove!({ table: 'incident', key: { id: 1 } });
    assert.deepEqual(calls, ['remove:incident']);
  }
});

test('restrict and no-action delete dependencies need read visibility but do not require dependent writes', async () => {
  for (const onDelete of ['restrict', 'no action'] as const) {
    const schema = graph();
    schema.foreignKeys = [edge('note_incident', 'note', 'incident_id', 'incident', onDelete)];
    const { calls, guarded } = fixture(schema);
    await assert.rejects(
      async () => guarded(grant(['incident'], ['incident'])).adapter.remove!({ table: 'incident', key: { id: 1 } }),
      AppAccessDenied,
    );
    assert.deepEqual(calls, []);
    await guarded(grant(['incident', 'note'], ['incident'])).adapter.remove!({ table: 'incident', key: { id: 1 } });
    assert.deepEqual(calls, ['remove:incident']);
  }
});

test('recursive cascade checks cover grandchildren and terminate cycles without issuing duplicate writes', async () => {
  const schema = graph();
  schema.tables = ['incident', 'note', 'attachment'].map((name) => table(name, ['id', 'parent_id', 'name']));
  schema.foreignKeys = [
    edge('note_parent', 'note', 'parent_id', 'incident', 'cascade'),
    edge('attachment_parent', 'attachment', 'parent_id', 'note', 'cascade'),
    edge('incident_parent', 'incident', 'parent_id', 'attachment', 'cascade'),
  ];
  const { calls, guarded } = fixture(schema);
  await assert.rejects(
    async () =>
      guarded(grant(['incident', 'note', 'attachment'], ['incident', 'note'])).adapter.remove!({ table: 'incident', key: { id: 1 } }),
    AppAccessDenied,
  );
  assert.deepEqual(calls, []);
  await guarded(grant(['incident', 'note', 'attachment'], ['incident', 'note', 'attachment'])).adapter.remove!({
    table: 'incident',
    key: { id: 1 },
  });
  assert.deepEqual(calls, ['remove:incident']);
});

test('key updates conservatively check dependents even without on-update metadata; unrelated fields remain editable', async () => {
  const { calls, guarded } = fixture();
  const adapter = guarded(grant(['incident'], ['incident'])).adapter;
  await assert.rejects(async () => adapter.update!({ table: 'incident', key: { id: 1 }, values: { id: 2 } }), AppAccessDenied);
  assert.deepEqual(calls, []);
  await adapter.update!({ table: 'incident', key: { id: 1 }, values: { name: 'Edited' } });
  assert.deepEqual(calls, ['update:incident']);
});

test('transaction writers retain access checks and source-scoped adapters expose no raw SQL capabilities', async () => {
  const { calls, guarded } = fixture();
  const resources = guarded(grant(['incident', 'note'], ['incident']));
  for (const adapter of [resources.adapter, resources.forConnection('operations')]) {
    assert.equal(adapter.runSql, undefined);
    assert.equal(adapter.explainSql, undefined);
    assert.equal(adapter.ddl, undefined);
    await assert.rejects(async () => adapter.insert!({ table: 'secret', values: { name: 'Forbidden' } }), AppAccessDenied);
    await assert.rejects(
      async () =>
        adapter.transaction!(async (writer) => {
          assert.deepEqual(Object.keys(writer).sort(), ['count', 'insert', 'query', 'remove', 'update']);
          await writer.remove({ table: 'incident', key: { id: 1 } });
        }),
      AppAccessDenied,
    );
    await adapter.transaction!((writer) => writer.update({ table: 'incident', key: { id: 1 }, values: { name: 'Allowed' } }));
    await adapter.close();
  }
  assert.deepEqual(calls, ['transaction', 'transaction', 'update:incident', 'transaction', 'transaction', 'update:incident']);
});

test('transaction reads enforce the same resource boundary before reaching the underlying handle', async () => {
  const { calls, guarded } = fixture();
  const resources = guarded(grant(['incident'], ['incident']));
  for (const adapter of [resources.adapter, resources.forConnection('operations')]) {
    await adapter.transaction!(async (tx) => {
      await assert.rejects(async () => tx.query({ table: 'secret', limit: 1, offset: 0 }), AppAccessDenied);
      await assert.rejects(async () => tx.count('secret'), AppAccessDenied);
      await tx.query({ table: 'incident', limit: 1, offset: 0 });
      assert.equal(await tx.count('incident'), 0);
    });
  }
  assert.deepEqual(calls, ['transaction', 'query:incident', 'count:incident', 'transaction', 'query:incident', 'count:incident']);
});
