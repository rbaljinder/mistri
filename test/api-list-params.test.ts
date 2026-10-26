import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApiListParams } from '../packages/mistri/src/server/api/apiListParams.js';

const exposure = {
  fields: ['tenant_id', 'id', 'status', 'amount', 'owner.name'],
  primaryKey: ['tenant_id', 'id'],
  filters: ['status', 'amount'],
  sorts: ['id', 'amount'],
  tabs: ['all', 'in-review'],
};
const parse = (query: string) => parseApiListParams(query, exposure);

test('strict defaults and explicit sparse projection retain the complete key', () => {
  const value = parse('');
  assert.equal(value.stage, 'list-parameter-lexemes');
  assert.equal(value.typeValidation, 'pending');
  assert.equal(value.cursorVerification, 'pending');
  assert.equal(value.orderKeyCompletion, 'pending');
  assert.equal(value.limit, 50);
  assert.equal(value.count, false);
  assert.deepEqual(value.fields, exposure.fields);
  assert.deepEqual(parse('fields=status').fields, ['tenant_id', 'id', 'status']);
  assert.deepEqual(parse('sort=-amount,id').order, [
    { field: 'amount', descending: true },
    { field: 'id', descending: false },
  ]);
});

test('filter lexemes preserve exact large numbers and URL decoding without coercion', () => {
  assert.deepEqual(parse('?amount=9007199254740993..9223372036854775807&status=in+review,won').filters, [
    { field: 'amount', value: { kind: 'range', min: '9007199254740993', max: '9223372036854775807' } },
    { field: 'status', value: { kind: 'values', values: ['in review', 'won'] } },
  ]);
  assert.equal(parse('limit=500&count=true&segment=in-review&cursor=a%2Bb%3D').cursor, 'a+b=');
  assert.deepEqual(parse('status=%F0%9F%98%80').filters[0].value, { kind: 'values', values: ['😀'] });
  assert.deepEqual(parse('status=%20Alice%20,Bob%20').filters[0].value, { kind: 'values', values: [' Alice ', 'Bob '] });
  assert.deepEqual(parse('amount=%201').filters[0].value, { kind: 'values', values: [' 1'] }); // Typed stage refuses this numeric padding.
  assert.throws(() => parse('amount=%201..2'), /padded range/);
});

test('repeated decoded names, unknown controls and empty members refuse', () => {
  for (const query of [
    'limit=2&%6cimit=3',
    'q=foo',
    'offset=1',
    'where=id%3D1',
    'totals=amount',
    'hidden=1',
    'status=x,,y',
    'status=',
    'status=,x',
    'status=x,',
    'status=x&',
    '&status=x',
    'status',
    '=x',
    'fields=id,id',
    'fields=id,',
    'fields=hidden',
    'sort=id,-id',
    'sort=id,',
    'sort=hidden',
    'sort=owner..name',
    'segment=unknown',
    // The App's own address says ?tab=; the API says ?segment=.
    'tab=in-review',
  ]) {
    assert.throws(() => parse(query), /API list parameters/, query);
  }
});

test('malformed percent UTF-8 controls and fragments never get repaired', () => {
  for (const value of ['%', '%2', '%GG', '%C0%AF', '%ED%A0%80', '%FF', '%00', '%0A', '\ud800', 'x#fragment']) {
    assert.throws(() => parse(`status=${value}`), /API list parameters/);
  }
});

test('canonical limit and boolean syntax is strict', () => {
  for (const value of ['0', '01', '+1', '1.0', '1e2', '-1', '501', '9999', ' 5', '', '1%E2%80%A8', '1%E2%80%A9'])
    assert.throws(() => parse(`limit=${value}`));
  for (const value of ['TRUE', 'False', '1', '0', '']) assert.throws(() => parse(`count=${value}`));
  assert.equal(parse('count=false').count, false);
});

test('malformed ranges refuse while numeric and DATE lexemes await column validation', () => {
  for (const value of ['..', '1...2', '1..2..3', 'a..b', '1e2..3', '2026-09-01..1', '1..2,3'])
    assert.throws(() => parse(`amount=${value}`), /range/);
  assert.deepEqual(parse('amount=2026-09-01..').filters[0].value, { kind: 'range', min: '2026-09-01' });
  assert.deepEqual(parse('amount=..5').filters[0].value, { kind: 'range', max: '5' });
  // Semantic bounds/type checks are deliberately pending, not Number-coerced here.
  assert.deepEqual(parse('amount=10..2').filters[0].value, { kind: 'range', min: '10', max: '2' });
});

test('bounded envelopes and reserved metadata collisions fail closed', () => {
  assert.throws(() => parse(`cursor=${'a'.repeat(4097)}`), /cursor/);
  assert.throws(() => parse(`status=${'a'.repeat(16385)}`), /oversized/);
  assert.throws(() => parse(Array.from({ length: 65 }, () => 'status=a').join('&')), /too many parameters/);
  assert.throws(() => parse(`status=${Array.from({ length: 101 }, () => 'a').join(',')}`), /too many filter/);
  assert.throws(() => parseApiListParams('', { ...exposure, fields: [...exposure.fields, 'limit'], filters: ['limit'] }), /collides/);
  assert.throws(() => parseApiListParams('', { ...exposure, primaryKey: ['missing'] }), /complete key/);
  assert.throws(() => parseApiListParams('', { ...exposure, filters: ['constructor'] }), /metadata/);
  for (const ending of ['\u2028', '\u2029']) {
    assert.throws(() => parseApiListParams('', { ...exposure, tabs: [`all${ending}`] }), /metadata/);
    assert.throws(() => parseApiListParams('', { ...exposure, fields: [`id${ending}`] }), /metadata/);
  }
  const sparse = ['id'];
  sparse.length = 2;
  assert.throws(() => parseApiListParams('', { ...exposure, fields: sparse }), /metadata/);
});
