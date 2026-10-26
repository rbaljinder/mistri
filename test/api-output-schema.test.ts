import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { renderApiOutputSchema } from '../packages/mistri/src/server/api/apiOutputSchema.js';
import {
  shape,
  text,
  int,
  id,
  number,
  bool,
  date,
  literal,
  list,
  optional,
  nullable,
  oneOf,
  type Shape,
} from '../packages/mistri/src/server/commands/commandShapes.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';

const ajv = new Ajv2020({ strict: true, strictTypes: false });
test('number structure explicitly bounds finite binary64 magnitude for independent validators', () => {
  assert.deepEqual(renderApiOutputSchema(number()).schema, { type: 'number', minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
  assert.deepEqual(renderApiOutputSchema(number({ min: 2 })).schema, { type: 'number', minimum: 2, maximum: Number.MAX_VALUE });
  assert.deepEqual(renderApiOutputSchema(number({ max: 2 })).schema, { type: 'number', minimum: -Number.MAX_VALUE, maximum: 2 });
});
test('projected output has closed structure and exact optional properties', () => {
  const output = shape({
    id: id(),
    note: optional(text()),
    maybe: nullable(optional(bool())),
    items: list(shape({ yes: bool() }), { max: 3 }),
  });
  const result = renderApiOutputSchema(output),
    validate = ajv.compile(result.schema);
  assert.equal(result.stage, 'output-structure-schema');
  assert.equal(result.envelopeValidation, 'pending');
  assert.ok(Object.isFrozen(result.schema));
  const raw = { id: 1, items: [{ yes: true, hidden: 4 }], hidden: 'secret' };
  assert.equal(validate(raw), false);
  assert.equal(validate(JSON.parse(canonicalCommandJson(output.parse(raw)))), true);
  assert.equal(validate({ id: 1, items: [], maybe: null }), true);
  assert.equal(validate({ id: 1, items: [{}] }), false);
  assert.equal(validate({ id: 1 }), false);
});

test('supported structural schemas agree with serialized scalar and list corpus', () => {
  const shapes: Shape<unknown>[] = [
    text(),
    int({ min: -3, max: 4 }),
    id(),
    number({ min: -1.5, max: 2 }),
    bool(),
    literal('yes', 'yes', false, null),
    nullable(text()),
    oneOf(int(), text()),
    list(bool(), { min: 1, max: 2 }),
  ];
  const values: unknown[] = [
    null,
    false,
    true,
    '',
    'yes',
    '😀',
    -4,
    -3,
    -1.5,
    0,
    1,
    4,
    5,
    [],
    [true],
    [false, true],
    [true, false, true],
    {},
    { a: 1 },
  ];
  for (const output of shapes) {
    const validate = ajv.compile(renderApiOutputSchema(output).schema);
    for (const value of values) {
      let accepts = true;
      try {
        canonicalCommandJson(output.parse(value));
      } catch {
        accepts = false;
      }
      assert.equal(validate(value), accepts, JSON.stringify(value));
    }
  }
});

test('unrepresentable semantics refuse rather than approximate', () => {
  const unsupported = [
    text({ pattern: /abc/i }),
    text({ pattern: /^.$/ }),
    text({ pattern: /^[^a]$/ }),
    text({ pattern: /x/s }),
    optional(text()),
    list(optional(text())),
    nullable(optional(text())),
    oneOf(optional(text()), bool()),
    oneOf(shape({ a: optional(text()) }), shape({ b: text() })),
    list(bool(), { min: -1 }),
    list(bool(), { max: 1.5 }),
    list(bool(), { max: Number.MAX_SAFE_INTEGER + 1 }),
    shape({ constructor: text() }),
    { parse: () => true },
  ];
  for (const output of unsupported) assert.throws(() => renderApiOutputSchema(output), /Command output/);
});

test('bounded text, a pattern and a date have wire rules: maxLength, pattern and format date', () => {
  // `format` is an annotation the schema does not lean on: the pattern holds the calendar.
  const dated = new Ajv2020({ strict: true, strictTypes: false, formats: { date: true } });
  assert.deepEqual(renderApiOutputSchema(text({ max: 3, pattern: /^[a-z]+$/u })).schema, {
    type: 'string',
    maxLength: 3,
    pattern: '^[a-z]+$',
  });
  assert.deepEqual(renderApiOutputSchema(text({ pattern: /^\d{4}$/ })).schema, { type: 'string', pattern: '^\\d{4}$' });
  const day = renderApiOutputSchema(date()).schema as Record<string, unknown>;
  assert.equal(day.format, 'date');
  const cases: Array<[Shape<unknown>, unknown[]]> = [
    [text({ max: 3 }), ['', 'abc', 'abcd', 'é', 'ab\u00e9', 3, null]],
    [text({ pattern: /^[a-z]+$/u }), ['', 'abc', 'ABC', 'a-b', '😀']],
    [text({ pattern: /^[0-9]{2}$/ }), ['12', '123', '1a', '']],
    [text({ pattern: /^.$/u }), ['a', '😀', 'ab']],
    [
      date(),
      [
        '2024-02-29',
        '2023-02-29',
        '1900-02-29',
        '2000-02-29',
        '0000-02-29',
        '0000-01-01',
        '9999-12-31',
        '2024-13-01',
        '2024-04-31',
        '2024-1-01',
        '2024-01-01 ',
        ' 2024-01-01',
        '20240101',
        20240101,
        null,
      ],
    ],
  ];
  for (const [output, values] of cases) {
    const validate = dated.compile(renderApiOutputSchema(output).schema);
    for (const value of values) {
      let accepts = true;
      try {
        canonicalCommandJson(output.parse(value));
      } catch {
        accepts = false;
      }
      assert.equal(validate(value), accepts, `${JSON.stringify(value)} against ${JSON.stringify(renderApiOutputSchema(output).schema)}`);
    }
  }
  // maxLength counts code points and `max` UTF-16 units: whatever the handler may return still passes.
  const astral = dated.compile(renderApiOutputSchema(text({ max: 2 })).schema);
  assert.equal(astral(text({ max: 2 }).parse('😀')), true);
});

test('unknown output code is never invoked and envelope limits stay pending', () => {
  let called = false;
  assert.throws(
    () =>
      renderApiOutputSchema({
        parse() {
          called = true;
          throw new Error();
        },
      }),
    /opaque/,
  );
  assert.equal(called, false);
  const huge = 'x'.repeat(17000),
    output = text();
  assert.equal(ajv.compile(renderApiOutputSchema(output).schema)(huge), true);
  assert.throws(() => canonicalCommandJson(output.parse(huge), 16384));
});

test('canonical output refuses undefined and sparse arrays, not silent null conversion', () => {
  assert.throws(() => canonicalCommandJson(optional(text()).parse(undefined)));
  assert.throws(() => canonicalCommandJson(list(optional(text())).parse([undefined])));
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(() => canonicalCommandJson(list(text()).parse(sparse)));
});
