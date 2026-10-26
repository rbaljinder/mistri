import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { finiteNumberCodec, int64Codec } from '../packages/mistri/src/shared/apiNumeric.js';

const ajv = new Ajv2020({ strict: true });

test('explicit integer strategies preserve safe values and never recover rounded numbers', () => {
  const numeric = int64Codec('number'),
    decimal = int64Codec('decimal-string');
  for (const value of [0, 1, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    assert.equal(numeric.encode(value), value);
    assert.equal(numeric.encode(String(value)), value);
    assert.equal(decimal.encode(value), String(value));
  }
  for (const sign of [1n, -1n]) {
    for (const delta of [-1n, 0n, 1n]) {
      const integer = sign * (2n ** 53n + delta),
        text = integer.toString();
      assert.equal(decimal.encode(text), text);
      if (delta === -1n) assert.equal(numeric.encode(text), Number(integer));
      else {
        assert.throws(() => numeric.encode(text));
        assert.throws(() => numeric.encode(Number(integer)));
        assert.throws(() => decimal.encode(Number(integer)));
      }
    }
  }
  assert.equal(numeric.encode(-0), 0);
  assert.equal(decimal.encode(-0), '0');
});

test('signed-int64 decimal schema enforces exact extrema, not just string length', () => {
  const codec = int64Codec('decimal-string'),
    valid = ajv.compile(codec.schema);
  for (const text of ['9223372036854775807', '-9223372036854775808', '9223372036854775806', '-9223372036854775807']) {
    assert.equal(codec.encode(text), text);
    assert.equal(valid(text), true);
  }
  for (const text of ['9223372036854775808', '-9223372036854775809', '9999999999999999999', '-9999999999999999999']) {
    assert.throws(() => codec.encode(text));
    assert.equal(valid(text), false);
  }
  // Deterministic prefix-boundary corpus independently checks the generated regex.
  for (let digits = 0n; digits < 20n; digits++) {
    for (const delta of [-1n, 0n, 1n]) {
      for (const sign of [-1n, 1n]) {
        const value = sign * (10n ** digits + delta),
          text = value.toString();
        const expected = value >= -9223372036854775808n && value <= 9223372036854775807n;
        assert.equal(valid(text), expected, text);
        if (expected) assert.equal(codec.encode(text), text);
        else assert.throws(() => codec.encode(text));
      }
    }
  }
});

test('integer encoders and schemas reject malformed, nonfinite and unsupported input', () => {
  const decimal = int64Codec('decimal-string'),
    numeric = int64Codec('number');
  const validString = ajv.compile(decimal.schema),
    validNumber = ajv.compile(numeric.schema);
  for (const value of [
    '',
    ' ',
    '+1',
    '-0',
    '00',
    '01',
    '-01',
    '1.0',
    '1e3',
    '1,000',
    ' 1',
    '1 ',
    '1\n',
    '1\r\n',
    '1\u2028',
    'NaN',
    'Infinity',
    '１２',
    '9'.repeat(100),
  ]) {
    assert.throws(() => decimal.encode(value));
    assert.throws(() => numeric.encode(value));
    assert.equal(validString(value), false);
  }
  for (const value of [NaN, Infinity, -Infinity, 1.5, null, undefined, true, {}, [], 1n]) {
    assert.throws(() => decimal.encode(value));
    assert.throws(() => numeric.encode(value));
  }
  assert.equal(validNumber(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(validNumber('1'), false);
  assert.equal(validString(1), false);
  assert.throws(() => int64Codec(undefined as never));
});

test('published schemas accept every encoded output and are immutable', () => {
  for (const codec of [int64Codec('number'), int64Codec('decimal-string'), finiteNumberCodec()]) {
    const validate = ajv.compile(codec.schema);
    assert.equal(Object.isFrozen(codec), true);
    assert.equal(Object.isFrozen(codec.schema), true);
    for (const value of [0, -1, Number.MAX_SAFE_INTEGER]) assert.equal(validate(codec.encode(value)), true);
  }
  const finite = finiteNumberCodec(),
    validate = ajv.compile(finite.schema);
  for (const value of [0.1, -0.1, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    assert.equal(finite.encode(value), value);
    assert.equal(validate(value), true);
  }
  for (const value of [NaN, Infinity, -Infinity, '0.1', null, 1n]) {
    assert.throws(() => finite.encode(value));
    assert.equal(validate(value), false);
  }
});
