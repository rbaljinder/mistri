import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { createApiReadKeyCodec } from '../packages/mistri/src/server/api/apiReadKey.js';

function fixture(composite = false, type = 'TEXT') {
  const schema: DatabaseSchema = {
    label: 'Keys',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: composite ? 'INTEGER' : type, primaryKey: true, nullable: false },
          { name: 'part', type, primaryKey: composite, nullable: false },
        ],
      },
    ],
  };
  const app = parseAppConfig(
    {
      name: 'Keys',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'part'] } } },
    },
    'keys',
  );
  const operation = checkApiReadCatalog(app.api!, app, schema).operations.find((item) => item.kind === 'item')!;
  return { schema, operation, codec: createApiReadKeyCodec(operation, schema, { integers: 'decimal-string' }) };
}

test('single text and composite segments roundtrip delimiters without query-style plus decoding', () => {
  for (const value of ['alpha', 'a,b=c', 'a/b?#', 'a+b', '日本語😀', ' a ']) {
    const one = fixture().codec,
      many = fixture(true).codec;
    const single = one.decode(one.encode({ id: value }));
    assert.deepEqual({ ...single }, { id: value });
    assert.ok(Object.isFrozen(single));
    const key = { id: '9007199254740993', part: value };
    const segment = many.encode(key);
    assert.deepEqual({ ...many.decode(segment) }, key);
    assert.equal(many.encode(many.decode(segment)), segment);
  }
  assert.equal(fixture().codec.decode('a+b').id, 'a+b');
  assert.equal(fixture(true).codec.encode(fixture(true).codec.decode('part=x,id=7')), 'id=7,part=x');
});

test('composite parameter accepts decoded closed objects and matches simple exploded value encoding', () => {
  const { codec } = fixture(true);
  assert.equal(codec.parameter.schema, codec.schema);
  assert.equal(codec.parameter.style, 'simple');
  assert.equal(codec.parameter.explode, true);
  const validate = new Ajv2020({ strict: true }).compile(codec.parameter.schema);
  for (const part of ['雪😀', 'A,B=C/%', '%2C', '%252F', 'a+b', '.']) {
    const key = { id: '9007199254740993', part };
    assert.equal(validate(key), true);
    const standard = Object.entries(key)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join(',');
    assert.equal(codec.encode(key), standard);
    assert.deepEqual({ ...codec.decode(standard) }, key);
  }
  assert.equal(validate({ id: '7' }), false);
  assert.equal(validate({ id: '7', part: 'x', extra: 'x' }), false);
  assert.equal(validate('id=7,part=x'), false);
  assert.equal(codec.decode('id=7,part=%252C').part, '%2C');
  assert.throws(() => codec.decode(encodeURIComponent('id=7,part=x')));
});

test('integer text is canonical and large values never pass through Number', () => {
  const f = fixture(false, 'INTEGER');
  for (const id of ['0', '-1', '-9223372036854775808', '9223372036854775807', '9007199254740993']) {
    assert.equal(f.codec.decode(id).id, id);
    assert.equal(f.codec.encode({ id }), id);
  }
  for (const id of ['01', '+1', '-0', '1.0', '1e2', ' 1', '9223372036854775808']) assert.throws(() => f.codec.decode(id));
  const numeric = createApiReadKeyCodec(f.operation, f.schema, { integers: 'number' });
  assert.equal(numeric.decode('42').id, 42);
  assert.throws(() => numeric.decode('9007199254740993'));
  assert.throws(() => f.codec.encode({ id: 9007199254740992 }));
});

test('wrong composite names and malformed encoding refuse before lookup', () => {
  const codec = fixture(true).codec;
  for (const raw of [
    '',
    'id=1',
    'id=1,id=2',
    'id=1,part=x,unknown=y',
    'unknown=x,part=y',
    'id=1,part=x=y',
    'id=1,part=x,',
    '%69d=1,part=x',
    'id=1,part=%',
    'id=1,part=%FF',
    'id=1,part=%ED%A0%80',
    'id=1,part=%00',
    'id=1,part=%0A',
    'id=1,part=\ud800',
    'id=1,part=',
    'id=1,part=x/y',
    'id=1,part=x?y',
    'id=1,part=x#y',
  ]) {
    assert.throws(() => codec.decode(raw), Error, raw);
  }
  assert.throws(() => codec.decode(`id=1,part=${'a'.repeat(8193)}`));
  assert.throws(() => codec.encode({ id: 1, part: 'x', extra: 'hidden' }));
  assert.throws(() => codec.encode({ id: 1 }));
});

test('single dot segments refuse and percent text is decoded exactly once', () => {
  const codec = fixture().codec;
  for (const segment of ['.', '..', '%2e', '%2E%2e', '.%2e', '%2e.']) assert.throws(() => codec.decode(segment));
  for (const value of ['.', '..']) assert.throws(() => codec.encode({ id: value }));
  assert.throws(() => codec.decode('a\\b'));
  for (const value of ['/', '\\', '%2F', '%2e', 'a/b', '...']) {
    const encoded = codec.encode({ id: value });
    assert.equal(new URL(`/items/${encoded}`, 'https://example.test').pathname, `/items/${encoded}`);
    assert.equal(codec.decode(encoded).id, value);
  }
  assert.equal(fixture(true).codec.decode('id=1,part=..').part, '..');
});

