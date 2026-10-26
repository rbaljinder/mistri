import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  assertTenantOwnership,
  captureTenantOwnership,
  type ResourceOwnership,
  type TenantOwnershipInput,
} from '../packages/mistri/src/server/tenant/tenantOwnership.js';

type Input = {
  appId: string;
  source: { id: string; connection: string };
  schema: DatabaseSchema;
  physicalSchema: DatabaseSchema;
  resources: Record<string, string>;
  ownership: Record<string, ResourceOwnership>;
};
const secret = 'PRIVATE_TENANT_OWNERSHIP_SENTINEL';
const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: false,
  primaryKey: false,
  ...extra,
});

// Independent fixture mapping, deliberately not the production mapScopeCatalog.
function logicalSchema(physical: DatabaseSchema, resources: Record<string, string>): DatabaseSchema {
  const names = new Map(Object.entries(resources).map(([logical, target]) => [target, logical]));
  return {
    ...structuredClone(physical),
    label: 'Logical catalog',
    tables: physical.tables
      .filter((table) => names.has(table.id))
      .map((table) => ({
        ...structuredClone(table),
        id: names.get(table.id)!,
        name: names.get(table.id)!,
        schema: '',
        columns: table.columns.map((field) => ({
          ...structuredClone(field),
          ...(field.references
            ? { references: { ...field.references, table: names.get(field.references.table) ?? field.references.table } }
            : {}),
        })),
      })),
    foreignKeys: physical.foreignKeys
      .filter((fk) => names.has(fk.from.table) && names.has(fk.to.table))
      .map((fk) => ({
        ...structuredClone(fk),
        from: { ...fk.from, table: names.get(fk.from.table)!, columns: [...fk.from.columns] },
        to: { ...fk.to, table: names.get(fk.to.table)!, columns: [...fk.to.columns] },
      })),
  };
}

function input(): Input {
  const physicalSchema: DatabaseSchema = {
    dialect: 'sqlite',
    label: secret,
    readAt: '2026-09-07',
    tables: [
      {
        id: 'db_country',
        name: 'db_country',
        schema: 'main',
        isView: false,
        columns: [column('code', { primaryKey: true }), column('name')],
      },
      {
        id: 'db_item',
        name: 'db_item',
        schema: 'main',
        isView: false,
        columns: [
          column('id', { primaryKey: true }),
          column('tenant_id'),
          column('tenant_alternate'),
          column('country_code', { nullable: true, references: { table: 'db_country', column: 'code' } }),
          column('title', { default: "'untitled'", allowed: ['untitled'] }),
        ],
      },
      {
        id: 'db_note',
        name: 'db_note',
        schema: 'main',
        isView: false,
        columns: [
          column('id', { primaryKey: true }),
          column('tenant_id'),
          column('item_id', { references: { table: 'db_item', column: 'id' } }),
          column('body'),
        ],
      },
    ],
    foreignKeys: [
      {
        name: 'country',
        from: { table: 'db_item', columns: ['country_code'] },
        to: { table: 'db_country', columns: ['code'] },
        onDelete: 'restrict',
      },
      {
        name: 'owner_item',
        from: { table: 'db_note', columns: ['tenant_id', 'item_id'] },
        to: { table: 'db_item', columns: ['tenant_id', 'id'] },
        onDelete: 'restrict',
      },
    ],
  };
  const resources = { country: 'db_country', item: 'db_item', note: 'db_note' };
  return {
    appId: 'tenant-proof',
    source: { id: 'business', connection: 'private-owned-source' },
    schema: logicalSchema(physicalSchema, resources),
    physicalSchema,
    resources,
    ownership: {
      country: { kind: 'global', access: 'read-only' },
      item: { kind: 'tenant', column: 'tenant_id' },
      note: { kind: 'tenant', column: 'tenant_id' },
    },
  };
}
function synchronize(value: Input) {
  value.schema = logicalSchema(value.physicalSchema, value.resources);
}
function field(value: Input, name = 'tenant_id'): ColumnMeta {
  return value.physicalSchema.tables.find((table) => table.id === value.resources.item)!.columns.find((column) => column.name === name)!;
}
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.code, 'tenant_context_unavailable');
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(secret));
  return true;
}
function refuses(value: unknown) {
  assert.throws(() => captureTenantOwnership(value as TenantOwnershipInput), safe);
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}

