import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiReadEnvelopeCodec } from '../packages/mistri/src/server/api/apiReadEnvelope.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

// Annotation vocabulary documents runtime-only UTF-8 and cross-field checks;
// it is deliberately not registered as a pretend validation implementation.
const ajv = new Ajv2020({ strict: true });
for (const keyword of [
  'x-mistri-max-utf8-bytes',
  'x-mistri-unicode-scalar-values',
  'x-mistri-control-characters',
  'x-mistri-exact-uncapped-count',
])
  ajv.addKeyword({ keyword });

function codec(countRequested = false, limit = 50) {
  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'Logical',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', primaryKey: true, nullable: false },
          { name: 'name', type: 'text', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  const app = parseAppConfig(
    {
      name: 'Envelope',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'] } } },
    },
    'fixture',
  );
  return createApiReadEnvelopeCodec(checkApiReadCatalog(app.api!, app, schema).operations[0], schema, {
    integers: 'decimal-string',
    limit,
    countRequested,
  });
}
const row = () => ({ id: '9007199254740993', name: 'Visible', secret: 'not returned' });

test('actual row codec projects and encodes every row without leaking hidden fields', () => {
  const encoder = codec(),
    result = encoder.encode({ items: [row()], next: 'opaque+cursor=' });
  assert.equal(encoder.stage, 'read-list-envelope-codec');
  assert.equal(encoder.cursorVerification, 'pending');
  assert.equal(result.items[0].id, '9007199254740993');
  assert.equal(Object.hasOwn(result.items[0], 'secret'), false);
  assert.equal(result.next, 'opaque+cursor=');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.items) && Object.isFrozen(result.items[0]));
  assert.throws(() => encoder.encode({ items: [{ id: 9007199254740992, name: 'Unsafe' }], next: null }));
});

test('counts are only returned when requested and bounded exact counts preserve existing semantics', () => {
  const count = { value: 10000, exact: true, capped: true };
  assert.throws(() => codec().encode({ items: [], next: null, count }));
  assert.throws(() => codec(true).encode({ items: [], next: null }));
  assert.deepEqual(codec(true).encode({ items: [row()], next: null, count }).count, count);
  assert.deepEqual(codec(true).encode({ items: [], next: null, count: { value: 0, exact: true, capped: false } }).count, {
    value: 0,
    exact: true,
    capped: false,
  });
  for (const invalid of [
    { ...count, value: 9999 },
    { ...count, exact: false },
    { ...count, value: 10001 },
    { value: 0, exact: true, capped: false },
    { value: '1', exact: true, capped: false },
  ]) {
    assert.throws(() => codec(true).encode({ items: [row()], next: null, count: invalid }));
  }
  assert.equal(codec(true).encode({ items: [row()], next: null, count: { value: 0, exact: false, capped: false } }).count!.exact, false);
});

test('page and opaque cursor limits are strict without interpreting cursor contents', () => {
  assert.throws(() => codec(false, 501));
  assert.throws(() => codec(false, 1).encode({ items: [row(), row()], next: null }));
  for (const next of ['', 'a'.repeat(4097), '😀'.repeat(1025), '\ud800', '\n', 1, undefined]) {
    assert.throws(() => codec().encode({ items: [], next }));
  }
  assert.equal(codec().encode({ items: [], next: null }).next, null);
});

test('envelope and dense row arrays are data-only and cannot invoke accessors', () => {
  let calls = 0;
  assert.throws(() =>
    codec().encode({
      get items() {
        calls++;
        return [];
      },
      next: null,
    }),
  );
  const rows = [row()];
  Object.defineProperty(rows, '0', {
    get() {
      calls++;
      return row();
    },
  });
  assert.throws(() => codec().encode({ items: rows, next: null }));
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => codec().encode({ items: sparse, next: null }));
  assert.throws(() => codec().encode({ items: [], next: null, sql: 'secret' }));
  assert.equal(calls, 0);
});

test('shared envelope schema validates encoded rows and both concrete count policies', () => {
  for (const requested of [false, true]) {
    const encoder = codec(requested, 2),
      validate = ajv.compile(encoder.schema);
    const input = { items: [row()], next: 'opaque', ...(requested ? { count: { value: 1, exact: true, capped: false } } : {}) };
    assert.equal(validate(encoder.encode(input)), true, JSON.stringify(validate.errors));
    assert.ok(Object.isFrozen(encoder.schema) && Object.isFrozen(encoder.schema.properties));
    assert.equal(validate({ ...encoder.encode(input), extra: 'not allowed' }), false);
    assert.equal(validate({ ...encoder.encode(input), items: [row(), row(), row()] }), false);
    const changed = { ...encoder.encode(input) } as Record<string, unknown>;
    if (requested) delete changed.count;
    else changed.count = { value: 1, exact: true, capped: false };
    assert.equal(validate(changed), false);
  }
});

test('count coherence is schema-enforced where representable, runtime-enforced otherwise', () => {
  const encoder = codec(true),
    validate = ajv.compile(encoder.schema);
  for (const count of [
    { value: 9999, exact: true, capped: true },
    { value: 10000, exact: false, capped: true },
  ]) {
    assert.equal(validate({ items: [], next: null, count }), false);
  }
  const shorter = { items: [{ id: '1', name: 'Name' }], next: null, count: { value: 0, exact: true, capped: false } };
  assert.equal(validate(shorter), true);
  assert.throws(() => encoder.encode(shorter));
  const oversized = { items: [], next: '😀'.repeat(1025), count: { value: 0, exact: true, capped: false } };
  assert.equal(validate(oversized), true);
  assert.throws(() => encoder.encode(oversized));
  assert.equal(encoder.schema.properties.next.anyOf[1]['x-mistri-max-utf8-bytes'], 4096);
});
