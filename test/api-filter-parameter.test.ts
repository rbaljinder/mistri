import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createApiFilterParameter } from '../packages/mistri/src/server/api/apiFilterParameter.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { apiValueCodec } from '../packages/mistri/src/server/api/apiValueCodec.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const ajv = new Ajv2020({ strict: true });
function fixture(type = 'text', allowed?: string[]) {
  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'Fixture',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
          { name: 'value', type, nullable: true, primaryKey: false, ...(allowed ? { allowed } : {}) },
        ],
      },
    ],
  };
  const app = parseAppConfig(
    {
      name: 'Filters',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'value'], filters: ['value'], sorts: ['id'] } } },
    },
    'fixture',
  );
  const operation = checkApiReadCatalog(app.api!, app, schema).operations[0];
  return {
    schema,
    operation,
    parameter: (integers: 'number' | 'decimal-string' = 'decimal-string') =>
      createApiFilterParameter('value', operation, schema, { integers }),
  };
}

test('CSV text uses the shared enum, excludes null and has no range alternative', () => {
  const f = fixture('text', ['001', 'active', 'active']),
    parameter = f.parameter();
  assert.equal(parameter.style, 'form');
  assert.equal(parameter.explode, false);
  const valid = ajv.compile(parameter.schema);
  assert.equal(valid(['001']), true);
  assert.equal(valid(['active', '001']), true);
  for (const value of [null, [null], [1], ['missing'], [], '..2']) assert.equal(valid(value), false);
  assert.deepEqual(parameter.schema, {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    items: apiValueCodec(f.schema.tables[0].columns[1], 'postgres', 'decimal-string').schema,
  });
  assert.ok(Object.isFrozen(parameter));
  assert.ok(Object.isFrozen(parameter.schema));
});

test('integer array representation and enum preserve exact values above 2^53', () => {
  const f = fixture('bigint', ['9007199254740993', '-9223372036854775808']);
  const valid = ajv.compile(f.parameter().schema);
  assert.equal(valid(['9007199254740993']), true);
  assert.equal(valid([9007199254740992]), false);
  assert.equal(valid(['9007199254740992']), false);
  assert.throws(() => f.parameter('number'));
  const small = fixture('bigint', ['1', '2']).parameter('number');
  const number = ajv.compile(small.schema);
  assert.equal(number([1, 2]), true);
  assert.equal(number(['1']), false);
});

test('numeric ranges describe syntax but explicitly defer endpoint and order validation', () => {
  const parameter = fixture('real').parameter(),
    valid = ajv.compile(parameter.schema);
  for (const value of [[1.5, -2], '1.5..2', '-2..', '..0', '-0..0']) assert.equal(valid(value), true);
  for (const value of ['..', '1...2', '1e2..3', ' 1..2', '01..2', '1..2\n', [null]]) assert.equal(valid(value), false);
  // Not a false promise: syntax alone cannot prove order or finite bounds.
  assert.equal(valid('2..1'), true);
  assert.deepEqual(parameter['x-mistri-runtime-validation'], ['raw-query', 'range-endpoint-values', 'range-order']);
  assert.equal(parameter['x-mistri-range-endpoint-schema']?.type, 'number');
  const integer = ajv.compile(fixture('bigint').parameter().schema);
  assert.equal(integer('-0..2'), false);
  assert.equal(integer('-2..0'), true);
});

test('boolean is strict, unsupported columns/options and unexposed/reserved fields refuse', () => {
  const valid = ajv.compile(fixture('boolean').parameter().schema);
  assert.equal(valid([true, false]), true);
  for (const value of [['true'], [1], [null], 'true..false']) assert.equal(valid(value), false);
  for (const type of ['timestamp', 'jsonb', 'bytea', 'numeric', 'money']) assert.throws(() => fixture(type).parameter());
  const f = fixture();
  assert.throws(() => createApiFilterParameter('value', f.operation, f.schema, {} as never));
  assert.throws(() => createApiFilterParameter('id', f.operation, f.schema, { integers: 'number' }));
  assert.throws(() =>
    createApiFilterParameter('value', { ...f.operation, fields: ['id', 'value', 'limit'], filters: ['value', 'limit'] }, f.schema, {
      integers: 'number',
    }),
  );
});

test('date parameter advertises only DATE arrays and lexical ranges with strict endpoint schema', () => {
  const parameter = fixture('date').parameter(),
    valid = ajv.compile(parameter.schema);
  assert.equal(valid(['2000-02-29']), true);
  assert.equal(valid(['1900-02-29']), false);
  assert.equal(valid([null]), false);
  assert.equal(valid('2000-02-29..9999-12-31'), true);
  assert.equal(valid('1..2'), false);
  const endpoint = ajv.compile(parameter['x-mistri-range-endpoint-schema']!);
  assert.equal(endpoint('0000-01-01'), false);
  assert.equal(endpoint('9999-12-31'), true);
});
