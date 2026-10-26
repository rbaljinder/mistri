import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { createApiReadRowCodec } from '../packages/mistri/src/server/api/apiReadRowCodec.js';
import { apiValueCodec, apiIntegerRepresentation } from '../packages/mistri/src/server/api/apiValueCodec.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { ColumnMeta, DatabaseSchema, Dialect } from '../packages/engine/src/shared/schema.js';

const ajv = new Ajv2020({ strict: true });
function fixture(dialect: Dialect = 'postgres', valueType = 'text') {
  const column = (name: string, type: string): ColumnMeta => ({ name, type, primaryKey: name === 'id', nullable: false });
  const schema: DatabaseSchema = {
    dialect,
    label: 'Logical',
    readAt: '2000-01-01',
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          column('id', 'bigint'),
          column('name', valueType),
          column('owner_id', 'bigint'),
          column('score', 'real'),
          column('enabled', 'boolean'),
        ],
      },
      { id: 'person', name: 'person', schema: '', isView: false, columns: [column('id', 'bigint'), column('name', 'text')] },
    ],
    foreignKeys: [{ name: 'owner', from: { table: 'item', columns: ['owner_id'] }, to: { table: 'person', columns: ['id'] } }],
  };
  const fields = ['id', 'name', 'owner_id.name', 'score', ...(dialect === 'postgres' ? ['enabled'] : [])];
  const app = parseAppConfig(
    {
      name: 'Rows',
      resources: { item: {}, person: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['reader'], resources: { item: { fields, sorts: ['id'] } } },
    },
    'fixture',
  );
  const operation = checkApiReadCatalog(app.api!, app, schema).operations[0];
  return { schema, operation };
}
const row = () => ({
  id: '9007199254740993',
  name: 'Visible',
  'owner_id.name': 'Owner',
  score: 1.5,
  enabled: true,
  secret: 'never returned',
});

test('DATE row values stay canonical text and joined date nullability remains a row-only fact', () => {
  const f = fixture('postgres', 'date');
  f.schema.tables[1].columns[1].type = 'date';
  const codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
  const encoded = codec.encodeRow({ ...row(), name: '0001-01-01', 'owner_id.name': null });
  assert.equal(encoded.name, '0001-01-01');
  assert.equal(encoded['owner_id.name'], null);
  assert.equal(ajv.compile(codec.schema)(encoded), true);
  assert.throws(() => codec.encodeRow({ ...row(), name: '1900-02-29', 'owner_id.name': null }));
});

test('projected row codec and closed JSON Schema preserve int64 decimal strings without hidden fields', () => {
  const f = fixture(),
    codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
  const value = codec.encodeRow(row()),
    validate = ajv.compile(codec.schema);
  assert.equal(codec.stage, 'read-row-wire-codec');
  assert.equal(codec.envelopeValidation, 'pending');
  assert.equal(value.id, '9007199254740993');
  assert.equal(Object.hasOwn(value, 'secret'), false);
  assert.deepEqual(Object.keys(value), [...f.operation.fields]);
  assert.ok(Object.isFrozen(value));
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, secret: 'leak' }), false);
  assert.equal(validate({ ...value, id: 9007199254740992 }), false);
  assert.equal(validate({ ...value, id: '9223372036854775808' }), false);
});

test('integer representation is explicit, safe-number mode refuses large integers and floating strings', () => {
  const f = fixture();
  assert.throws(() => createApiReadRowCodec(f.operation, f.schema, {} as never));
  assert.throws(() => createApiReadRowCodec(f.operation, f.schema, undefined as never));
  const codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'number' }),
    valid = ajv.compile(codec.schema);
  const value = codec.encodeRow({ ...row(), id: '9007199254740991' });
  assert.equal(value.id, Number.MAX_SAFE_INTEGER);
  assert.equal(valid(value), true);
  assert.ok(Object.is(codec.encodeRow({ ...row(), id: 1, score: -0 }).score, 0));
  for (const id of ['9007199254740993', 9007199254740992, 2n, '01', '1.5']) assert.throws(() => codec.encodeRow({ ...row(), id }));
  for (const score of ['1.5', NaN, Infinity, -Infinity]) assert.throws(() => codec.encodeRow({ ...row(), id: 1, score }));
});

test('known textual and signed integer adapter values encode across SQL dialects without coercion', () => {
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    const f = fixture(dialect),
      codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
    const valid = ajv.compile(codec.schema);
    for (const id of ['-9223372036854775808', '9223372036854775807', 0, 23]) {
      assert.equal(valid(codec.encodeRow({ ...row(), id })), true);
    }
    for (const name of [0, false, undefined, {}, new Date()]) assert.throws(() => codec.encodeRow({ ...row(), name }));
    f.schema.tables[0].columns[1].nullable = true;
    const nullable = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
    assert.equal(ajv.compile(nullable.schema)(nullable.encodeRow({ ...row(), name: null })), true);
  }
});

