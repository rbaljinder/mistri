/**
 * `auto`, the time unit a chart chooses when its author did not fix one (autoBucket.ts): the unit as a pure function
 * of the span, the way the data falls and the measure; the measure taken apart so it can be added up again; and what
 * the dashboard check says about the word.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoKeyOf,
  bucketKey,
  chooseUnit,
  coarsen,
  planMeasure,
  readUnit,
  spanDaysBetween,
  spanDaysOf,
  trendPoints,
  unitForSpan,
  withUnit,
} from '../packages/engine/src/shared/autoBucket.js';
import { windowed } from '../packages/engine/src/shared/dashboardAsks.js';
import { sparkText, sparkWindow } from '../packages/engine/src/shared/dashboardTrend.js';
import { dateWindow } from '../packages/engine/src/shared/queryDates.js';
import { appIndexWarnings } from '../packages/mistri/src/shared/appIndexWarnings.js';
import { parseAppConfig, resolveViews, withRollups, viewOrder, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const NOW = new Date('2026-10-16T12:00:00Z');

describe('the base unit follows the span', () => {
  const cases: Array<[days: number, unit: string]> = [
    [1, 'day'],
    [34, 'day'],
    [45, 'day'],
    [46, 'week'],
    [90, 'week'],
    [26 * 7, 'week'],
    [26 * 7 + 1, 'month'],
    [365, 'month'],
    [1095, 'month'],
    [1096, 'quarter'],
    [4000, 'quarter'],
  ];
  for (const [days, unit] of cases) test(`${days} days is read as ${unit}`, () => assert.equal(unitForSpan(days), unit));

  test('a window the date grammar bounds is the span; one it does not leaves the data to say', () => {
    assert.equal(spanDaysOf('status = open and created_at = last 30 days', 'created_at', NOW), 31);
    assert.equal(spanDaysOf('created_at = last 12 months', 'created_at', NOW), 366);
    assert.equal(spanDaysOf('status = open', 'created_at', NOW), null);
    assert.equal(spanDaysOf('created_at = last 30 days', undefined, NOW), null);
    assert.equal(spanDaysBetween('2026-01-01', '2026-01-31T10:00:00Z'), 31);
    assert.equal(spanDaysBetween(null, '2026-01-31'), null);
  });
});

describe('density steps a sparse answer up when the measure adds up again', () => {
  const days = (...dates: string[]) => dates;
  const table: Array<{ name: string; spanDays: number; keys: string[]; addsUp: boolean; unit: string }> = [
    {
      name: '34 days with three days of data stays a day when the data is itself close together',
      spanDays: 34,
      keys: days('2026-09-14', '2026-09-15', '2026-09-16'),
      addsUp: true,
      unit: 'day',
    },
    {
      // Three days across 34: 3 of 34 days hold data, a week would hold 3 of 6 and stay above four? 6 weeks >= 4.
      name: 'three days spread over 34 days steps up to a week',
      spanDays: 34,
      keys: days('2026-09-01', '2026-09-15', '2026-10-04'),
      addsUp: true,
      unit: 'week',
    },
    {
      name: 'the same data with a median keeps the unit the span chose',
      spanDays: 34,
      keys: days('2026-09-01', '2026-09-15', '2026-10-04'),
      addsUp: false,
      unit: 'day',
    },
    {
      name: 'a dense answer is left alone',
      spanDays: 14,
      keys: Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`),
      addsUp: true,
      unit: 'day',
    },
    {
      name: 'it stops before fewer than four buckets remain',
      spanDays: 40,
      keys: days('2026-09-01', '2026-10-09'),
      addsUp: true,
      // 39 days sparse -> weeks (6 buckets, 2 filled: sparse) -> months would leave 2 buckets, under four.
      unit: 'week',
    },
    {
      name: 'no data keeps the span unit',
      spanDays: 34,
      keys: [],
      addsUp: true,
      unit: 'day',
    },
    {
      name: 'a quarter is as coarse as it goes',
      spanDays: 2000,
      keys: days('2020-Q1', '2026-Q3'),
      addsUp: true,
      unit: 'quarter',
    },
  ];
  for (const c of table) {
    test(c.name, () => assert.equal(chooseUnit({ spanDays: c.spanDays, keys: c.keys, addsUp: c.addsUp }).unit, c.unit));
  }

  test('a year of sparse days climbs to months, no further than the buckets allow', () => {
    const keys = ['2025-11-03', '2026-01-20', '2026-04-02', '2026-06-30', '2026-09-12'];
    // 365 days is a month by span; five months of eleven hold data (> a third): it stays.
    assert.equal(chooseUnit({ spanDays: 365, keys, addsUp: true }).unit, 'month');
    const sparse = ['2025-11-03', '2026-10-12'];
    // two of twelve months hold data: a quarter has five buckets, enough to step to.
    assert.equal(chooseUnit({ spanDays: 365, keys: sparse, addsUp: true }).unit, 'quarter');
  });

  test('days and weeks are read as days when they add up, so a week never straddles a month', () => {
    assert.equal(readUnit('week', true), 'day');
    assert.equal(readUnit('week', false), 'week');
    assert.equal(readUnit('month', true), 'month');
  });
});

describe('periods are named as the server names them', () => {
  test('a week is its first day, in the locale week', () => {
    assert.equal(bucketKey('2026-10-14', 'week', 1), '2026-10-12');
    assert.equal(bucketKey('2026-10-14', 'week', 7), '2026-10-11');
    assert.equal(bucketKey('2026-10-12', 'week', 1), '2026-10-12');
  });
  test('months and quarters', () => {
    assert.equal(bucketKey('2026-10-14', 'month'), '2026-10');
    assert.equal(bucketKey('2026-11', 'quarter'), '2026-Q4');
    assert.equal(bucketKey('2026-Q2', 'quarter'), '2026-Q2');
  });
});

describe('a measure is taken apart so the buckets can be added up', () => {
  test('count, sum, min and max are one aggregate each', () => {
    assert.deepEqual(planMeasure('count')?.reads, ['count']);
    assert.deepEqual(planMeasure('sum total')?.reads, ['sum total']);
    assert.deepEqual(planMeasure('max total as peak')?.combine, ['max']);
    assert.deepEqual(planMeasure(undefined)?.reads, ['count']);
  });

  test('avg is read as sum and count, so a week of days averages by its rows, not by its days', () => {
    const plan = planMeasure('avg total')!;
    assert.deepEqual(plan.reads, ['sum total', 'count total']);
    // Day one: 1 row of 10. Day two: 3 rows of 20 each. The week's average is 70/4, not the mean of 10 and 20.
    const week = coarsen(
      [
        { key: '2026-10-12', terms: [10, 1] },
        { key: '2026-10-13', terms: [60, 3] },
      ],
      plan,
      'week',
    );
    assert.deepEqual(week, [{ key: '2026-10-12', value: 17.5 }]);
  });

  test('arithmetic of aggregates is evaluated after they are added, never summed as a ratio', () => {
    const plan = planMeasure('sum paid / sum total')!;
    assert.deepEqual(plan.reads, ['sum paid', 'sum total']);
    const month = coarsen(
      [
        { key: '2026-10-01', terms: [5, 10] },
        { key: '2026-10-02', terms: [15, 10] },
      ],
      plan,
      'month',
    );
    assert.deepEqual(month, [{ key: '2026-10', value: 1 }]);
    assert.equal(planMeasure('sum a + sum b * 2')?.value([1, 2]), 5);
    assert.equal(planMeasure('sum a / sum b')?.value([1, 0]), null);
  });

  test('min and max keep the extreme of the buckets they take in', () => {
    const rows = [
      { key: '2026-10-01', terms: [4] },
      { key: '2026-10-02', terms: [9] },
    ];
    assert.deepEqual(coarsen(rows, planMeasure('max total')!, 'month'), [{ key: '2026-10', value: 9 }]);
    assert.deepEqual(coarsen(rows, planMeasure('min total')!, 'month'), [{ key: '2026-10', value: 4 }]);
  });

  test('a second key is coarsened within: a cross is a period and a series', () => {
    const rows = [
      { key: '2026-10-01', series: 'paid', terms: [3] },
      { key: '2026-10-02', series: 'paid', terms: [4] },
      { key: '2026-10-02', series: 'open', terms: [1] },
    ];
    assert.deepEqual(coarsen(rows, planMeasure('sum amount')!, 'month'), [
      { key: '2026-10', series: 'open', value: 1 },
      { key: '2026-10', series: 'paid', value: 7 },
    ]);
  });

  test('median, distinct, a conditional count and words it does not read follow the span only', () => {
    for (const measure of ['median total', 'count distinct customer_id', 'count when [status = open]', 'sum (a)', 'sum']) {
      assert.equal(planMeasure(measure), null, measure);
    }
  });
});

describe('a metric’s trend is drawn over its window', () => {
  /* Local noon: the date grammar's windows are the reader's calendar days. */
  const now = new Date(2026, 9, 16, 12);
  const metric = { kind: 'metric', table: 'charge', query: 'kind = rent', over: 'due_on', measure: 'sum amount' };

  test("the reader's window, else the author's own, in the span's unit; none under four periods", () => {
    const picked = windowed(metric, 'last 30 days');
    assert.deepEqual(sparkWindow(picked, now), { phrase: 'last 30 days', unit: 'day', read: 'day' });
    assert.equal(sparkText(picked), 'charge kind = rent and due_on = last 30 days sum amount by day due_on limit 400');
    // Weeks are read as days and added up here, so a week never crosses a month at the server.
    assert.deepEqual(sparkWindow(windowed(metric, 'last 90 days'), now), { phrase: 'last 90 days', unit: 'week', read: 'day' });
    assert.deepEqual(sparkWindow(windowed(metric, 'last 12 months'), now), { phrase: 'last 12 months', unit: 'month', read: 'month' });
    assert.equal(sparkWindow({ ...metric, query: 'kind = rent and due_on = this month' }, now)?.phrase, 'this month');
    assert.equal(sparkWindow(windowed(metric, 'today'), now), null);
    // No window and no `spark: true`: no trend is asked. With it, the last twelve months as before.
    assert.equal(sparkText(metric), null);
    assert.equal(sparkText({ ...metric, spark: true }), 'charge kind = rent and due_on = last 12 months sum amount by month due_on');
  });

  test('a count or a sum puts back the empty periods as zero to today, and adds days into weeks', () => {
    const window = dateWindow('last 7 days', now);
    const days = [
      { key: '2026-10-11', value: 2 },
      { key: '2026-10-14', value: 5 },
    ];
    assert.deepEqual(
      trendPoints(days, 'day', 'day', 'count', window, now).map((p) => p.value),
      [0, 0, 2, 0, 0, 5, 0, 0],
    );
    assert.equal(trendPoints(days, 'day', 'day', 'count', window, now).at(-1)?.key, '2026-10-16', 'never past today');
    const weeks = trendPoints(days, 'day', 'week', 'sum amount as owed', window, now);
    assert.deepEqual(weeks, [
      { key: '2026-10-05', value: 2 },
      { key: '2026-10-12', value: 5 },
    ]);
    // An average of no rows is no value: drawn as read.
    assert.deepEqual(trendPoints(days, 'day', 'day', 'avg amount', window, now), days);
  });
});

