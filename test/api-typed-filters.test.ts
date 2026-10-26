import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { parseApiListParams } from '../packages/mistri/src/server/api/apiListParams.js';
import { validateApiFilters } from '../packages/mistri/src/server/api/apiTypedFilters.js';
import { createApiReadRowCodec } from '../packages/mistri/src/server/api/apiReadRowCodec.js';

function fixture() {
  const column = (name: string, type: string): ColumnMeta => ({ name, type, primaryKey: name === 'id', nullable: false });
  const schema: DatabaseSchema = {
    dialect: 'postgres',
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
          column('name', 'text'),
          column('owner_id', 'bigint'),
          column('score', 'real'),
          column('enabled', 'boolean'),
          column('hidden', 'text'),
        ],
      },
      { id: 'person', name: 'person', schema: '', isView: false, columns: [column('id', 'bigint'), column('name', 'text')] },
    ],
    foreignKeys: [{ name: 'owner', from: { table: 'item', columns: ['owner_id'] }, to: { table: 'person', columns: ['id'] } }],
  };
  const fields = ['id', 'name', 'score', 'enabled', 'owner_id.name', 'hidden'];
  const app = parseAppConfig(
    {
      name: 'Filters',
      resources: { item: {}, person: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: {
        version: 1,
        roles: ['reader'],
        resources: { item: { fields, filters: fields.filter((name) => name !== 'hidden'), sorts: ['id'] } },
      },
    },
    'fixture',
  );
  const operation = checkApiReadCatalog(app.api!, app, schema).operations[0];
  const parse = (text: string) => parseApiListParams(text, { ...operation, sorts: ['id'] }).filters;
  const validate = (text: string, integers: 'number' | 'decimal-string' = 'decimal-string') =>
    validateApiFilters(parse(text), operation, schema, { integers });
  return { schema, operation, parse, validate };
}

test('integer filter equality/in and ranges preserve signed int64 digits beyond 2^53', () => {
  const f = fixture();
  assert.deepEqual(f.validate('id=9007199254740993').predicates, [{ field: 'id', kind: 'equals', value: '9007199254740993' }]);
  assert.deepEqual(f.validate('id=9007199254740993,-9223372036854775808').predicates, [
    { field: 'id', kind: 'in', values: ['9007199254740993', '-9223372036854775808'] },
  ]);
  assert.deepEqual(f.validate('id=-9007199254740993..-9007199254740992').predicates, [
    { field: 'id', kind: 'range', min: '-9007199254740993', max: '-9007199254740992' },
  ]);
  assert.throws(() => f.validate('id=-9007199254740992..-9007199254740993'));
  assert.throws(() => f.validate('id=9007199254740993', 'number'));
  assert.deepEqual(f.validate('id=-2..3', 'number').predicates, [{ field: 'id', kind: 'range', min: -2, max: 3 }]);
  assert.deepEqual(f.validate('id=..-1').predicates, [{ field: 'id', kind: 'range', max: '-1' }]);
  for (const value of ['9223372036854775808', '01', '-0', '1.0', 'true', '1,false', 'null']) assert.throws(() => f.validate(`id=${value}`));
});

test('text numeric lookalikes remain strings; text and boolean ranges refuse', () => {
  const f = fixture();
  assert.deepEqual(f.validate('name=001,1e3,true').predicates, [{ field: 'name', kind: 'in', values: ['001', '1e3', 'true'] }]);
  assert.deepEqual(f.validate('enabled=true,false').predicates, [{ field: 'enabled', kind: 'in', values: [true, false] }]);
  for (const text of ['name=1..2', 'enabled=0..1', 'enabled=1', 'enabled=True', 'enabled=true,1']) assert.throws(() => f.validate(text));
  assert.deepEqual(f.validate('name=%20Alice%20,Bob%20').predicates, [{ field: 'name', kind: 'in', values: [' Alice ', 'Bob '] }]);
  assert.deepEqual(f.validate('name=%2B1').predicates, [{ field: 'name', kind: 'equals', value: '+1' }]);
  for (const text of ['id=%201', 'id=1%20', 'score=%201.5', 'score=1.5%20', 'enabled=%20true', 'enabled=true%20', 'id=%201..2']) {
    assert.throws(() => f.validate(text));
  }
});

test('floating filters accept finite decimal lexemes and compare negative ranges numerically', () => {
  const f = fixture();
  assert.deepEqual(f.validate('score=-10.5..-2.25').predicates, [{ field: 'score', kind: 'range', min: -10.5, max: -2.25 }]);
  assert.deepEqual(f.validate('score=1.5,2.25').predicates, [{ field: 'score', kind: 'in', values: [1.5, 2.25] }]);
  for (const value of ['-2.25..-10.5', 'Infinity', 'NaN', '1e3', '0x10', '01', '.5', '1,true', '9'.repeat(310), `0.${'0'.repeat(330)}1`]) {
    assert.throws(() => f.validate(`score=${value}`));
  }
  const zero = f.validate('score=-0').predicates[0];
  assert.ok(zero.kind === 'equals' && Object.is(zero.value, 0));
  assert.deepEqual(f.validate('score=-0..0').predicates, [{ field: 'score', kind: 'range', min: 0, max: 0 }]);
  // Float boundaries are binary64, not an arbitrary-precision decimal type.
  assert.deepEqual(f.validate('score=1.0000000000000001..1').predicates, [{ field: 'score', kind: 'range', min: 1, max: 1 }]);
});

