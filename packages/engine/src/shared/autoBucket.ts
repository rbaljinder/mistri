/**
 * The time unit a chart cuts its dates into when its author did not fix one: `chart('Signups', 'account', 'auto
 * created_at', { over: 'created_at' })`.
 *
 * A fixed unit is right for one window and wrong for the next: `day` over 34 days with three days of data drew 34
 * bars, 31 of them empty, and `day` over a year draws 365. The right unit depends on the window the reader picks and
 * on how the data falls, so `auto` is decided where both are known, on the client, before the read. It is not a SQL
 * bucket: the server never sees the word (`withUnit` writes the unit in), and the grammar's `DATE_UNITS` is unchanged.
 *
 * Two rules choose the unit, both pure so a table of cases can hold them:
 *  1. The span picks a base unit: up to 45 days a day, up to 26 weeks a week, up to 36 months a month, past that a
 *     quarter.
 *  2. Where the measure can be added up again (count, sum, min, max, avg as sum over count, and arithmetic of those),
 *     the base answer is coarsened locally while fewer than a third of its buckets hold data, as long as at least four
 *     buckets would remain. No second read. A median cannot be added up from its parts, so it follows the span only.
 */
import { dateWindow } from './queryDates.js';

export type AutoUnit = 'day' | 'week' | 'month' | 'quarter';

/** Finest to coarsest: the order a sparse chart steps up through. */
const AUTO_UNITS: readonly AutoUnit[] = ['day', 'week', 'month', 'quarter'];

/** A bucket needs a third of its periods to hold data before the chart is left at the unit the span chose. */
const DENSE = 1 / 3;
/** Stepping up stops before the chart is left with fewer buckets than this. */
const FEWEST_BUCKETS = 4;

/* ---------- the word in a `by` ---------- */

const AUTO_KEY = /^auto\s+([\w.$+]+)(\s+as\s+[\w$]+)?$/i;

/** The key of a `by` written `auto <column>`, wherever it stands in the list: its place and its column. */
export function autoKeyOf(by: string | undefined): { index: number; column: string } | null {
  const keys = (by ?? '').split(',');
  for (const [index, key] of keys.entries()) {
    const m = AUTO_KEY.exec(key.trim());
    if (m) return { index, column: m[1] };
  }
  return null;
}

/** The `by` with its `auto` key written as the unit the chart chose, which is the word the grammar reads. */
export function withUnit(by: string, unit: AutoUnit): string {
  const at = autoKeyOf(by);
  if (!at) return by;
  return by
    .split(',')
    .map((key, index) => (index === at.index ? key.trim().replace(/^auto/i, unit) : key.trim()))
    .join(', ');
}

/* ---------- the span ---------- */

const DAY = 86_400_000;

/**
 * The days a section's query asks about on its `over` column — `created_at = last 90 days`, `this month` — or null
 * where it sets no window the date grammar can bound (the data's own extent is then the span).
 */
export function spanDaysOf(query: string | undefined, over: string | undefined, now: Date): number | null {
  const phrase = windowPhraseOf(query, over);
  const window = phrase ? dateWindow(phrase, now) : undefined;
  return window ? Math.max(1, Math.round((window.end.getTime() - window.start.getTime()) / DAY)) : null;
}

/** The phrase a query windows its `over` column by — `last 90 days` in `due_on = last 90 days` — or null. */
export function windowPhraseOf(query: string | undefined, over: string | undefined): string | null {
  if (!query || !over) return null;
  const escaped = over.replace(/[.$+]/g, '\\$&');
  const found = new RegExp(`(?:^|[\\s(])${escaped}\\s*=\\s*(.+?)(?=\\s+(?:and|or)\\b|\\)|$)`, 'i').exec(query);
  return found ? found[1].trim() : null;
}

/** The days between two dates the data holds, both ends counted. Null where either is not a date. */
export function spanDaysBetween(min: unknown, max: unknown): number | null {
  const from = dayNumber(String(min ?? '').slice(0, 10));
  const to = dayNumber(String(max ?? '').slice(0, 10));
  return from === null || to === null || to < from ? null : to - from + 1;
}

