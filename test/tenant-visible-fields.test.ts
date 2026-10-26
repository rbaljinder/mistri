import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { accessibleSchema, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { tenantAuthoringSchema, tenantVisibleFields } from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';

function fixture() {
  const column = (name: string, primaryKey = false) => ({ name, type: 'TEXT', nullable: false, primaryKey });
  const physicalSchema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'Private schema',
    readAt: '',
    tables: [
      {
        id: 'db_item',
        name: 'db_item',
        schema: 'main',
        isView: false,
        indexed: ['owner', 'name'],
        columns: [
          column('id', true),
          column('owner'),
          column('name'),
          column('private_note'),
          { ...column('parent_id'), references: { table: 'db_catalog', column: 'id' } },
        ],
      },
      {
        id: 'db_catalog',
        name: 'db_catalog',
        schema: 'main',
        isView: false,
        columns: [column('id', true), column('owner'), column('name')],
      },
    ],
    foreignKeys: [
      {
        name: 'private-edge',
        from: { table: 'db_item', columns: ['owner', 'parent_id'] },
        to: { table: 'db_catalog', columns: ['owner', 'id'] },
      },
    ],
  };
  const resources = { item: 'db_item', catalog: 'db_catalog' };
  const schema = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([logical, physical]) => [physical, logical])));
  return captureTenantOwnership({
    appId: 'app',
    source: { id: 'business', connection: 'db' },
    physicalSchema,
    schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'owner' }, catalog: { kind: 'global', access: 'read-only' } },
  });
}
const names = (schema: DatabaseSchema, id = 'item') => schema.tables.find((table) => table.id === id)!.columns.map((column) => column.name);

test('managed fields come from attested ownership, not a hard-coded column name or authored field rules', () => {
  const owned = fixture(),
    original = structuredClone(owned.schema);
  const projected = tenantAuthoringSchema(owned);
  assert.deepEqual(names(projected), ['id', 'name', 'private_note', 'parent_id']);
  assert.deepEqual(names(projected, 'catalog'), ['id', 'owner', 'name'], 'same-named global field is ordinary data');
  assert.deepEqual(owned.schema, original);
});

test('authoring still sees every ordinary NOT NULL requirement; no invented database defaults', () => {
  const projected = tenantAuthoringSchema(fixture());
  const name = projected.tables[0].columns.find((column) => column.name === 'name')!;
  assert.equal(name.nullable, false);
  assert.equal(name.default, undefined);
  assert.equal(projected.tables[0].columns.find((column) => column.name === 'id')!.primaryKey, true);
});

test('hidden managed join components cannot leave readable edge metadata or indexed hints', () => {
  const projected = tenantAuthoringSchema(fixture());
  /* The composite edge names `owner`, so it leaves. Its other leg stays a link
     (G17, shared/declaredReferences.ts impliedEdges): `catalog.id` is unique
     alone, so `parent_id` alone says which row. The leg is named by what it
     joins, and nothing left in the catalog names the managed column. */
  assert.deepEqual(JSON.parse(JSON.stringify(projected.foreignKeys)), [
    {
      name: 'item.parent_id->catalog',
      from: { table: 'item', columns: ['parent_id'] },
      to: { table: 'catalog', columns: ['id'] },
      declared: true,
    },
  ]);
  assert.deepEqual(projected.tables[0].columns.find((column) => column.name === 'parent_id')!.references, {
    table: 'catalog',
    column: 'id',
  });
  assert.ok(!JSON.stringify(projected.foreignKeys).includes('owner'));
  assert.deepEqual(projected.tables[0].indexed, ['name']);
});

test('role field ceilings and inaccessible resources survive managed-field subtraction', () => {
  const owned = fixture();
  const access: ResourceAccess = {
    readable: new Set(['item']),
    writable: new Set(['item']),
    fields: new Map([['item', { read: new Set(['id', 'owner', 'name']), write: new Set(['owner', 'name']) }]]),
  };
  const visible = tenantVisibleFields(owned, access),
    schema = accessibleSchema(owned.schema, visible);
  assert.deepEqual(names(schema), ['id', 'name']);
  assert.equal(schema.tables.length, 1);
  assert.deepEqual([...visible.fields!.get('item')!.write], ['name']);
  assert.equal(access.fields!.get('item')!.read.has('owner'), true, 'must not mutate the captured grants');
});

test('read-only and empty grants cannot gain writes or resource access through projection', () => {
  const owned = fixture();
  for (const readable of [new Set<string>(), new Set(['item'])]) {
    const visible = tenantVisibleFields(owned, { readable, writable: new Set() });
    assert.deepEqual(
      [...visible.fields!.values()].map((scope) => scope.write.size),
      readable.size ? [0] : [],
    );
    assert.equal(accessibleSchema(owned.schema, visible).tables.length, readable.size);
  }
});

test('managed composite keys stay complete and read-only instead of silently becoming smaller keys', () => {
  const given = structuredClone(fixture());
  for (const schema of [given.schema, given.physicalSchema]) {
    schema.tables[0].columns.find((column) => column.name === 'owner')!.primaryKey = true;
  }
  const owned = captureTenantOwnership(given),
    visible = tenantAuthoringSchema(owned);
  assert.deepEqual(
    visible.tables[0].columns.filter((column) => column.primaryKey).map((column) => column.name),
    ['id', 'owner'],
  );
  assert.equal(visible.tables[0].columns.find((column) => column.name === 'owner')!.writable, false);
  assert.equal(visible.foreignKeys.length, 1);
  const fields = new Map([['item', { read: new Set(['id', 'name']), write: new Set(['name']) }]]);
  const projected = tenantVisibleFields(owned, { readable: new Set(['item']), writable: new Set(['item']), fields });
  assert.equal(projected.fields!.get('item')!.read.has('owner'), false, 'projection never widens explicit hidden-key grants');
});
