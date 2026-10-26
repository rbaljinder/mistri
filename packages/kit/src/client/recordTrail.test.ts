/**
 * Stepping through the list a record was opened from: within the page, past
 * it by reading the list's next or previous page, and without a total (an
 * API), where a full page is the only sign that more follow.
 */
import { expect, test, vi } from 'vitest';
import { canStep, stepTrail, trailFor, trailListFor, trailPosition, type TrailList, type TrailRecord } from './recordTrail.js';

const records = (from: number, count: number): TrailRecord[] =>
  Array.from({ length: count }, (_, i) => ({ key: { id: from + i }, label: `Task ${from + i}` }));

test('a record opened from a list knows where it sits, and a lone record with nothing past it has no trail', () => {
  const trail = trailFor('task', { id: 3 }, records(1, 5))!;
  expect(trail.index).toBe(2);
  expect(trailPosition(trail)).toEqual({ at: 3, of: 5 });
  // Keys compare by value, whatever their type or column order.
  expect(trailFor('task', { id: '3' }, records(1, 5))!.index).toBe(2);
  expect(trailFor('task', { id: 9 }, records(1, 5))).toBeUndefined();
  expect(trailFor('task', { id: 1 }, records(1, 1))).toBeUndefined();
  // One record on a page that is not the whole list still steps.
  expect(trailFor('task', { id: 21 }, records(21, 1), { query: 'task', offset: 20, limit: 20, total: 21 })).toMatchObject({ index: 0 });
});

test('a step within the page moves the index and reads nothing', async () => {
  const read = vi.fn();
  const trail = trailFor('task', { id: 2 }, records(1, 3))!;
  expect((await stepTrail(trail, 1, read))!.index).toBe(2);
  expect((await stepTrail(trail, -1, read))!.index).toBe(0);
  expect(read).not.toHaveBeenCalled();
});

test("past the page, the list's own next and previous pages are read with its question", async () => {
  const list: TrailList = { query: 'task status = open sort due_on', offset: 20, limit: 20, total: 45 };
  const read = vi.fn(async (_table: string, _list: TrailList, offset: number) => records(offset + 1, Math.min(20, 45 - offset)));
  const last = trailFor('task', { id: 40 }, records(21, 20), list)!;
  expect(trailPosition(last)).toEqual({ at: 40, of: 45 });
  const next = (await stepTrail(last, 1, read))!;
  expect(read).toHaveBeenLastCalledWith('task', list, 40);
  expect(next.records[next.index]).toEqual({ key: { id: 41 }, label: 'Task 41' });
  expect(trailPosition(next)).toEqual({ at: 41, of: 45 });
  const back = (await stepTrail(trailFor('task', { id: 21 }, records(21, 20), list)!, -1, read))!;
  expect(read).toHaveBeenLastCalledWith('task', list, 0);
  expect(back.records[back.index].key).toEqual({ id: 20 });
  // The end of the list is the end: no read past the total.
  const end = trailFor('task', { id: 45 }, records(41, 5), { ...list, offset: 40 })!;
  expect(canStep(end, 1)).toBe(false);
  read.mockClear();
  expect(await stepTrail(end, 1, read)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

test('without a total, a full page means more may follow, and a short or empty one ends the list', async () => {
  const list: TrailList = { query: 'contacts', offset: 0, limit: 3 };
  const full = trailFor('contacts', { id: 3 }, records(1, 3), list)!;
  expect(trailPosition(full)).toEqual({ at: 3 });
  expect(canStep(full, 1)).toBe(true);
  expect(await stepTrail(full, 1, async () => [])).toBeUndefined();
  const short = trailFor('contacts', { id: 2 }, records(1, 2), list)!;
  expect(canStep({ ...short, index: 1 }, 1)).toBe(false);
});

test("a room's answer says which page of its list it is; an estimate is no total, and an answer without its page is no list", () => {
  expect(trailListFor('invoice', { limit: 50, offset: 0, total: 2 })).toEqual({ query: 'invoice', offset: 0, limit: 50, total: 2 });
  expect(trailListFor('invoice paid = true', { limit: 2, offset: 4 })).toEqual({ query: 'invoice paid = true', offset: 4, limit: 2 });
  expect(trailListFor('invoice', { limit: 20, total: 90_000, exactTotal: false })).toEqual({ query: 'invoice', offset: 0, limit: 20 });
  expect(trailListFor('invoice', { total: 2 })).toBeUndefined();
});