test('ownership capture accepts tenant-to-tenant/global relationships and detaches the entire evidence graph', () => {
  const given = input();
  const before = structuredClone(given);
  const captured = captureTenantOwnership(given);
  frozen(captured);
  assert.deepEqual(structuredClone(captured), before);
  assert.deepEqual(given, before);
  assert.notEqual(captured.source, given.source);
  assert.notEqual(captured.schema, given.schema);
  assert.notEqual(captured.physicalSchema, given.physicalSchema);
  assert.notEqual(captured.resources, given.resources);
  assert.notEqual(captured.ownership.item, given.ownership.item);
  given.appId = 'changed';
  given.source.connection = 'rebound';
  given.resources.item = 'another';
  given.ownership.item = { kind: 'global', access: 'read-only' };
  given.schema.tables[1].columns[0].name = 'mutated';
  given.physicalSchema.foreignKeys[1].from.columns.reverse();
  given.physicalSchema.tables[1].columns.at(-1)!.allowed!.push('mutated');
  assert.deepEqual(structuredClone(captured), before);
  assert.equal(Reflect.set(captured.source, 'connection', 'forged'), false);
  assert.throws(() => captured.schema.tables.push(before.schema.tables[0]), TypeError);
  assert.doesNotThrow(() => assertTenantOwnership(captured, before));
  assert.deepEqual(Object.keys(captured).sort(), ['appId', 'source', 'schema', 'physicalSchema', 'resources', 'ownership'].sort());
});

test('ownership comparison ignores presentation and enumeration order, preserving all authority', () => {
  const before = captureTenantOwnership(input());
  const actual = input();
  actual.resources = Object.fromEntries(Object.entries(actual.resources).reverse());
  actual.ownership = Object.fromEntries(Object.entries(actual.ownership).reverse());
  for (const schema of [actual.schema, actual.physicalSchema]) {
    schema.label = 'New display label';
    schema.readAt = 'later';
    schema.tables.reverse();
    schema.foreignKeys.reverse();
    for (const table of schema.tables) {
      if (schema === actual.schema) table.name = 'Presentation';
      table.schema = '';
      table.approxRows = 1000;
      table.comment = 'New help';
      table.indexed = [];
      table.insertable = false;
      table.deletable = false;
      table.columns.reverse();
      for (const column of table.columns) {
        column.comment = 'New help';
        column.allowed = ['display'];
        column.writable = false;
      }
    }
  }
  assert.doesNotThrow(() => assertTenantOwnership(before, actual));
  assert.doesNotThrow(() => assertTenantOwnership(captureTenantOwnership(actual), before));
});

test('ownership accepts empty and main SQLite schema forms in either revalidation direction', () => {
  const main = input();
  const implicit = input();
  for (const table of implicit.physicalSchema.tables) table.schema = '';
  const mainSnapshot = captureTenantOwnership(main);
  const implicitSnapshot = captureTenantOwnership(implicit);
  assert.doesNotThrow(() => assertTenantOwnership(mainSnapshot, implicit));
  assert.doesNotThrow(() => assertTenantOwnership(implicitSnapshot, main));
  assert.equal(mainSnapshot.physicalSchema.tables[1].schema, 'main');
  assert.equal(implicitSnapshot.physicalSchema.tables[1].schema, '');
});