test('typed filter enums and row encoder accept the same scalar representation', () => {
  const f = fixture();
  f.schema.tables[0].columns[0].allowed = ['9007199254740993', '-1'];
  f.schema.tables[0].columns[1].allowed = ['open', 'closed'];
  const predicates = f.validate('id=9007199254740993&name=open').predicates;
  const codec = createApiReadRowCodec(f.operation, f.schema, { integers: 'decimal-string' });
  const row = codec.encodeRow({ id: '9007199254740993', name: 'open', score: 1, enabled: true, 'owner_id.name': null, hidden: 'x' });
  assert.equal(predicates[0].kind === 'equals' && predicates[0].value, row.id);
  assert.throws(() => f.validate('id=2'));
  assert.throws(() => f.validate('name=unknown'));
});

test('joined filters do not invent a null sentinel or gain caller authorization', () => {
  const f = fixture();
  const result = f.validate('owner_id.name=null');
  assert.equal(result.stage, 'typed-read-filters');
  assert.equal(result.authorization, 'pending');
  assert.deepEqual(result.predicates, [{ field: 'owner_id.name', kind: 'equals', value: 'null' }]);
  assert.throws(() =>
    validateApiFilters([{ field: 'owner_id.name', value: { kind: 'values', values: [null] } }] as never, f.operation, f.schema, {
      integers: 'decimal-string',
    }),
  );
  assert.throws(() =>
    validateApiFilters([{ field: 'hidden', value: { kind: 'values', values: ['x'] } }], f.operation, f.schema, { integers: 'number' }),
  );
});

test('date filters preserve civil dates, compare ordered bounds and reject invalid calendars and mixed syntax', () => {
  const f = fixture();
  f.schema.tables[0].columns[1].type = 'date';
  assert.deepEqual(f.validate('name=0001-01-01,2000-02-29').predicates, [
    { field: 'name', kind: 'in', values: ['0001-01-01', '2000-02-29'] },
  ]);
  assert.deepEqual(f.validate('name=2000-02-29..9999-12-31').predicates, [
    { field: 'name', kind: 'range', min: '2000-02-29', max: '9999-12-31' },
  ]);
  assert.deepEqual(f.validate('name=..2000-02-29').predicates, [{ field: 'name', kind: 'range', max: '2000-02-29' }]);
  assert.deepEqual(f.validate('name=2000-02-29..').predicates, [{ field: 'name', kind: 'range', min: '2000-02-29' }]);
  for (const value of [
    '1900-02-29',
    '0000-01-01',
    '2000-02-29,1',
    '2000-02-29..1',
    '1..2000-02-29',
    '2026-01-02..2026-01-01',
    '2026-02-30..',
    '2026-1-01..',
    '%202026-01-01..',
    '2026-01-01T00:00:00Z',
  ])
    assert.throws(() => f.validate(`name=${value}`));
  f.schema.tables[0].columns[1].allowed = ['2000-02-29'];
  assert.throws(() => f.validate('name=2000-02-29..2000-03-01'));
  // Joined fields use the same date codec, not a nullable-filter sentinel.
  f.schema.tables[1].columns[1].type = 'date';
  assert.deepEqual(f.validate('owner_id.name=2000-02-29').predicates, [{ field: 'owner_id.name', kind: 'equals', value: '2000-02-29' }]);
  assert.throws(() => f.validate('owner_id.name=null'));
});

test('unsupported types, forged lexical shapes and mutable inputs fail or remain detached', () => {
  const f = fixture();
  for (const type of ['time', 'timestamp', 'jsonb', 'bytea', 'bigint unsigned']) {
    f.schema.tables[0].columns[1].type = type;
    assert.throws(() => f.validate('name=1'));
  }
  f.schema.tables[0].columns[1].type = 'text';
  const input = f.parse('name=one,two'),
    result = validateApiFilters(input, f.operation, f.schema, { integers: 'number' });
  input[0].field = 'hidden';
  assert.deepEqual(result.predicates, [{ field: 'name', kind: 'in', values: ['one', 'two'] }]);
  assert.ok(Object.isFrozen(result.predicates) && Object.isFrozen(result.predicates[0]));
  let calls = 0;
  const getter = {
    get field() {
      calls++;
      return 'name';
    },
    value: { kind: 'values', values: ['one'] },
  };
  assert.throws(() => validateApiFilters([getter] as never, f.operation, f.schema, { integers: 'number' }));
  assert.equal(calls, 0);
  for (const value of [{ kind: 'range' }, { kind: 'values', values: [] }, { kind: 'values', values: ['one'], injected: true }]) {
    assert.throws(() => validateApiFilters([{ field: 'name', value }] as never, f.operation, f.schema, { integers: 'number' }));
  }
});