test('LEFT JOIN paths are nullable despite nonnull metadata; missing projected keys are never optional', () => {
  const f = fixture(),
    codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' }),
    valid = ajv.compile(codec.schema);
  assert.equal(valid(codec.encodeRow({ ...row(), 'owner_id.name': null })), true);
  assert.throws(() => codec.encodeRow({ ...row(), name: null }));
  const missing = row();
  delete (missing as Partial<typeof missing>)['owner_id.name'];
  assert.throws(() => codec.encodeRow(missing));
  assert.equal(valid(missing), false);
  assert.throws(() => codec.encodeRow({ ...row(), id: null }));
  f.schema.tables[0].columns[0].nullable = true;
  assert.throws(() => createApiReadRowCodec(f.operation, f.schema, { integers: 'number' }));
});

test('row descriptors cannot execute getters and null-prototype adapter rows remain supported', () => {
  const f = fixture(),
    codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
  let calls = 0;
  const hidden = Object.defineProperty(row(), 'hiddenGetter', {
    get() {
      calls++;
      throw new Error('hidden');
    },
  });
  codec.encodeRow(hidden);
  assert.equal(calls, 0);
  Object.defineProperty(hidden, 'name', {
    get() {
      calls++;
      return 'No';
    },
  });
  assert.throws(() => codec.encodeRow(hidden));
  assert.equal(calls, 0);
  assert.ok(codec.encodeRow(Object.assign(Object.create(null), row())));
  assert.throws(() => codec.encodeRow(new Proxy(row(), {})));
  assert.throws(() => codec.encodeRow(Object.create(row())));
  assert.throws(() => codec.encodeRow({ ...row(), enabled: 1 }));
});

test('numeric is exact decimal text and timestamptz is an RFC 3339 instant, each saying its format', () => {
  const formats = new Ajv2020({ strict: true });
  formats.addFormat('decimal', true);
  formats.addFormat('date-time', true);
  for (const [dialect, type] of [
    ['postgres', 'numeric(20,2)'],
    ['mysql', 'decimal(10,2)'],
    ['postgres', 'numeric'],
  ] as const) {
    const f = fixture(dialect, type),
      codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
    const name = codec.schema.properties.name as { format: string };
    assert.equal(name.format, 'decimal');
    const value = codec.encodeRow({ ...row(), name: '-1650.00', enabled: dialect === 'postgres' ? true : undefined });
    assert.equal(value.name, '-1650.00');
    assert.equal(formats.compile(codec.schema)(value), true);
    for (const bad of [1650, '1e3', 'NaN', '', '01.5', '1,5']) assert.throws(() => codec.encodeRow({ ...row(), name: bad }), String(bad));
  }
  const f = fixture('postgres', 'timestamptz'),
    codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
  assert.equal((codec.schema.properties.name as { format: string }).format, 'date-time');
  const at = (name: unknown) => codec.encodeRow({ ...row(), name }).name;
  assert.equal(at('2026-10-04 07:21:00+00'), '2026-10-04T07:21:00Z');
  assert.equal(at('2026-10-04 07:21:00.123456+05:30'), '2026-10-04T07:21:00.123456+05:30');
  assert.equal(at('2026-10-04 07:21:00-07'), '2026-10-04T07:21:00-07:00');
  assert.equal(at(new Date('2026-10-04T07:21:00Z')), '2026-10-04T07:21:00.000Z');
  assert.equal(formats.compile(codec.schema)(codec.encodeRow({ ...row(), name: '2026-10-04 07:21:00+00' })), true);
  for (const bad of ['infinity', '2026-10-04', '2026-02-30 00:00:00+00', '2026-10-04 07:21:00', 5, new Date(NaN)])
    assert.throws(() => at(bad), String(bad));
  // The same type is refused where the dialect has no such promise.
  assert.throws(() => fixture('mysql', 'timestamptz'));
});

test('unsupported database representations refuse construction instead of guessing', () => {
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    for (const type of [
      ...(dialect === 'sqlite' ? ['numeric', 'decimal(20,2)'] : []),
      'money',
      'bigint unsigned',
      'blob',
      'bytea',
      'timestamp',
      'time',
      'custom_type',
    ]) {
      // The catalog says it first, at check; the codec says it again to a caller that skipped the check.
      assert.throws(() => fixture(dialect, type), `${dialect} ${type}`);
    }
  }
  for (const [dialect, type] of [
    ['sqlite', 'BOOLEAN'],
    ['mysql', 'tinyint(1)'],
    ['mysql', 'bit(1)'],
  ] as const) {
    assert.throws(() => fixture(dialect, type));
  }
  for (const type of ['clob', 'nvarchar', 'nchar']) assert.throws(() => fixture('postgres', type));
});

test('captured projection/schema/options cannot change later output or admit incomplete keys', () => {
  const f = fixture(),
    operation = { ...f.operation, fields: [...f.operation.fields] },
    options = { integers: 'decimal-string' as const };
  const codec = createApiReadRowCodec(operation, f.schema, options);
  operation.fields.push('secret');
  f.schema.tables[0].columns[1].type = 'json';
  Object.defineProperty(options, 'integers', { value: 'number' });
  assert.equal(codec.encodeRow(row()).id, '9007199254740993');
  assert.equal(Object.hasOwn(codec.schema.properties, 'secret'), false);
  assert.ok(Object.isFrozen(codec.schema.properties) && Object.isFrozen(codec.schema.required));
  assert.throws(() => createApiReadRowCodec({ ...f.operation, fields: ['name'] }, f.schema, { integers: 'number' }));
});

