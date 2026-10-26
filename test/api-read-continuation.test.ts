import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeApiReadContinuation } from '../packages/mistri/src/server/api/apiReadContinuation.js';
import type { ViewDef } from '../packages/engine/src/shared/viewPaths.js';
const view: ViewDef = {
  id: 'list:item',
  name: 'List',
  base: 'item',
  columns: [{ path: 'id' }],
  limit: 51,
  orderBy: [
    { path: 'rank', direction: 'desc' },
    { path: 'id', direction: 'asc' },
  ],
  filter: {
    groups: [
      [
        { path: 'status', op: '=', value: 'open' },
        { path: 'rank', op: '>=', value: 1 },
      ],
      [
        { path: 'owner_id', op: '=', value: 7 },
        { path: 'rank', op: '>=', value: 1 },
      ],
    ],
  },
};
const boundary = [
  [{ field: 'rank', operator: '<' as const, value: 3 }],
  [
    { field: 'rank', operator: '=' as const, value: 3 },
    { field: 'id', operator: '>' as const, value: 9 },
  ],
];

test('boundary AND distributes across every standing/refinement branch; count retains original definition', () => {
  const input = structuredClone(view),
    result = composeApiReadContinuation(input, boundary);
  assert.equal(result.rows.filter!.groups.length, 4);
  for (let left = 0; left < 2; left++)
    for (let right = 0; right < 2; right++) {
      const group = result.rows.filter!.groups[left * 2 + right];
      assert.deepEqual(JSON.parse(JSON.stringify(group.slice(0, 2))), view.filter!.groups[left]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(group.slice(2))),
        boundary[right].map((term) => ({ path: term.field, op: term.operator, value: term.value })),
      );
    }
  assert.deepEqual(JSON.parse(JSON.stringify(result.count)), view);
  assert.equal(result.rows.limit, 51);
  assert.deepEqual(result.rows.orderBy, result.count.orderBy);
  input.filter!.groups[0][0].value = 'changed';
  assert.equal(result.count.filter!.groups[0][0].value, 'open');
  assert.ok(Object.isFrozen(result.rows.filter!.groups[0][0]));
  assert.ok(Object.isFrozen(result.count.columns));
  assert.equal(result.authorization, 'pending');
  assert.equal(result.cursorVerification, 'pending');
});
test('unfiltered and empty-group inputs match existing SQL filter semantics', () => {
  for (const filter of [undefined, { groups: [] }, { groups: [[]] }]) {
    const { filter: _filter, ...plain } = view;
    const result = composeApiReadContinuation({ ...plain, ...(filter ? { filter } : {}) }, boundary);
    assert.equal(result.rows.filter!.groups.length, 2);
    assert.equal(result.rows.filter!.groups[0].length, 1);
  }
  const mixed = composeApiReadContinuation({ ...view, filter: { groups: [[], view.filter!.groups[0]] } }, boundary);
  assert.equal(mixed.rows.filter!.groups.length, 2);
  assert.equal(mixed.rows.filter!.groups[0].length, 3);
});
test('Cartesian branch, per-branch and combined-term bounds refuse before expansion', () => {
  const term = { path: 'id', op: '=' as const, value: 1 },
    tail = { field: 'id', operator: '>' as const, value: 1 };
  assert.throws(() =>
    composeApiReadContinuation({ ...view, filter: { groups: Array.from({ length: 65 }, () => [term]) } }, [[tail], [tail]]),
  );
  assert.throws(() => composeApiReadContinuation({ ...view, filter: { groups: [Array(128).fill(term)] } }, [[tail]]));
  assert.throws(() =>
    composeApiReadContinuation({ ...view, filter: { groups: Array.from({ length: 32 }, () => Array(32).fill(term)) } }, [[tail], [tail]]),
  );
  const accepted = composeApiReadContinuation({ ...view, filter: { groups: Array.from({ length: 32 }, () => Array(31).fill(term)) } }, [
    [tail],
    [tail],
  ]);
  assert.equal(accepted.rows.filter!.groups.flat().length, 2048);
});
test('malformed/empty boundary, overriding text and hostile descriptor input cannot silently remove constraints', () => {
  for (const bad of [
    [],
    [[]],
    [[{ field: 'id', operator: '>=', value: 1 }]],
    [[{ field: 'id', operator: '>', value: null }]],
    [[{ field: 'id', operator: '>', value: 1, extra: true }]],
    [[{ field: 'id.x', operator: '>', value: 1 }]],
  ]) {
    assert.throws(() => composeApiReadContinuation(view, bad as never));
  }
  assert.throws(() => composeApiReadContinuation({ ...view, text: 'item' }, boundary));
  let reads = 0;
  const hostile = { ...view };
  Object.defineProperty(hostile, 'filter', {
    enumerable: true,
    get() {
      reads++;
      return view.filter;
    },
  });
  assert.throws(() => composeApiReadContinuation(hostile, boundary));
  assert.throws(() => composeApiReadContinuation(new Proxy(view, {}), boundary));
  assert.throws(() => composeApiReadContinuation(view, Array(1) as never));
  assert.equal(reads, 0);
});
