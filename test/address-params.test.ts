import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressFilterValue, addressSortValue, namesTab } from '../packages/engine/src/shared/addressParams.js';

test('address filter lexical grammar preserves equality, lists and Unicode without coercion', () => {
  for (const value of ['Toyota', '9007199254740993', '1e3', 'São Paulo', '東京', '2026-09-01..', '..', 'a..b']) {
    assert.deepEqual(addressFilterValue(value), { kind: 'values', values: [value] });
  }
  assert.deepEqual(addressFilterValue(' Toyota, Honda,,東京 ,'), { kind: 'values', values: ['Toyota', 'Honda', '東京'] });
  assert.deepEqual(addressFilterValue('same,same'), { kind: 'values', values: ['same', 'same'] });
  for (const value of ['', ' ', ',,,']) assert.equal(addressFilterValue(value), undefined);
});

test('address numeric ranges preserve original large and fractional lexemes', () => {
  assert.deepEqual(addressFilterValue(' -9007199254740993..9007199254740993 '), {
    kind: 'range',
    min: '-9007199254740993',
    max: '9007199254740993',
  });
  assert.deepEqual(addressFilterValue('0..'), { kind: 'range', min: '0' });
  assert.deepEqual(addressFilterValue('..0'), { kind: 'range', max: '0' });
  assert.deepEqual(addressFilterValue('-01.20..03.40'), { kind: 'range', min: '-01.20', max: '03.40' });
  assert.deepEqual(addressFilterValue('10..1'), { kind: 'range', min: '10', max: '1' });
  assert.deepEqual(addressFilterValue('1..2,3'), { kind: 'values', values: ['1..2', '3'] });
});

test('address sort lexing preserves multi-key order and refuses unsupported whole tokens', () => {
  assert.deepEqual(addressSortValue('-submitted_on,id'), [
    { field: 'submitted_on', descending: true },
    { field: 'id', descending: false },
  ]);
  assert.deepEqual(addressSortValue('owner.name,-id,id'), [
    { field: 'owner.name', descending: false },
    { field: 'id', descending: true },
    { field: 'id', descending: false },
  ]);
  // Existing browser grammar tolerates this spelling; schema/path validation is elsewhere.
  assert.deepEqual(addressSortValue('owner..name'), [{ field: 'owner..name', descending: false }]);
  for (const value of ['', ' id', 'id ', 'id, -name', 'id desc', '+id', 'id,', '1id', '名字', 'id;drop']) {
    assert.equal(addressSortValue(value), undefined, value);
  }
});

test('a tab word names its tab in any case and in the spelling a link writes', () => {
  const segment = { label: 'High value', slug: 'high_value' };
  for (const word of ['high_value', 'HIGH_VALUE', 'high-value']) assert.equal(namesTab(segment, word), true, word);
  // A label with a space is not an address word; the refusal names the word to say instead.
  assert.equal(namesTab(segment, 'High value'), false);
  assert.equal(namesTab({ label: 'Open' }, 'OPEN'), true);
  for (const word of ['high', 'value', '', null, undefined]) assert.equal(namesTab(segment, word), false, String(word));
  /* A word in another script spells to nothing in an address: it names only a tab whose own word is that word. */
  assert.equal(namesTab({ label: '新しい', slug: '新しい' }, '古い'), false);
  assert.equal(namesTab({ label: '新しい', slug: '新しい' }, '新しい'), true);
});
