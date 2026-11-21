/**
 * A dated chart's empty periods, stood at zero (C1). A breakdown by `day(created_at)` answers only the days that have
 * rows, so a line across a quiet week skipped it and a bar chart closed the gap; the periods are filled here, on the
 * client, by the one filler the dashboard's trend uses (autoBucket.ts, fillBuckets), in the App's time zone.
 *
 * `fill`: 'window' fills the whole window the read names (`created_at = last 30 days`) up to today, 'observed' only
 * between the first and last period answered, false not at all. Absent, 'window' where the read names a window.
 */
import { dateWindow } from '@mistriwork/engine/shared/queryDates.js';
import { fillBuckets, windowPhraseOf, type AutoUnit } from '@mistriwork/engine/shared/autoBucket.js';
import { appNow, formatTimezone } from '@mistriwork/kit/client/locale.js';
import { zonedNow } from '../../shared/appZone.js';

type BucketFill = 'window' | 'observed' | false;

interface Answer {
  columns?: string[];
  rows?: Record<string, unknown>[];
}

/** What a fill needs of the read: what it groups by, what it measures, the window its query names. */
interface FillAsk {
  by?: string;
  measure?: string;
  query?: string;
  /** A chart's shape: only a line or bars run along time; a donut's slices or a heatmap's cells are not periods in a row. */
  shape?: string;
  fill?: BucketFill;
}

/* Only a sum or a count is zero where nothing happened: an average or a maximum of no rows is not 0, it is nothing. */
const ADDS = /^\s*(count|sum\s+[\w.]+)(\s+as\s+\w+)?\s*$/i;

const held = new WeakMap<object, Map<string, Answer>>();

/** A dated read's unit and column, where it groups by one period (`month opened_on`, `day(moved_at)`) and adds up. */
function datedOf(ask: FillAsk): { unit: AutoUnit; column: string } | undefined {
  if (ask.fill === false || (ask.shape && ask.shape !== 'line' && ask.shape !== 'bar')) return undefined;
  const dated = /^(day|week|month|quarter)\s*\(?\s*([\w.]+)\s*\)?$/i.exec((ask.by ?? '').trim());
  if (!dated || !ADDS.test(ask.measure ?? 'count')) return undefined;
  return { unit: dated[1].toLowerCase() as AutoUnit, column: dated[2] };
}

/** Rows keyed under `key` with their empty periods at zero in the fields `zero` names; the rows themselves where the
    read is not a dated count or sum. */
function filledRows<R extends Record<string, unknown>>(
  rows: readonly R[],
  ask: FillAsk,
  key: string,
  zero: readonly string[],
): Array<R | (Record<string, unknown> & { filled: true })> {
  const dated = datedOf(ask);
  if (!dated || !zero.length) return [...rows];
  const phrase = windowPhraseOf(ask.query, dated.column);
  const fill = ask.fill ?? (phrase ? 'window' : 'observed');
  /* The window's ends read in the App's zone: a period is the App's day, not the browser's. The window stops at today,
     so a chart of "this month" does not run out to a row of zeros not yet lived. */
  const now = zonedNow(formatTimezone(), appNow());
  const window = fill === 'window' && phrase ? dateWindow(phrase, now) : undefined;
  const to = window ? new Date(Math.min(window.end.getTime() - 1, now.getTime())) : undefined;
  return fillBuckets(rows, { unit: dated.unit, key, zero, from: window?.start, to });
}

/** The read's rows, as the hook answers them (keyed `month(opened_on)`, `sum(net)`), with their empty periods at zero. */
export function filledHookRows<R extends Record<string, unknown>>(
  rows: readonly R[],
  ask: FillAsk,
): Array<R | (Record<string, unknown> & { filled: true })> {
  const dated = datedOf(ask);
  if (!dated) return [...rows];
  const key = `${dated.unit}(${dated.column})`;
  /* The measure as the server names it, for a window with no row at all to read the field names off. */
  const written = (ask.measure ?? 'count').trim();
  const measure = /\s+as\s+(\w+)$/i.exec(written)?.[1] ?? written.replace(/^sum\s+([\w.]+)$/i, 'sum($1)');
  const zero = rows.length ? Object.keys(rows[0]).filter((field) => field !== key) : [measure];
  return filledRows(rows, ask, key, zero);
}

/** The answer with its empty periods at zero, each marked `filled: true`; the answer itself where it is not a dated
    count or sum, or `fill` is false. The same answer and ask give the same object back, so a memo below holds. */
export function filledAnswer<A extends Answer>(answer: A | undefined, ask: FillAsk): A | undefined {
  if (!answer || !datedOf(ask)) return answer;
  const [keyName, ...measured] = answer.columns ?? [];
  if (!keyName || !measured.length) return answer;
  const said = `${ask.fill ?? ''}|${ask.by}|${ask.query ?? ''}`;
  const known = held.get(answer)?.get(said);
  if (known) return known as A;
  const rows = filledRows(answer.rows ?? [], ask, keyName, measured);
  const filled = rows.length === (answer.rows ?? []).length ? answer : { ...answer, rows };
  if (!held.has(answer)) held.set(answer, new Map());
  held.get(answer)!.set(said, filled);
  return filled;
}
