/**
 * `fillBuckets` (autoBucket.ts, exported from `@mistriwork/mistri/page`): a breakdown's empty periods put back as zero
 * in the App's calendar, so a chart over a window draws every day of it. The periods are read in the App's zone, not
 * the machine's: a moment just past midnight UTC is still the evening before in New York.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillBuckets } from '../packages/engine/src/shared/autoBucket.js';

test('fills the window in the App zone, not UTC', () => {
  /* 03:30 UTC on 4 March is 22:30 on 3 March in New York: the window ends on the 3rd there. */
  const rows = [{ key: '2026-03-01', value: 4 }];
  const out = fillBuckets(rows, {
    unit: 'day',
    from: new Date('2026-02-28T15:00:00Z'),
    to: new Date('2026-03-04T03:30:00Z'),
    timeZone: 'America/New_York',
  });
  assert.deepEqual(out, [
    { key: '2026-02-28', value: 0, filled: true },
    { key: '2026-03-01', value: 4 },
    { key: '2026-03-02', value: 0, filled: true },
    { key: '2026-03-03', value: 0, filled: true },
  ]);
  /* The same instants in Kolkata (UTC+5:30) run a day further. */
  const east = fillBuckets(rows, {
    unit: 'day',
    from: new Date('2026-02-28T15:00:00Z'),
    to: new Date('2026-03-04T03:30:00Z'),
    timeZone: 'Asia/Kolkata',
  });
  assert.equal(east.at(-1)?.key, '2026-03-04');
});

test('keys by the server name of the column and zeroes the measure fields', () => {
  const rows = [
    { 'month(created_at)': '2026-01', count: 3, 'sum(amount)': 120 },
    { 'month(created_at)': '2026-04', count: 1, 'sum(amount)': 40 },
  ];
  const out = fillBuckets(rows, { unit: 'month', key: 'month(created_at)' });
  assert.deepEqual(
    out.map((row) => [row['month(created_at)'], row.count, row['sum(amount)'], 'filled' in row]),
    [
      ['2026-01', 3, 120, false],
      ['2026-02', 0, 0, true],
      ['2026-03', 0, 0, true],
      ['2026-04', 1, 40, false],
    ],
  );
});

test('weeks and quarters step by their own period; a key the unit does not spell leaves the rows alone', () => {
  const weeks = fillBuckets([{ key: '2026-03-02', value: 1 }], { unit: 'week', to: new Date('2026-03-18T12:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(
    weeks.map((row) => row.key),
    ['2026-03-02', '2026-03-09', '2026-03-16'],
  );
  const quarters = fillBuckets([], {
    unit: 'quarter',
    from: new Date('2025-11-01T12:00:00Z'),
    to: new Date('2026-05-01T12:00:00Z'),
    timeZone: 'UTC',
  });
  assert.deepEqual(
    quarters.map((row) => row.key),
    ['2025-Q4', '2026-Q1', '2026-Q2'],
  );
  const odd = [{ key: 'open', value: 2 }];
  assert.deepEqual(fillBuckets(odd, { unit: 'day', from: new Date('2026-01-01') }), odd);
});
