/**
 * How a dashboard says a group's key: the column's display rule and vocabulary, and a weekday or hour bucket as the
 * reader's day and hour. Its own module so the breakdown, the chart and the matrix say a key one way.
 */
import { columnDisplay, findTable } from '@mistriwork/kit/client/core.js';
import { groupLabel, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { formatLocale } from '@mistriwork/kit/client/locale.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say as sayCopy } from '../copy/dashboards/components/dashboardSay.js';

/** A group's key as its reader says it: the column's display rule, and in an
    App the column's vocabulary as words (valueModel.ts, groupLabel). */
export function sayGroup(table: string | undefined, column: string | undefined) {
  /* A weekday bucket answers 1 (Monday) to 7, an hour bucket 00 to 23: said as the reader's day and hour. */
  const bucket = /^(weekday|hour)\s/i.exec(column ?? '')?.[1]?.toLowerCase();
  if (bucket) return (key: unknown) => sayBucket(bucket, key);
  const rule = columnDisplay(table ?? '', column ?? '') as DisplayRule | null;
  const allowed = (findTable(table ?? '') as TableMeta | undefined)?.columns.find((c) => c.name === column)?.allowed;
  return (key: unknown) => groupLabel(rule, key, allowed);
}

/** A weekday or hour bucket's key in the reader's words: 2024-01-01 was a Monday. */
function sayBucket(bucket: string, key: unknown): string {
  const n = Number(key);
  if (key == null || key === '' || !Number.isInteger(n)) return String(key ?? '—');
  const at = bucket === 'weekday' ? new Date(Date.UTC(2024, 0, n)) : new Date(Date.UTC(2024, 0, 1, n));
  const options: Intl.DateTimeFormatOptions =
    bucket === 'weekday' ? { weekday: 'short', timeZone: 'UTC' } : { hour: 'numeric', timeZone: 'UTC' };
  return at.toLocaleString(formatLocale(), options);
}

/** A change's news, as a class: ' good' or ' bad' where the metric says which way is better, else nothing. */
export function changeTone(diff: number, better: 'up' | 'down' | undefined): '' | ' good' | ' bad' {
  if (!better || diff === 0 || !Number.isFinite(diff)) return '';
  return diff > 0 === (better === 'up') ? ' good' : ' bad';
}

/** What a compare window is, as a card says it beside its change: "vs prior 90 days". */
export function comparedWith(compare: string | undefined, level = false): string | undefined {
  const period = /\bprevious\s+(\d+)\s+(minute|hour|day|week|month|year)s?\b/i.exec(compare ?? '');
  if (!period) return compare ? sayCopy(level ? 'sameAsTheCompareWindow' : 'vsTheCompareWindow') : undefined;
  const n = Number(period[1]);
  return sayCopy(level ? 'sameAsPrior' : 'vsPrior', { period: n === 1 ? period[2].toLowerCase() : `${n} ${period[2].toLowerCase()}s` });
}
