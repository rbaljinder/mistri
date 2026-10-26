import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: name === 'id' || name === 'amount' ? 'INTEGER' : 'TEXT',
  primaryKey: name === 'id',
  nullable: false,
  ...extra,
});
const schema = (): DatabaseSchema => ({
  label: 'Logical',
  dialect: 'sqlite',
  readAt: '2000-01-01',
  tables: [
    {
      id: 'lead',
      name: 'lead',
      schema: '',
      isView: false,
      columns: ['id', 'status', 'owner_id', 'amount', 'secret'].map((name) => column(name)),
    },
    { id: 'person', name: 'person', schema: '', isView: false, columns: ['id', 'name', 'secret'].map((name) => column(name)) },
  ],
  foreignKeys: [{ name: 'lead_owner', from: { table: 'lead', columns: ['owner_id'] }, to: { table: 'person', columns: ['id'] } }],
});
function app(): AppDef {
  return parseTestApp(
    {
      name: 'Catalog',
      resources: { lead: {}, person: {} },
      auth: { roles: { reader: { read: true }, limited: { read: ['lead'] } } },
      views: { leads: { kind: 'list', from: 'lead', query: 'status = new', show: ['secret'] } },
      home: 'leads',
    },
    'fixture',
  );
}
function exposure(extra: Record<string, unknown> = {}) {
  return parseTestApi(
    {
      version: 1,
      roles: ['reader', 'limited'],
      resources: { lead: { fields: ['id', 'status', 'owner_id.name', 'amount'], filters: ['status'], sorts: ['id'] } },
      ...extra,
    },
    ['reader', 'limited'],
  )!;
}
const check = (api = exposure(), definition = app(), catalog = schema()) => checkApiReadCatalog(api, definition, catalog);