for (const target of ['tenant', 'global', 'unmapped'] as const) {
  for (const substitution of ['SQL name', 'attached schema'] as const) {
    test(`ownership refuses ${target} physical ${substitution} substitution with an unchanged catalog ID`, () => {
      const given = input();
      if (target === 'unmapped')
        given.physicalSchema.tables.push({
          id: 'unmapped',
          name: 'unmapped',
          schema: 'main',
          isView: false,
          columns: [column('id')],
        });
      const expected = captureTenantOwnership(given);
      const before = structuredClone(expected);
      const table = given.physicalSchema.tables.find(
        (table) => table.id === (target === 'tenant' ? 'db_item' : target === 'global' ? 'db_country' : 'unmapped'),
      )!;
      const id = table.id;
      if (substitution === 'SQL name') table.name = 'different_sql_target';
      else table.schema = 'attached';
      assert.equal(table.id, id);
      refuses(given);
      assert.throws(() => assertTenantOwnership(expected, given), safe);
      assert.deepEqual(structuredClone(expected), before, 'refusal must preserve prior ownership evidence');
    });
  }
}

test('null-prototype host data is accepted without inheriting grants', () => {
  const given = input();
  Object.setPrototypeOf(given, null);
  for (const value of [given.source, given.resources, given.ownership, ...Object.values(given.ownership)])
    Object.setPrototypeOf(value, null);
  assert.doesNotThrow(() => captureTenantOwnership(given));
});

