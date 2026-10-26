import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuCount } from '../packages/engine/src/shared/menuCounts.ts';

/* A pick list's machine: two states of work, one final. */
const machine = { column: 'status', states: [{ value: 'to_pick' }, { value: 'packed' }, { value: 'shipped', final: true as const }] };

test('a list is counted where its condition is work, and only work past its date is late', () => {
  const counted = (condition: string, count?: boolean) => menuCount(condition, machine, count);
  // (a) the machine's unfinished states.
  assert.deepEqual(counted('status = to_pick'), { counted: true, late: false });
  assert.deepEqual(counted('status != shipped'), { counted: true, late: false });
  assert.deepEqual(counted('status in (to_pick, packed)'), { counted: true, late: false });
  assert.deepEqual(counted('status not in (shipped)'), { counted: true, late: false });
  assert.equal(counted('status = shipped').counted, false);
  assert.equal(counted('status in (packed, shipped)').counted, false);
  // A path through a reference is another table's column, not this machine's.
  assert.equal(counted('order_id.status = to_pick').counted, false);
  // (b) a date at or before today, said late.
  assert.deepEqual(counted('ship_by <= today'), { counted: true, late: true });
  assert.deepEqual(counted('due before today and done = false'), { counted: true, late: true });
  // (c) the reader.
  assert.deepEqual(counted('owner = me'), { counted: true, late: false });
  assert.equal(counted('name = memo').counted, false);
  // A plain filter, or the whole table, is not work.
  assert.equal(counted('status = active').counted, false);
  assert.equal(menuCount('status = active', undefined).counted, false);
  assert.equal(counted('').counted, false);
  assert.equal(counted('created_on = last 30 days').counted, false);
  // The list's own say wins either way.
  assert.deepEqual(counted('', true), { counted: true, late: false });
  assert.deepEqual(counted('status = to_pick', false), { counted: false, late: false });
});