describe('the word in a by', () => {
  test('is found in any key and written as the unit the chart chose', () => {
    assert.deepEqual(autoKeyOf('auto created_at'), { index: 0, column: 'created_at' });
    assert.deepEqual(autoKeyOf('channel, auto created_at'), { index: 1, column: 'created_at' });
    assert.equal(autoKeyOf('month created_at'), null);
    assert.equal(autoKeyOf('automatic'), null);
    assert.equal(withUnit('auto created_at', 'week'), 'week created_at');
    assert.equal(withUnit('channel, auto created_at', 'month'), 'channel, month created_at');
  });
});

describe('the check', () => {
  const col = (name: string, type = 'text') => ({ name, type, nullable: true, primaryKey: false });
  const SCHEMA = {
    label: 'demo',
    dialect: 'sqlite',
    readAt: '',
    tables: [{ name: 'account', schema: '', id: 'account', columns: [col('status'), col('created_at', 'date')], isView: false }],
    foreignKeys: [],
  } as unknown as DatabaseSchema;
  const app = (section: Record<string, unknown>, view: Record<string, unknown> = {}): AppDef =>
    parseAppConfig(
      {
        name: 'x',
        views: { d: { kind: 'dashboard', label: 'D', sections: [{ kind: 'chart', from: 'account', ...section }], ...view } },
        home: 'd',
        nav: ['d'],
        resources: { account: {} },
      },
      'test/app.json',
    );
  const resolved = (def: AppDef) => {
    const views = resolveViews(def, withRollups(def, SCHEMA));
    return viewOrder({ views, nav: def.nav }).map((key) => views[key])[0] as { error?: string; sections: Array<{ error?: string }> };
  };

  test('auto on a date column is a chart like any other', () => {
    const view = resolved(app({ by: 'auto created_at', over: 'created_at' }));
    assert.equal(view.sections[0].error ?? view.error, undefined);
  });

  test('auto on a column that is not a date is refused in the words a window on one is', () => {
    const view = resolved(app({ by: 'auto status' }));
    assert.match(view.sections[0].error ?? view.error ?? '', /"status" is text, so it cannot be cut by time \[not-a-date\]/);
  });

  test('both keys of a matrix and a heatmap must be fixed', () => {
    assert.throws(() => app({ kind: 'matrix', by: 'status, auto created_at' }), /matrix, whose keys must both be fixed/);
    assert.throws(() => app({ shape: 'heatmap', by: 'weekday created_at, auto created_at' }), /heatmap, whose keys must both be fixed/);
    assert.throws(() => app({ kind: 'breakdown', by: 'auto created_at' }), /only a chart takes/);
    assert.throws(() => app({ by: 'auto' }), /cuts a date column, like "auto created_at"/);
  });

  test('a fixed day over a window longer than a quarter is advised toward auto, and auto is not', () => {
    const day = appIndexWarnings(app({ by: 'day created_at', over: 'created_at', title: 'Signups' }), [], SCHEMA);
    assert.equal(day.length, 1);
    assert.match(day[0], /chart "Signups": `day` over `last 12 months` draws 365 bars, use `auto`/);
    assert.deepEqual(appIndexWarnings(app({ by: 'auto created_at', over: 'created_at' }), [], SCHEMA), []);
    assert.deepEqual(appIndexWarnings(app({ by: 'month created_at', over: 'created_at' }), [], SCHEMA), []);
    assert.deepEqual(
      appIndexWarnings(app({ by: 'day created_at', over: 'created_at' }, { windows: ['last 30 days', 'last 90 days'] }), [], SCHEMA),
      [],
    );
    assert.deepEqual(appIndexWarnings(app({ by: 'day created_at' }), [], SCHEMA), [], 'no window narrows a section with no over');
  });
});
