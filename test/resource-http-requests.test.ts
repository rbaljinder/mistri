import assert from 'node:assert/strict';
import { test } from 'node:test';
import { equalityFilter, pathEqualityFilter, recordKey, writeValues } from '../packages/kit/src/client/resourceRequests.js';

declare const request: typeof import('../packages/kit/src/client/core.js').api;
// Check the actual JSDoc-typed client boundary, not a second function signature.
function clientContracts(
  broadPrefix: `/api/${string}`,
  broadSuffix: `${string}/update`,
  broadSelectors: `/api/${string}?conn=${string}`,
  suffixSelectors: `${string}/update?conn=${string}`,
  broadTail: `/api/query${string}`,
  known: '/api/query' | '/api/count',
  knownSelectors: `/api/query?conn=${string}` | `/api/count?conn=${string}`,
  ddl: `/api/ddl?table=${string}`,
  mixed: '/api/query' | '/api/schema',
  fragmentUnion: '/api/query' | '/api/query#fragment',
) {
  void request('/api/query', { table: 'item', conn: null });
  void request('/api/query?conn=demo', { table: 'item', filter: equalityFilter({ id: 1 }) });
  void request('/api/insert', { table: 'item', values: {} });
  void request('/api/revert', {});
  void request('/api/revert', { confirm: true, expectedId: 1 });
  void request('/api/schema');
  void request(known, { table: 'item' });
  void request(knownSelectors, { table: 'item' });
  void request(ddl);
  void request('/api/commands/execute', { command: 'complete' });
  // @ts-expect-error A broad template can name /api/update; it is not a non-resource route.
  void request(broadPrefix, { q: 'item' });
  // @ts-expect-error A variable prefix can also name a known resource operation.
  void request(broadSuffix, { q: 'item' });
  // @ts-expect-error Selectors do not make a broad route pattern safe.
  void request(broadSelectors, { q: 'item' });
  // @ts-expect-error A broad prefix remains ambiguous after stripping selectors.
  void request(suffixSelectors, { q: 'item' });
  // @ts-expect-error An arbitrary suffix can be empty, selecting /api/query.
  void request(broadTail, { q: 'item' });
  // @ts-expect-error Broad resource patterns cannot omit the operation body either.
  void request(broadPrefix);
  // @ts-expect-error Even a plausible body cannot establish which broad route is selected.
  void request(broadSuffix, { table: 'item', key: { id: 1 }, values: {} });
  // @ts-expect-error Bounded known unions still check their operation bodies.
  void request(known, { q: 'item' });
  // @ts-expect-error Bounded query-string unions retain the same body checks.
  void request(knownSelectors, { q: 'item' });
  // @ts-expect-error A non-resource alternative cannot weaken a resource route's body.
  void request(mixed, { q: 'item' });
  // @ts-expect-error Mixed resource/non-resource routes must be narrowed before dispatch.
  void request(mixed, { table: 'item' });
  // @ts-expect-error A valid union member cannot hide a fragment-bearing alternative.
  void request(fragmentUnion, { table: 'item' });
  // @ts-expect-error A known resource route requires its operation body.
  void request('/api/query');
  // @ts-expect-error Another route's payload cannot widen the path to string.
  void request('/api/update', { q: 'item' });
  // @ts-expect-error Query-string selectors do not erase the operation contract.
  void request('/api/query?conn=demo', { q: 'item' });
  // @ts-expect-error Fetch discards fragments; they cannot select an untyped fallback.
  void request('/api/update#x', { q: 'item' });
  const dynamic: string = '/api/update';
  // @ts-expect-error A widened route must be narrowed before selecting an operation body.
  void request(dynamic, { q: 'item' });
  // @ts-expect-error Undo confirmation requires the preview's expectedId.
  void request('/api/revert', { confirm: true });
  // @ts-expect-error Client data cannot provide server principal authority.
  void request('/api/update', { table: 'item', key: { id: 1 }, values: { name: 'new' }, principal: 'other' });
  // @ts-expect-error A missing value is not an explicitly requested database default.
  void request('/api/insert', { table: 'item' });
  // @ts-expect-error Keys retain string/number values, not arbitrary objects.
  void request('/api/delete', { table: 'item', key: { id: {} } });
  void request('/api/run', { q: 'item' }).then((data) => {
    // @ts-expect-error HTTP 200 may still be a parser failure with no rows.
    return data.rows.length;
  });
}
void clientContracts;

test('request keys preserve large integer strings and detach the submitted key', () => {
  const input = { id: '9007199254740993', part: 2 };
  const key = recordKey(input);
  input.id = 'changed';
  assert.deepEqual(key, { id: '9007199254740993', part: 2 });
});

test('missing, non-scalar and nonfinite keys refuse rather than becoming a wider request', () => {
  for (const value of [
    undefined,
    null,
    {},
    [],
    { id: undefined },
    { id: null },
    { id: true },
    { id: 1n },
    { id: NaN },
    { id: Infinity },
    { id: {} },
    { '': 1 },
  ]) {
    assert.throws(() => recordKey(value), /no usable key/);
  }
});

test('record and path filters share scalar binding without number coercion', () => {
  const values = { id: '9007199254740993', active: false, missing: null, amount: 2.5 };
  assert.deepEqual(equalityFilter(values), {
    groups: [
      [
        { column: 'id', op: '=', value: values.id },
        { column: 'active', op: '=', value: false },
        { column: 'missing', op: '=', value: null },
        { column: 'amount', op: '=', value: 2.5 },
      ],
    ],
  });
  assert.deepEqual(pathEqualityFilter({ 'owner.id': values.id }), {
    groups: [[{ path: 'owner.id', op: '=', value: values.id }]],
  });
});

test('unsupported filter/write values refuse before JSON could silently drop or coerce them', () => {
  for (const value of [undefined, NaN, Infinity, 1n, [], {}, () => 1, Symbol('value')]) {
    for (const build of [equalityFilter, pathEqualityFilter, writeValues]) {
      assert.throws(() => build({ value }), /structured data/);
    }
  }
});

test('write values retain explicit defaults, null, false and empty text as distinct intents', () => {
  assert.deepEqual(writeValues({}), {});
  const input = { empty: '', missing: null, flag: false, amount: 0 };
  const result = writeValues(input);
  input.amount = 1;
  assert.deepEqual(result, { empty: '', missing: null, flag: false, amount: 0 });
});

test('a column named __proto__ remains data in keys and write values', () => {
  const value = JSON.parse('{"__proto__":"literal"}');
  for (const copy of [recordKey(value), writeValues(value)]) {
    assert.equal(Object.getPrototypeOf(copy), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value, 'literal');
  }
});
