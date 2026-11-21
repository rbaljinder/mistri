/**
 * A dated chart's empty periods stood at zero (bucketFill.ts): over the window its read names up to today, between the
 * first and last period answered where it names none, and not at all for a measure that is not zero where nothing
 * happened, a shape that does not run along time, or `fill: false`.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { filledAnswer, filledHookRows } from './bucketFill.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 2, 5, 12));
});
afterEach(() => vi.useRealTimers());

const answer = () => ({
  columns: ['closed_on', 'count'],
  rows: [
    { closed_on: '2026-03-01', count: 2 },
    { closed_on: '2026-03-03', count: 1 },
  ],
});

test('a read with no window fills between the periods it answered', () => {
  const filled = filledAnswer(answer(), { by: 'day closed_on', measure: 'count', shape: 'line' });
  expect(filled?.rows).toEqual([
    { closed_on: '2026-03-01', count: 2 },
    { closed_on: '2026-03-02', count: 0, filled: true },
    { closed_on: '2026-03-03', count: 1 },
  ]);
});

test('a read over a window fills the whole window, and stops at today', () => {
  const filled = filledAnswer(answer(), { by: 'day(closed_on)', measure: 'count', query: 'closed_on = this month', shape: 'bar' });
  expect(filled?.rows.map((row) => row.closed_on)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  // `observed` keeps to what was answered, whatever the window.
  const observed = filledAnswer(answer(), { by: 'day closed_on', query: 'closed_on = this month', fill: 'observed' });
  expect(observed?.rows).toHaveLength(3);
});

test('nothing is filled where zero is not what an empty period means', () => {
  const asked = answer();
  expect(filledAnswer(asked, { by: 'day closed_on', fill: false })).toBe(asked);
  expect(filledAnswer(asked, { by: 'day closed_on', measure: 'avg amount' })).toBe(asked);
  expect(filledAnswer(asked, { by: 'day closed_on', shape: 'donut' })).toBe(asked);
  expect(filledAnswer(asked, { by: 'stage' })).toBe(asked);
});

test('the same answer and ask give the same object back, so a memo under the chart holds', () => {
  const asked = answer();
  const ask = { by: 'day closed_on', measure: 'count' };
  expect(filledAnswer(asked, ask)).toBe(filledAnswer(asked, ask));
});

test("a hook's rows are filled under the keys the server names them by, even when the window answered none", () => {
  const rows = filledHookRows([{ 'month(closed_on)': '2026-01', 'sum(amount)': 40 }], {
    by: 'month closed_on',
    measure: 'sum amount',
    query: 'closed_on = this year',
  });
  expect(rows).toEqual([
    { 'month(closed_on)': '2026-01', 'sum(amount)': 40 },
    { 'month(closed_on)': '2026-02', 'sum(amount)': 0, filled: true },
    { 'month(closed_on)': '2026-03', 'sum(amount)': 0, filled: true },
  ]);
  expect(filledHookRows([], { by: 'month closed_on', measure: 'sum amount as total', query: 'closed_on = this year' })).toEqual([
    { 'month(closed_on)': '2026-01', total: 0, filled: true },
    { 'month(closed_on)': '2026-02', total: 0, filled: true },
    { 'month(closed_on)': '2026-03', total: 0, filled: true },
  ]);
});