const invalid: Array<[string, (given: Input) => void]> = [
  [
    'missing mapping',
    (given) => {
      delete given.resources.note;
    },
  ],
  [
    'extra mapping',
    (given) => {
      given.resources.extra = 'db_note';
    },
  ],
  [
    'mapping with a replaced logical key',
    (given) => {
      given.resources.other = given.resources.note;
      delete given.resources.note;
    },
  ],
  [
    'missing ownership',
    (given) => {
      delete given.ownership.note;
    },
  ],
  [
    'extra ownership',
    (given) => {
      given.ownership.extra = { kind: 'tenant', column: 'tenant_id' };
    },
  ],
  [
    'unknown physical target',
    (given) => {
      given.resources.item = secret;
    },
  ],
  [
    'duplicate physical alias',
    (given) => {
      given.resources.note = given.resources.item;
    },
  ],
  [
    'qualified logical source alias',
    (given) => {
      given.resources['business.item'] = given.resources.item;
      delete given.resources.item;
      given.ownership['business.item'] = given.ownership.item;
      delete given.ownership.item;
      synchronize(given);
    },
  ],
  [
    'non-identifier logical name',
    (given) => {
      given.resources['item-name'] = given.resources.item;
      delete given.resources.item;
      given.ownership['item-name'] = given.ownership.item;
      delete given.ownership.item;
      synchronize(given);
    },
  ],
  [
    'private logical target',
    (given) => {
      given.resources.__MISTRI_items = given.resources.item;
      delete given.resources.item;
      given.ownership.__MISTRI_items = given.ownership.item;
      delete given.ownership.item;
      synchronize(given);
    },
  ],
  [
    'private physical display name',
    (given) => {
      given.physicalSchema.tables[1].name = '__MISTRI_memberships';
    },
  ],
  [
    'private physical target identity',
    (given) => {
      given.resources.item = '__mistri_memberships';
      given.physicalSchema.tables[1].id = '__mistri_memberships';
      for (const fk of given.physicalSchema.foreignKeys) {
        if (fk.from.table === 'db_item') fk.from.table = '__mistri_memberships';
        if (fk.to.table === 'db_item') fk.to.table = '__mistri_memberships';
      }
      given.physicalSchema.tables[2].columns[2].references!.table = '__mistri_memberships';
      synchronize(given);
    },
  ],
  [
    'logical view',
    (given) => {
      given.schema.tables[1].isView = true;
    },
  ],
  [
    'physical view',
    (given) => {
      given.physicalSchema.tables[1].isView = true;
      synchronize(given);
    },
  ],
  [
    'logical dialect',
    (given) => {
      given.schema.dialect = 'postgres';
    },
  ],
  [
    'physical dialect',
    (given) => {
      given.physicalSchema.dialect = 'mysql';
    },
  ],
  [
    'unknown tenant column',
    (given) => {
      given.ownership.item = { kind: 'tenant', column: secret };
    },
  ],
  [
    'nullable tenant column',
    (given) => {
      field(given).nullable = true;
      synchronize(given);
    },
  ],
  [
    'tenant identity column',
    (given) => {
      field(given).identity = 'always';
      synchronize(given);
    },
  ],
  [
    'tenant identity by default',
    (given) => {
      field(given).identity = 'by-default';
      synchronize(given);
    },
  ],
  [
    'ownership omitted by replacing all with globals',
    (given) => {
      for (const id of Object.keys(given.ownership)) given.ownership[id] = { kind: 'global', access: 'read-only' };
    },
  ],
  [
    'unknown ownership kind',
    (given) => {
      Reflect.set(given.ownership.item, 'kind', 'inherit');
    },
  ],
  [
    'writable global',
    (given) => {
      Reflect.set(given.ownership.country, 'access', 'read-write');
    },
  ],
  [
    'global without access',
    (given) => {
      Reflect.deleteProperty(given.ownership.country, 'access');
    },
  ],
  [
    'tenant declaration with extra grants',
    (given) => {
      Reflect.set(given.ownership.item, 'write', true);
    },
  ],
  [
    'global declaration with tenant column',
    (given) => {
      Reflect.set(given.ownership.country, 'column', 'tenant_id');
    },
  ],
  [
    'extra root credential field',
    (given) => {
      Reflect.set(given, 'credentials', secret);
    },
  ],
  [
    'extra source field',
    (given) => {
      Reflect.set(given.source, 'url', secret);
    },
  ],
  [
    'logical catalog hides a physical column',
    (given) => {
      given.schema.tables[1].columns.pop();
    },
  ],
  [
    'logical catalog weakens tenant nullability evidence',
    (given) => {
      field(given).nullable = true;
    },
  ],
  [
    'logical catalog hides a physical relation',
    (given) => {
      given.schema.foreignKeys.pop();
      delete given.schema.tables[2].columns[2].references;
    },
  ],
  [
    'logical catalog forges a column type',
    (given) => {
      given.schema.tables[1].columns.at(-1)!.type = 'INTEGER';
    },
  ],
  [
    'empty catalog',
    (given) => {
      given.schema.tables = [];
      given.schema.foreignKeys = [];
      given.resources = {};
      given.ownership = {};
    },
  ],
];
for (const [name, change] of invalid)
  test(`ownership refuses ${name} with a safe error`, () => {
    const given = input();
    change(given);
    refuses(given);
  });

for (const [target, values] of [
  ['appId', ['', ' spaced', 'spaced ', 'a\0b', 'a\nb', 'a'.repeat(257), null, 1]],
  ['source.id', ['', 'main.other', 'hyphen-name', 'a'.repeat(257), {}, true]],
  ['source.connection', ['', ' trailing ', 'a\0b', 'a'.repeat(1025), [], 1]],
] as const) {
  for (const [index, value] of values.entries())
    test(`ownership refuses invalid ${target} case ${index}`, () => {
      const given = input();
      if (target === 'appId') Reflect.set(given, target, value);
      else Reflect.set(given.source, target.split('.')[1], value);
      refuses(given);
    });
}

for (const type of ['TEXT', 'text', 'VARCHAR(255)', 'CHARACTER(36)', 'CLOB', 'BLOB TEXT']) {
  test(`ownership accepts SQLite text affinity ${type}`, () => {
    const given = input();
    field(given).type = type;
    synchronize(given);
    assert.doesNotThrow(() => captureTenantOwnership(given));
  });
}
for (const type of ['INTEGER', 'TEXT INT', 'CHARINT', 'FLOATING POINT', 'NUMERIC', 'REAL', 'BLOB', '', 'STRING']) {
  test(`ownership refuses non-text or INT-precedence SQLite affinity ${JSON.stringify(type)}`, () => {
    const given = input();
    field(given).type = type;
    synchronize(given);
    refuses(given);
  });
}