test('captured metadata is immutable and encoder never executes row getters', () => {
  const f = fixture(true);
  f.schema.tables[0].columns[1].type = 'BLOB';
  assert.deepEqual({ ...f.codec.decode('id=1,part=x') }, { id: '1', part: 'x' });
  let calls = 0;
  assert.throws(() =>
    f.codec.encode({
      id: 1,
      get part() {
        calls++;
        return 'x';
      },
    }),
  );
  assert.equal(calls, 0);
  assert.throws(() => f.codec.encode(new Proxy({ id: 1, part: 'x' }, {})));
  for (const type of ['REAL', 'BOOLEAN', 'BLOB', 'DATE']) assert.throws(() => fixture(false, type));
  const integer = fixture(false, 'INTEGER');
  integer.schema.tables[0].columns[0].nullable = true;
  assert.throws(() => createApiReadKeyCodec(integer.operation, integer.schema, { integers: 'number' }));
  assert.equal(f.codec.authorization, 'pending');
});

test('decoded text key schema agrees with the actual codec on Unicode, controls, dots and enums', () => {
  const cases = [
    'alpha',
    '',
    '.',
    '..',
    '...',
    '/',
    '\\',
    '%2F',
    'a,b=c',
    ' ',
    '日本語😀',
    '\u2028',
    '\u0000',
    'a\n',
    '\u001f',
    '\u007f',
    '\ud800',
    '\udfff',
    'a\ud800z',
  ];
  for (const composite of [false, true])
    for (const enumerated of [false, true]) {
      const f = fixture(composite);
      if (enumerated) f.schema.tables[0].columns[composite ? 1 : 0].allowed = ['alpha', '.', '', '日本語😀', '\ud800'];
      const codec = createApiReadKeyCodec(f.operation, f.schema, { integers: 'decimal-string' });
      const validate = new Ajv2020({ strict: true }).compile(codec.schema);
      const scalar = composite ? undefined : new Ajv2020({ strict: true }).compile(codec.parameter.schema);
      for (const value of cases) {
        const key = composite ? { id: '7', part: value } : { id: value };
        let accepted = false;
        let decoded: unknown;
        try {
          decoded = codec.decode(codec.encode(key));
          accepted = true;
        } catch {
          /* refused */
        }
        if (accepted) assert.deepEqual({ ...(decoded as object) }, key);
        assert.equal(validate(key), accepted, JSON.stringify({ composite, enumerated, value }));
        if (scalar) assert.equal(scalar(value), accepted, JSON.stringify(value));
      }
      assert.equal(validate({ id: 'alpha', extra: 'x' }), false);
      assert.equal(validate({}), false);
      assert.ok(Object.isFrozen(codec.schema.properties));
      assert.ok(Object.isFrozen(codec.parameter['x-mistri-runtime-validation']));
    }
});

test('integer key schemas describe the chosen decoded representation, including enum normalization', () => {
  for (const integers of ['number', 'decimal-string'] as const)
    for (const enumerated of [false, true]) {
      const f = fixture(false, 'INTEGER');
      if (enumerated) f.schema.tables[0].columns[0].allowed = ['0', '42'];
      const codec = createApiReadKeyCodec(f.operation, f.schema, { integers });
      const validate = new Ajv2020({ strict: true }).compile(codec.parameter.schema);
      for (const lexeme of [
        '0',
        '42',
        '-1',
        '9007199254740991',
        '9007199254740993',
        '-9223372036854775808',
        '9223372036854775807',
        '9223372036854775808',
      ]) {
        const value = integers === 'number' ? Number(lexeme) : lexeme;
        let accepted = false;
        try {
          codec.decode(lexeme);
          accepted = true;
        } catch {
          /* refused */
        }
        assert.equal(validate(value), accepted, `${integers}/${enumerated}/${lexeme}`);
      }
      for (const lexeme of ['', '01', '+1', '-0', '1e2', '1.0']) {
        assert.throws(() => codec.decode(lexeme));
        if (integers === 'decimal-string') assert.equal(validate(lexeme), false);
      }
    }
});

test('byte budgets remain explicit runtime constraints, not inaccurate character maxLength limits', () => {
  const codec = fixture().codec;
  const validate = new Ajv2020({ strict: true }).compile(codec.parameter.schema);
  assert.equal(Object.hasOwn(codec.parameter.schema, 'maxLength'), false);
  assert.equal(codec.parameter['x-mistri-max-encoded-segment-utf8-bytes'], 8192);
  assert.equal(codec.parameter['x-mistri-max-canonical-key-json-utf8-bytes'], 8192);
  const encodedOversize = '😀'.repeat(700);
  assert.equal(validate(encodedOversize), true);
  assert.throws(() => codec.encode({ id: encodedOversize }));
  const canonicalOversize = 'a'.repeat(8190);
  assert.equal(validate(canonicalOversize), true);
  assert.throws(() => codec.decode(canonicalOversize));
});
