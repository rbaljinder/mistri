import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { apiDateCodec } from '../packages/mistri/src/server/api/apiDateCodec.js';
import { apiValueCodec } from '../packages/mistri/src/server/api/apiValueCodec.js';

test('calendar schema and encoder agree with independent Gregorian arithmetic for every supported year', () => {
  const codec = apiDateCodec(),
    valid = new Ajv2020({ strict: true }).compile(codec.schema);
  for (let year = 1; year <= 9999; year++) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month++) {
      for (const day of [0, 1, months[month - 1], months[month - 1] + 1]) {
        const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const expected = day > 0 && day <= months[month - 1];
        assert.equal(valid(value), expected, value);
        if (expected) assert.equal(codec.encode(value), value);
        else assert.throws(() => codec.encode(value), value);
      }
    }
  }
});

test('DATE refuses zero/BC/infinity/noncanonical/instant values in each SQL dialect', () => {
  const invalid = [
    '0000-01-01',
    '0000-02-29',
    '2026-00-01',
    '2026-13-01',
    '2026-2-01',
    '2026-02-1',
    '2026-02-01\n',
    ' 2026-02-01',
    '2026-02-01 ',
    '10000-01-01',
    '0001-01-01 BC',
    'infinity',
    '-infinity',
    '2026-01-01T00:00:00Z',
    '0000-00-00',
    new Date(0),
    0,
    null,
  ];
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    const codec = apiValueCodec({ type: 'DATE' }, dialect, 'decimal-string');
    const valid = new Ajv2020({ strict: true }).compile(codec.schema);
    assert.equal(codec.kind, 'date');
    for (const value of invalid) {
      assert.throws(() => codec.encode(value));
      assert.equal(valid(value), false);
    }
    for (const type of ['timestamp', 'datetime', 'time', ...(dialect === 'postgres' ? [] : ['timestamptz', 'timestamp with time zone'])])
      assert.throws(() => apiValueCodec({ type }, dialect, 'number'));
  }
});

test('date enums use the identical strict scalar encoder and are snapshotted', () => {
  const allowed = ['2000-02-29', '9999-12-31', '2000-02-29'];
  const codec = apiValueCodec({ type: 'date', allowed }, 'postgres', 'number');
  allowed.push('2026-01-01');
  const valid = new Ajv2020({ strict: true }).compile(codec.schema);
  assert.equal(codec.encode('2000-02-29'), '2000-02-29');
  assert.equal(valid('2000-02-29'), true);
  assert.equal(valid('2026-01-01'), false);
  assert.throws(() => codec.encode('2026-01-01'));
  assert.throws(() => apiValueCodec({ type: 'date', allowed: ['1900-02-29'] }, 'postgres', 'number'));
});