test('a tenant-column default is catalog evidence, not a substitute for future runtime injection', () => {
  const given = input();
  field(given).default = "'tenant-default'";
  synchronize(given);
  const snapshot = captureTenantOwnership(given);
  assert.equal(snapshot.schema.tables[1].columns[1].default, "'tenant-default'");
});

for (const kind of ['foreign key only', 'column metadata only', 'both'] as const) {
  test(`ownership refuses global-to-tenant edges declared through ${kind}`, () => {
    const given = input();
    given.physicalSchema.tables[0].columns.push(column('private_item'));
    if (kind !== 'foreign key only') given.physicalSchema.tables[0].columns.at(-1)!.references = { table: 'db_item', column: 'id' };
    if (kind !== 'column metadata only')
      given.physicalSchema.foreignKeys.push({
        name: 'forbidden',
        from: { table: 'db_country', columns: ['private_item'] },
        to: { table: 'db_item', columns: ['id'] },
      });
    synchronize(given);
    refuses(given);
  });
}

test('unmapped disjoint physical tables remain unexposed, but a relationship across that boundary refuses', () => {
  const given = input();
  given.physicalSchema.tables.push({
    id: '__mistri_memberships',
    name: '__mistri_memberships',
    schema: 'main',
    isView: false,
    columns: [column('id', { primaryKey: true })],
  });
  const snapshot = captureTenantOwnership(given);
  assert.equal(Object.hasOwn(snapshot.resources, '__mistri_memberships'), false);
  assert.equal(snapshot.schema.tables.length, 3);
  given.physicalSchema.tables.at(-1)!.columns.push(column('item_id', { references: { table: 'db_item', column: 'id' } }));
  refuses(given);
});

const drifts: Array<[string, (given: Input) => void]> = [
  [
    'App identity',
    (given) => {
      given.appId = 'another-app';
    },
  ],
  [
    'source identity',
    (given) => {
      given.source.id = 'anotherSource';
    },
  ],
  [
    'connection owner',
    (given) => {
      given.source.connection = 'another-owner';
    },
  ],
  [
    'ownership column',
    (given) => {
      given.ownership.item = { kind: 'tenant', column: 'tenant_alternate' };
    },
  ],
  [
    'ownership kind',
    (given) => {
      given.ownership.item = { kind: 'global', access: 'read-only' };
    },
  ],
  [
    'stored column type',
    (given) => {
      field(given, 'title').type = 'CLOB';
      synchronize(given);
    },
  ],
  [
    'stored column default',
    (given) => {
      field(given, 'title').default = "'changed'";
      synchronize(given);
    },
  ],
  [
    'stored column nullability',
    (given) => {
      field(given, 'title').nullable = true;
      synchronize(given);
    },
  ],
  [
    'stored primary key',
    (given) => {
      field(given, 'title').primaryKey = true;
      synchronize(given);
    },
  ],
  [
    'stored column addition',
    (given) => {
      given.physicalSchema.tables[1].columns.push(column('new_column'));
      synchronize(given);
    },
  ],
  [
    'stored column removal',
    (given) => {
      given.physicalSchema.tables[1].columns.pop();
      synchronize(given);
    },
  ],
  [
    'foreign key action',
    (given) => {
      given.physicalSchema.foreignKeys[1].onDelete = 'cascade';
      synchronize(given);
    },
  ],
  [
    'foreign key constraint name',
    (given) => {
      given.physicalSchema.foreignKeys[1].name = 'replacement';
      synchronize(given);
    },
  ],
  [
    'composite foreign key component order',
    (given) => {
      given.physicalSchema.foreignKeys[1].from.columns.reverse();
      given.physicalSchema.foreignKeys[1].to.columns.reverse();
      synchronize(given);
    },
  ],
  [
    'column-reference destination',
    (given) => {
      field(given, 'country_code').references!.column = 'name';
      synchronize(given);
    },
  ],
  [
    'unmapped physical catalog addition',
    (given) => {
      given.physicalSchema.tables.push({ id: 'unmapped', name: 'unmapped', schema: 'main', isView: false, columns: [column('id')] });
    },
  ],
];
for (const [name, change] of drifts)
  test(`ownership revalidation rejects ${name} drift even when the new input is independently valid`, () => {
    const expected = captureTenantOwnership(input());
    const before = structuredClone(expected);
    const actual = input();
    change(actual);
    assert.doesNotThrow(() => captureTenantOwnership(actual));
    assert.throws(() => assertTenantOwnership(expected, actual), safe);
    assert.deepEqual(structuredClone(expected), before, 'failed validation cannot mutate the prior evidence');
  });

