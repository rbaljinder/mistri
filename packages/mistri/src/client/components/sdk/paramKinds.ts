/**
 * What a free-form page's address parameters hold, and how each is read back from the text the address carries
 * (page.tsx `useParam`, and the controls bound to a param: paramControls.tsx). Apart from both so neither imports the other.
 */

import { columnKind } from '@mistriwork/engine/shared/schema.js';

/** What a param holds (`params: { class: 'id' }`): an id, a day, a run of days, words as written, or one of a few. */
export type ParamKind = 'id' | 'text' | 'date' | 'date-range' | readonly string[];
export type ParamValue = string | number;

/** A day on the calendar, `YYYY-MM-DD`: 2026-02-30 parses, as March 2, but is not one. */
function isDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === raw;
}

/** A run of days as the address says it, `2026-11-01..2026-11-08`: either end may be left open (`..2026-11-08`), not both. */
export function splitRange(raw: string | undefined): readonly [string, string] | undefined {
  const at = raw?.indexOf('..') ?? -1;
  if (raw === undefined || at < 0) return undefined;
  const from = raw.slice(0, at);
  const to = raw.slice(at + 2);
  if ((!from && !to) || (from && !isDay(from)) || (to && !isDay(to))) return undefined;
  return [from, to];
}

export const joinRange = (from: string, to: string): string | undefined => (from || to ? `${from}..${to}` : undefined);

/* What an `'id'` param holds follows the key of the table it names (a param named for a resource the page reads): a
   tenant's tables carry opaque text ids, a count-up table integers. A param naming no table holds an integer, as it always did. */
type IdKey = 'integer' | 'text';
/* URL-safe text only, the characters an address carries unescaped (RFC 3986's unreserved): an id with a slash or a
   space in it is no id a link can hold. */
const TEXT_ID = /^[A-Za-z0-9._~-]{1,256}$/;

/** How a resource's key reads an `'id'` param: text where its only key column is text (or a uuid), an integer otherwise. */
export function idKeyOf(table: { columns: ReadonlyArray<{ type: string; primaryKey?: boolean }> } | undefined): IdKey {
  const keys = table?.columns.filter((column) => column.primaryKey) ?? [];
  return keys.length === 1 && columnKind(keys[0]!.type) === 'text' ? 'text' : 'integer';
}

/* An address is typed by hand and kept in bookmarks, so a value is checked before the page sees it: one that is not of
   its kind is no value, as a param the address lacks is. An id past 2^53 stays its digits: Number() would round it. */
export function paramValue(raw: string | undefined, kind: ParamKind, key: IdKey = 'integer'): ParamValue | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(kind)) return kind.includes(raw) ? raw : undefined;
  if (kind === 'id') {
    if (key === 'text') return TEXT_ID.test(raw) ? raw : undefined;
    if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : raw;
  }
  if (kind === 'date') return isDay(raw) ? raw : undefined;
  if (kind === 'date-range') return splitRange(raw) ? raw : undefined;
  return raw;
}

/* Each param's kind: a list of names (`params: ['list']`) is text, as it was before params had kinds. */
export function paramKinds(params: unknown): Readonly<Record<string, ParamKind>> {
  if (Array.isArray(params)) return Object.fromEntries(params.map((name: string) => [name, 'text' as const]));
  return params && typeof params === 'object' ? (params as Record<string, ParamKind>) : {};
}