/** The unit a span of this many days is drawn in, before the data is looked at. */
export function unitForSpan(days: number): AutoUnit {
  if (days <= 45) return 'day';
  if (days <= 26 * 7) return 'week';
  if (days <= 36 * 30.4375) return 'month';
  return 'quarter';
}

/**
 * The unit the read asks the server for. Where the measure adds up again, a day or a week is read as days and
 * bucketed here: a week crosses a month's edge, so weeks read from the server could not be coarsened into months
 * without handing a whole week to one of them. Months and quarters nest, so those are read as they are drawn.
 */
export function readUnit(base: AutoUnit, addsUp: boolean): AutoUnit {
  return addsUp && (base === 'day' || base === 'week') ? 'day' : base;
}

/* ---------- periods, by their labels ---------- */

const pad = (n: number) => String(n).padStart(2, '0');

function dayNumber(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY : null;
}

const dayKey = (n: number): string => {
  const d = new Date(n * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The label of the period a day, month or quarter label falls in, spelled as the server spells it. */
export function bucketKey(key: string, unit: AutoUnit, weekStart = 1): string {
  if (unit === 'day') return key;
  if (unit === 'week') {
    const n = dayNumber(key);
    if (n === null) return key;
    /* ISO weekday 1..7; a day is that many days past its week's first. */
    const weekday = ((new Date(n * DAY).getUTCDay() + 6) % 7) + 1;
    return dayKey(n - ((weekday - weekStart + 7) % 7));
  }
  const month = Number(key.slice(5, 7));
  if (unit === 'month') return key.slice(0, 7);
  return /Q[1-4]$/.test(key) ? key : `${key.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}

function nextKey(key: string, unit: AutoUnit): string {
  if (unit === 'day' || unit === 'week') return dayKey((dayNumber(key) ?? 0) + (unit === 'week' ? 7 : 1));
  if (unit === 'month') {
    const [y, m] = [Number(key.slice(0, 4)), Number(key.slice(5, 7))];
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  const [y, q] = [Number(key.slice(0, 4)), Number(key.slice(6))];
  return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
}

const SPELLED: Record<AutoUnit, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  week: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  quarter: /^\d{4}-Q[1-4]$/,
};

/** The local calendar day of a date, as the server spells a day. */
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A trend's points over its window: the periods that held no rows put back as zero, from the window's first period
 * to today's, and the read periods added up into the unit the span is drawn in. A count of nothing is 0, and a line
 * drawn through only the days that had rows said a quiet week was a steady one; three busy days of a week drew no
 * line at all. Only a count or a sum adds up so: any other measure's points are drawn as read, and labels the read
 * unit does not spell are left as they came.
 */
export function trendPoints<R extends { key: unknown; value: unknown }>(
  rows: readonly R[],
  read: AutoUnit,
  unit: AutoUnit,
  measure: string | undefined,
  window: { start: Date; end: Date } | undefined,
  now: Date,
): Array<{ key: unknown; value: unknown }> {
  if (!/^(count|sum\s+[\w.$+]+)(\s+as\s+[\w$]+)?$/i.test((measure ?? 'count').trim())) return [...rows];
  const keys = rows.map((row) => String(row.key ?? ''));
  if (keys.some((key) => !SPELLED[read].test(key))) return [...rows];
  const ends = window ? [window.start, new Date(Math.min(window.end.getTime() - 1, now.getTime()))] : [];
  const sorted = [...keys, ...ends.map((d) => bucketKey(localDay(d), read))].sort();
  if (!sorted.length) return [...rows];
  const held = new Map(rows.map((row) => [String(row.key), Number(row.value) || 0]));
  const into = new Map<string, number>();
  for (let key = sorted[0], n = 0; key <= sorted[sorted.length - 1] && n < 5000; key = nextKey(key, read), n++) {
    const label = bucketKey(key, unit);
    into.set(label, (into.get(label) ?? 0) + (held.get(key) ?? 0));
  }
  return [...into].map(([key, value]) => ({ key, value }));
}

/** How many periods of the unit run from the first label to the last, both ends counted. */
function periodsBetween(first: string, last: string, unit: AutoUnit): number {
  let count = 1;
  for (let key = first; key < last && count < 5000; key = nextKey(key, unit)) count++;
  return count;
}

/**
 * The unit a chart is drawn in: the span's, stepped up while the data is sparse in it.
 *
 * `keys` are the labels of the buckets that hold data, as read (days, or months or quarters, per `readUnit`).
 * `addsUp` is whether the measure can be re-aggregated; without it the span alone decides.
 */
export function chooseUnit({
  spanDays,
  base: given,
  keys,
  addsUp,
  weekStart = 1,
}: {
  /** The span in days; or the `base` already chosen for it, where the caller has kept one. */
  spanDays?: number;
  base?: AutoUnit;
  keys: readonly string[];
  addsUp: boolean;
  weekStart?: number;
}): { base: AutoUnit; unit: AutoUnit } {
  const base = given ?? unitForSpan(spanDays ?? 0);
  if (!addsUp || !keys.length || base === 'quarter') return { base, unit: base };
  const at = (unit: AutoUnit) => {
    const labels = [...new Set(keys.map((k) => bucketKey(k, unit, weekStart)))].sort();
    return { filled: labels.length, total: periodsBetween(labels[0], labels[labels.length - 1], unit) };
  };
  let unit: AutoUnit = base;
  for (;;) {
    const here = at(unit);
    if (here.filled / here.total >= DENSE) break;
    const next: AutoUnit | undefined = AUTO_UNITS[AUTO_UNITS.indexOf(unit) + 1];
    if (!next || at(next).total < FEWEST_BUCKETS) break;
    unit = next;
  }
  return { base, unit };
}

/* ---------- the measure, taken apart so it can be added up again ---------- */

type Combine = 'add' | 'min' | 'max';

export interface MeasurePlan {
  /** What to read per bucket, in the grammar's words: each aggregate the measure is made of, once. */
  reads: string[];
  /** How the same aggregate of two buckets becomes one of their union. */
  combine: Combine[];
  /** The measure's value from its aggregates, null where it has none (a ratio over nothing). */
  value(terms: readonly (number | null)[]): number | null;
}

const TERM = /^(count|sum|avg|min|max)\s*([\w.$+]+)?$/i;

/**
 * A measure as the aggregates it is made of, or null where it cannot be added up again: a median, a distinct
 * count, a `when` count, or words this does not read. `avg x` is `sum x` over `count x`, which can.
 */
export function planMeasure(measure: string | undefined): MeasurePlan | null {
  const text = (measure ?? 'count').replace(/\s+as\s+[\w$]+\s*$/i, '').trim();
  if (/\b(distinct|when|median)\b|[,[\]()]/i.test(text)) return null;
  const parts = text.split(/\s+([+\-*/])\s+/);
  const reads: string[] = [];
  const combine: Combine[] = [];
  const read = (aggregate: string, how: Combine): number => {
    const at = reads.indexOf(aggregate);
    if (at >= 0) return at;
    reads.push(aggregate);
    combine.push(how);
    return reads.length - 1;
  };
  type Operand = { number: number } | { term: number } | { ratio: [number, number] };
  const operands: Operand[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i].trim();
    if (/^\d+(?:\.\d+)?$/.test(part)) {
      operands.push({ number: Number(part) });
      continue;
    }
    const m = TERM.exec(part);
    if (!m) return null;
    const fn = m[1].toLowerCase();
    const column = m[2];
    if (fn !== 'count' && !column) return null;
    if (fn === 'avg') operands.push({ ratio: [read(`sum ${column}`, 'add'), read(`count ${column}`, 'add')] });
    else operands.push({ term: read(column ? `${fn} ${column}` : fn, fn === 'min' ? 'min' : fn === 'max' ? 'max' : 'add') });
  }
  const ops = parts.filter((_, i) => i % 2 === 1);
  const value = (terms: readonly (number | null)[]): number | null => {
    const values = operands.map((o): number | null => {
      if ('number' in o) return o.number;
      if ('term' in o) return terms[o.term];
      const [sum, count] = [terms[o.ratio[0]], terms[o.ratio[1]]];
      return sum === null || !count ? null : sum / count;
    });
    /* SQL's precedence: `*` and `/` bind first; a division by zero is null, as the server's is. */
    const sums: Array<number | null> = [values[0]];
    const signs: string[] = [];
    for (const [i, op] of ops.entries()) {
      const right = values[i + 1];
      const left = sums[sums.length - 1];
      if (op === '*' || op === '/') {
        sums[sums.length - 1] =
          left === null || right === null || (op === '/' && right === 0) ? null : op === '*' ? left * right : left / right;
      } else {
        sums.push(right);
        signs.push(op);
      }
    }
    return sums.reduce<number | null>(
      (acc, v, i) => {
        if (i === 0) return v;
        return acc === null || v === null ? null : signs[i - 1] === '+' ? acc + v : acc - v;
      },
      sums[0] === undefined ? null : sums[0],
    );
  };
  return { reads, combine, value };
}

/** One bucket as read: its label, the second key's value where the chart has one, and one number per aggregate the plan reads. */
interface ReadBucket {
  key: string;
  series?: string;
  terms: readonly (number | null)[];
}

/** The read buckets cut into the chosen unit, each aggregate added up (or min'd, or max'd) across the ones it takes in. */
export function coarsen(
  buckets: readonly ReadBucket[],
  plan: MeasurePlan,
  unit: AutoUnit,
  weekStart = 1,
): Array<{ key: string; series?: string; value: number }> {
  /* A chart over a second key (a line or a stack per value) is coarsened per value: a cross is the period and the series. */
  const into = new Map<string, Array<number | null>>();
  const SPLIT = '\u0000';
  for (const bucket of buckets) {
    const key = `${bucketKey(bucket.key, unit, weekStart)}${bucket.series === undefined ? '' : SPLIT + bucket.series}`;
    const held = into.get(key);
    if (!held) {
      into.set(key, [...bucket.terms]);
      continue;
    }
    plan.combine.forEach((how, i) => {
      const [a, b] = [held[i], bucket.terms[i]];
      held[i] = a === null ? b : b === null ? a : how === 'add' ? a + b : how === 'min' ? Math.min(a, b) : Math.max(a, b);
    });
  }
  return [...into.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([joined, terms]) => {
      const value = plan.value(terms);
      const [key, series] = joined.split(SPLIT);
      return value === null || !Number.isFinite(value) ? [] : [{ key, ...(series === undefined ? {} : { series }), value }];
    });
}

/* ---------- what a section asks, for the check ---------- */

/** The most days a window may span before a fixed `day` chart over it is worth a word. */
export const DAY_BARS_ADVISED = 90;

/**
 * The days a dashboard window phrase covers, as it would be said ("last 12 months" is 365): the nominal length of a
 * `last N unit`, else the dates the phrase resolves to, or null where it is not one the date grammar bounds. (A
 * resolved `last N` runs to tomorrow, a day more than it is called, which a count of bars should not repeat.)
 */
export function windowDays(phrase: string, now: Date): number | null {
  const last = /^last\s+(\d+)\s+(day|week|month|year)s?$/i.exec(phrase.trim());
  if (last) return Math.round(Number(last[1]) * { day: 1, week: 7, month: 365 / 12, year: 365 }[last[2].toLowerCase() as 'day']);
  const window = dateWindow(phrase, now);
  return window ? Math.round((window.end.getTime() - window.start.getTime()) / DAY) : null;
}

/** Whether a chart's `by` cuts days: `day created_at`, in any position. */
export const cutsDays = (by: string | undefined): boolean => (by ?? '').split(',').some((key) => /^day\s+[\w.$+]+/i.test(key.trim()));