test('ownership revalidation rejects a same-shaped physical target substitution', () => {
  const given = input();
  // Use a standalone tenant resource so both possible mappings are valid, not
  // merely rejected because a relationship was lost during the substitution.
  given.physicalSchema = {
    ...given.physicalSchema,
    foreignKeys: [],
    tables: ['one', 'two'].map((id) => ({
      id,
      name: id,
      schema: 'main',
      isView: false,
      columns: [column('id', { primaryKey: true }), column('tenant_id')],
    })),
  };
  given.resources = { item: 'one' };
  given.ownership = { item: { kind: 'tenant', column: 'tenant_id' } };
  synchronize(given);
  const expected = captureTenantOwnership(given);
  given.resources.item = 'two';
  synchronize(given);
  assert.doesNotThrow(() => captureTenantOwnership(given));
  assert.throws(() => assertTenantOwnership(expected, given), safe);
});

type Placement = { name: string; replace(given: Input, wrap: (value: object) => object): unknown };
const placements: Placement[] = [
  { name: 'root', replace: (given, wrap) => wrap(given) },
  ...(['source', 'resources', 'ownership', 'schema', 'physicalSchema'] as const).map((name) => ({
    name,
    replace: (given: Input, wrap: (value: object) => object) => {
      Reflect.set(given, name, wrap(given[name]));
      return given;
    },
  })),
  {
    name: 'ownership entry',
    replace: (given, wrap) => {
      Reflect.set(given.ownership, 'item', wrap(given.ownership.item));
      return given;
    },
  },
  {
    name: 'catalog array',
    replace: (given, wrap) => {
      Reflect.set(given.schema, 'tables', wrap(given.schema.tables));
      return given;
    },
  },
  {
    name: 'column metadata',
    replace: (given, wrap) => {
      Reflect.set(given.schema.tables[1].columns, '1', wrap(given.schema.tables[1].columns[1]));
      return given;
    },
  },
];
for (const placement of placements) {
  test(`ownership refuses ${placement.name} proxies without executing any trap`, () => {
    let traps = 0;
    const trap = (): never => {
      traps++;
      throw new Error(secret);
    };
    const value = placement.replace(
      input(),
      (original) =>
        new Proxy(original, {
          get: trap,
          getPrototypeOf: trap,
          ownKeys: trap,
          getOwnPropertyDescriptor: trap,
          isExtensible: trap,
        }),
    );
    refuses(value);
    assert.throws(() => assertTenantOwnership(captureTenantOwnership(input()), value as TenantOwnershipInput), safe);
    assert.equal(traps, 0);
  });
  test(`ownership refuses ${placement.name} getters without invoking them`, () => {
    let getters = 0;
    const value = placement.replace(input(), (original) => {
      const copy = Array.isArray(original) ? [...original] : { ...original };
      Object.defineProperty(copy, Object.keys(copy)[0], {
        enumerable: true,
        configurable: true,
        get() {
          getters++;
          throw new Error(secret);
        },
      });
      return copy;
    });
    refuses(value);
    assert.equal(getters, 0);
  });
}