test('explicit read catalog uses logical paths, full-role authority and immutable non-wire facts', () => {
  const api = exposure({ views: ['leads'] }),
    definition = app(),
    catalog = schema();
  const before = structuredClone({ api, definition, catalog });
  const result = check(api, definition, catalog);
  assert.equal(result.stage, 'read-validation-foundation');
  assert.deepEqual(
    result.operations.map((item) => item.id),
    ['list:lead', 'item:lead', 'view:leads'],
  );
  for (const operation of result.operations) {
    assert.deepEqual(operation.filters, ['status']);
    assert.deepEqual(operation.sorts, ['id']);
    assert.ok(Object.isFrozen(operation.filters) && Object.isFrozen(operation.sorts));
    assert.deepEqual(operation.fields, ['id', 'status', 'owner_id.name', 'amount']);
    assert.deepEqual(operation.eligibleRoles, ['reader']);
    assert.deepEqual(operation.dependencies, [
      { resource: 'lead', fields: ['amount', 'id', 'owner_id', 'status'] },
      { resource: 'person', fields: ['id', 'name'] },
    ]);
    assert.ok(Object.isFrozen(operation) && Object.isFrozen(operation.fields) && Object.isFrozen(operation.dependencies[0].fields));
  }
  assert.deepEqual({ api, definition, catalog }, before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.operations));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('schema additions and UI presentation do not expand published read shape', () => {
  const definition = app(),
    catalog = schema(),
    api = exposure({ views: ['leads'] });
  const before = check(api, definition, catalog);
  catalog.tables[0].columns.push(column('private_new_column'));
  definition.views.leads = { ...definition.views.leads, label: 'Another label', show: ['private_new_column'] };
  assert.deepEqual(check(api, definition, catalog), before);
  api.resources.lead.fields.push('private_new_column');
  assert.notDeepEqual(check(api, definition, catalog), before);
});

test('every component of a primary key is explicit and present', () => {
  const catalog = schema();
  catalog.tables[0].columns[1].primaryKey = true;
  const api = exposure();
  api.resources.lead.fields = ['id', 'amount'];
  api.resources.lead.filters = [];
  assert.throws(() => check(api, app(), catalog), /complete.*primary key/);
  catalog.tables[0].columns.forEach((item) => {
    item.primaryKey = false;
  });
  assert.throws(() => check(exposure(), app(), catalog), /complete.*primary key/);
});

test('unknown paths, undeclared hops, terminal ceilings and join ceilings are refused', () => {
  const api = exposure();
  api.resources.lead.fields.push('owner_id.missing');
  assert.throws(() => check(api), /missing/);
  const definition = app();
  delete definition.resources!.person;
  definition.auth!.roles!.reader.read = ['lead'];
  assert.throws(() => check(exposure(), definition), /undeclared resource/);
  for (const fields of [['id'], ['id', 'secret']]) {
    const narrowed = app();
    narrowed.resources!.person.fields = { read: fields };
    assert.throws(() => check(exposure(), narrowed), /read ceiling/);
  }
  const local = app();
  local.resources!.lead.fields = { read: ['id', 'status', 'amount'] };
  assert.throws(() => check(exposure(), local), /read ceiling/);
});

test('a nullable column may be a sort; a reference path may not', () => {
  const api = exposure();
  api.resources.lead.sorts.push('owner_id.name');
  assert.throws(() => check(api), /goes through a reference join/);
  const own = exposure(),
    catalog = schema();
  catalog.tables[0].columns.find((item) => item.name === 'amount')!.nullable = true;
  own.resources.lead.sorts.push('amount');
  assert.ok(check(own, app(), catalog).operations.some((operation) => operation.sorts?.includes('amount')));
});

test('file bytes are refused both as output and as hidden join dependencies', () => {
  const definition = app();
  definition.resources!.person.file = { content: 'name', name: 'secret' };
  assert.throws(() => check(exposure(), definition), /file content/);
  definition.resources!.person.file.content = 'id';
  assert.throws(() => check(exposure(), definition), /file content/);
});

test('a union of separate partial roles does not make a whole-shape eligible role', () => {
  const definition = app();
  definition.auth!.roles!.reader.read = ['person'];
  assert.throws(() => check(exposure(), definition), /no declared API role/);
});

test('field-limited roles cannot read a hidden join, and narrower shapes keep their eligible roles', () => {
  const definition = app();
  definition.auth!.roles!.reader.fields = { lead: { read: ['id', 'status', 'amount'] } };
  assert.throws(() => check(exposure(), definition), /no declared API role/);
  const api = exposure({ resources: { lead: { fields: ['id', 'status'] } } });
  assert.deepEqual(check(api, definition).operations[0].eligibleRoles, ['limited', 'reader']);
});

test('composite relationship components are checked even when the path names one hop', () => {
  const catalog = schema();
  catalog.tables[0].columns.push(column('owner_region'));
  catalog.tables[1].columns.push(column('region'));
  catalog.foreignKeys[0] = {
    name: 'owner',
    from: { table: 'lead', columns: ['owner_id', 'owner_region'] },
    to: { table: 'person', columns: ['id', 'region'] },
  };
  const api = exposure({ resources: { lead: { fields: ['id', 'owner.name'] } } });
  const result = check(api, app(), catalog);
  assert.deepEqual(result.operations[0].dependencies, [
    { resource: 'lead', fields: ['id', 'owner_id', 'owner_region'] },
    { resource: 'person', fields: ['id', 'name', 'region'] },
  ]);
  const definition = app();
  definition.resources!.person.fields = { read: ['id', 'name'] };
  assert.throws(() => check(api, definition, catalog), /region.*read ceiling/);
});

test('parameter-only view dependencies and every tab remain under explicit exposure', () => {
  for (const extra of [
    { query: 'secret = hidden' },
    { tabs: [{ label: 'New' }, { label: 'Hidden', query: 'secret = hidden' }] },
    { filters: ['secret'] },
    { sort: 'secret' },
    { sorts: [{ label: 'Hidden', sort: 'secret' }] },
    { totals: ['secret'] },
    { order: 'secret' },
  ]) {
    const definition = app();
    Object.assign(definition.views.leads, extra);
    assert.throws(() => check(exposure({ views: ['leads'] }), definition), /not an exposed field/);
  }
});

test('valid view variants are checked together without publishing UI show', () => {
  const definition = app();
  Object.assign(definition.views.leads, {
    filters: ['status'],
    totals: ['amount'],
    sort: 'amount desc',
    sorts: [{ label: 'By amount', sort: 'amount' }],
    tabs: [
      { label: 'Big', query: 'amount > 100' },
      { label: 'Small', query: 'amount <= 100' },
    ],
  });
  assert.equal(check(exposure({ views: ['leads'] }), definition).operations[2].id, 'view:leads');
  Object.assign(definition.views.leads, { totals: ['status'] });
  assert.throws(() => check(exposure({ views: ['leads'] }), definition), /not numeric/);
});

test('standing projection rewrites and hidden implicit sort fields fail closed', () => {
  const definition = app();
  Object.assign(definition.views.leads, { query: 'show secret' });
  assert.throws(() => check(exposure({ views: ['leads'] }), definition), /projection/);
  const catalog = schema();
  catalog.tables[0].columns.push(column('updated_at', { type: 'TIMESTAMP' }));
  catalog.tables[0].indexed = ['updated_at'];
  assert.throws(() => check(exposure(), app(), catalog), /not an exposed field/);
});

test('unknown/non-list views and unexposed bases are refused', () => {
  assert.throws(() => check(exposure({ views: ['missing'] })), /declared list/);
  const definition = app();
  definition.views.leads = { kind: 'dashboard', sections: [] } as never;
  assert.throws(() => check(exposure({ views: ['leads'] }), definition), /declared list/);
  assert.throws(() => check(exposure({ resources: {}, views: ['leads'] })), /must be explicitly exposed/);
});

test('unsupported authority/transport stages are explicit and do not affect ordinary parsing', () => {
  // A row policy narrows rows when a read runs, never the catalog; a tenant App's is its tenant catalog.
  const policy = app();
  policy.auth!.rows = 'policy';
  assert.ok(check(exposure(), policy).operations.length);
  const tenant = app();
  tenant.auth!.rows = 'tenant';
  assert.throws(() => check(exposure(), tenant), /tenant contexts/);
  const catalog = schema();
  catalog.dialect = 'http';
  assert.throws(() => check(exposure(), app(), catalog), /non-SQL/);
  const api = exposure({ commands: [{ id: 'run', version: 1, input: {} }] });
  assert.throws(() => check(api), /command registry/);
  // Several sources: each table carries its own source's dialect, and a hop between connections is stitched.
  const stamped = (lead: DatabaseSchema['dialect'], stitched = false): DatabaseSchema => {
    const several = schema();
    several.tables = several.tables.map((table) => ({ ...table, sourceDialect: table.id === 'lead' ? lead : 'sqlite' }));
    if (stitched) several.foreignKeys = several.foreignKeys.map((edge) => ({ ...edge, stitched: true as const }));
    return several;
  };
  assert.equal(check(exposure(), app(), stamped('sqlite')).operations.length, 2);
  assert.throws(() => check(exposure(), app(), stamped('http')), /"lead" is read from a http source.*\[api-source-unsupported\]/);
  assert.throws(() => check(exposure(), app(), stamped('sqlite', true)), /"owner_id\.name" reaches "person".*\[api-multi-source\]/);
  const unstamped = stamped('sqlite');
  delete unstamped.tables[1].sourceDialect;
  assert.throws(() => check(exposure(), app(), unstamped));
  assert.equal(app().auth?.rows, 'all');
});