test('catalog allowed values use the same text/integer encoding in schema and rows', () => {
  const f = fixture();
  f.schema.tables[0].columns[0].allowed = ['9007199254740993', '9007199254740993', '-1'];
  f.schema.tables[0].columns[1].allowed = ['Visible', 'Visible', 'Other'];
  const codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' }),
    validate = ajv.compile(codec.schema);
  assert.equal(validate(codec.encodeRow(row())), true);
  assert.equal(validate({ ...codec.encodeRow(row()), id: '2' }), false);
  assert.throws(() => codec.encodeRow({ ...row(), id: 2 }));
  assert.throws(() => codec.encodeRow({ ...row(), name: 'Unlisted' }));
  assert.deepEqual(codec.schema.properties.id.enum, ['9007199254740993', '-1']);
  f.schema.tables[0].columns[0].allowed.push('2');
  assert.throws(() => codec.encodeRow({ ...row(), id: 2 }));
  assert.throws(() => createApiReadRowCodec(f.operation, f.schema, { integers: 'number' }));
  f.schema.tables[0].columns[0].allowed = ['1', '-1'];
  const numeric = createApiReadRowCodec(f.operation, f.schema, { integers: 'number' });
  assert.deepEqual(numeric.schema.properties.id.enum, [1, -1]);
  assert.equal(ajv.compile(numeric.schema)(numeric.encodeRow({ ...row(), id: 1 })), true);
  for (const allowed of [[], ['01'], ['9223372036854775808']]) {
    f.schema.tables[0].columns[0].allowed = allowed;
    assert.throws(() => createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' }));
  }
  f.schema.tables[0].columns[0].allowed = undefined;
  for (const index of [3, 4]) {
    f.schema.tables[0].columns[index].allowed = ['1'];
    assert.throws(() => createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' }));
    f.schema.tables[0].columns[index].allowed = undefined;
  }
});

test('malformed scalar metadata refuses sparse enums and never invokes accessors or proxies', () => {
  let calls = 0;
  const getter = {
    type: 'text',
    get allowed() {
      calls++;
      return ['one'];
    },
  };
  assert.throws(() => apiValueCodec(getter, 'postgres', 'number'));
  assert.equal(calls, 0);
  const values = ['one'];
  Object.defineProperty(values, '0', {
    get() {
      calls++;
      return 'one';
    },
  });
  const sparse = ['one'];
  delete sparse[0];
  for (const allowed of [sparse, values, new Proxy(['one'], {})]) {
    assert.throws(() => apiValueCodec({ type: 'text', allowed }, 'postgres', 'number'));
  }
  assert.equal(calls, 0);
  assert.throws(() => apiValueCodec(Object.assign(Object.create({ allowed: ['one'] }), { type: 'text' }), 'postgres', 'number'));
  assert.throws(() =>
    apiValueCodec(
      new Proxy(
        { type: 'text' },
        {
          get() {
            calls++;
            return 'text';
          },
        },
      ),
      'postgres',
      'number',
    ),
  );
  assert.throws(() =>
    apiIntegerRepresentation(
      new Proxy(
        { integers: 'number' as const },
        {
          getOwnPropertyDescriptor() {
            calls++;
            return undefined;
          },
        },
      ),
    ),
  );
  assert.equal(calls, 0);
});

test('the check refuses a column the API cannot say, and a filter or sort by an exact decimal or an instant', () => {
  const schema = (type: string): DatabaseSchema => ({
    dialect: 'postgres',
    label: 'Logical',
    readAt: '2000-01-01',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', primaryKey: true, nullable: false },
          { name: 'amount', type, primaryKey: false, nullable: false },
        ],
      },
    ],
  });
  const catalog = (type: string, resource: Record<string, unknown>) => {
    const app = parseAppConfig(
      {
        name: 'Rows',
        resources: { item: {} },
        auth: { roles: { reader: { read: true } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'amount'], sorts: ['id'], ...resource } } },
      },
      'fixture',
    );
    return checkApiReadCatalog(app.api!, app, schema(type));
  };
  assert.doesNotThrow(() => catalog('numeric(12,2)', {}));
  assert.doesNotThrow(() => catalog('timestamptz', {}));
  // A JSON column is said as an object (row-defined fields), never filtered or sorted by.
  assert.doesNotThrow(() => catalog('jsonb', {}));
  assert.throws(() => catalog('timestamp', {}), /cannot represent/);
  for (const type of ['numeric(12,2)', 'timestamptz', 'jsonb']) {
    assert.throws(() => catalog(type, { filters: ['amount'] }), /does not filter or sort/);
    assert.throws(() => catalog(type, { sorts: ['id', 'amount'] }), /does not filter or sort/);
  }
});