for (const [name, malformed] of [
  ['null', () => null],
  ['array root', () => []],
  ['function', () => () => {}],
  [
    'symbol key',
    () => {
      const value = input();
      Reflect.set(value.source, Symbol('secret'), secret);
      return value;
    },
  ],
  [
    'hidden field',
    () => {
      const value = input();
      Object.defineProperty(value.source, 'secret', { value: secret });
      return value;
    },
  ],
  [
    'sparse catalog',
    () => {
      const value = input();
      Reflect.deleteProperty(value.schema.tables, '1');
      return value;
    },
  ],
  [
    'nonfinite data',
    () => {
      const value = input();
      value.schema.tables[0].approxRows = Infinity;
      return value;
    },
  ],
  [
    'cyclic data',
    () => {
      const value = input();
      Reflect.set(value.source, 'cycle', value);
      return value;
    },
  ],
  [
    'thenable data',
    () => {
      const value = input();
      Reflect.set(value.source, 'then', () => assert.fail('must not assimilate'));
      return value;
    },
  ],
  [
    'revoked proxy',
    () => {
      const value = Proxy.revocable(input(), {});
      value.revoke();
      return value.proxy;
    },
  ],
] as const)
  test(`ownership safely refuses ${name}`, () => refuses(malformed()));

test('ownership refuses inherited authority without reading inherited getters', () => {
  const given = input();
  let reads = 0;
  given.ownership = Object.create({
    get item() {
      reads++;
      throw new Error(secret);
    },
  });
  refuses(given);
  assert.equal(reads, 0);
});

for (const size of [256, 257])
  test(`ownership ${size === 256 ? 'accepts' : 'refuses'} ${size} logical resources`, () => {
    const given = input();
    given.physicalSchema.tables = Array.from({ length: size }, (_, index) => ({
      id: `physical_${index}`,
      name: `physical_${index}`,
      schema: 'main',
      isView: false,
      columns: [column('id', { primaryKey: true }), column('tenant_id')],
    }));
    given.physicalSchema.foreignKeys = [];
    given.resources = Object.fromEntries(given.physicalSchema.tables.map((table, index) => [`resource_${index}`, table.id]));
    given.ownership = Object.fromEntries(Object.keys(given.resources).map((id) => [id, { kind: 'tenant', column: 'tenant_id' }]));
    synchronize(given);
    if (size === 256) assert.doesNotThrow(() => captureTenantOwnership(given));
    else refuses(given);
  });

for (const ddl of [
  'ALTER TABLE db_item ADD COLUMN extra TEXT',
  'ALTER TABLE db_item DROP COLUMN title',
  'ALTER TABLE db_item RENAME COLUMN tenant_id TO owner_id',
  'CREATE TABLE newly_visible(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)',
]) {
  test(`fresh SQLite catalog rejects DDL drift: ${ddl}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'new');
        INSERT INTO db_item VALUES ('same-business-id', 'tenant-A', 'preserved');`);
      const given = input();
      given.resources = { item: 'db_item' };
      given.ownership = { item: { kind: 'tenant', column: 'tenant_id' } };
      given.physicalSchema = readSqliteScopeCatalog(db).schema;
      synchronize(given);
      const captured = captureTenantOwnership(given);
      assert.doesNotThrow(() => assertTenantOwnership(captured, given));
      db.exec(ddl);
      given.physicalSchema = readSqliteScopeCatalog(db).schema;
      synchronize(given);
      assert.throws(() => assertTenantOwnership(captured, given), safe);
      assert.equal(db.prepare('SELECT id FROM db_item').get()?.id, 'same-business-id');
      assert.equal(captured.schema.tables[0].columns.find((column) => column.name === 'tenant_id')?.nullable, false);
    } finally {
      db.close();
    }
  });
}
