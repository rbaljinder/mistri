/**
 * A list's filters across its related tables: a path up a reference
 * (`'account_id.industry_id'`) and the rows that point at the record
 * (`{ has: 'opportunity', filter: 'stage' }`).
 *
 * A filter is held as the words its condition starts with, as every filter
 * always was — a column's name, a path, or `any opportunity where stage` — so
 * the rail and the bar fold a tail onto it (`in (won, lost)`) by the rule
 * they fold one onto a column (conditions.js), the question is a chip, a URL
 * and a tab refinement like any other, and the language (`any …`, view.ts)
 * is what reads it. The address names it by a word of its own.
 */
import { ANY_CONDITION } from './query.js';

const WORD = /^[A-Za-z_][\w$]*$/;
const KEY_WORD = /^[A-Za-z_][\w$]*(?:\+[A-Za-z_][\w$]*)*$/;
const PATH = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/;
const HAS_KEYS = new Set(['has', 'filter', 'segment', 'whose']);

/**
 * A list's filter as authored, as the key it is held under: a column or a
 * path as written, a `has` filter as the words of its condition. Throws with
 * the fix for a shape no list reads.
 */
export function listFilterKey(raw: unknown, at: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} has "filters" that are not a list of column names, paths, or { has } filters.`);
  }
  const o = raw as Record<string, unknown>;
  /* The reference is `whose`, as a rollup's and a related list's is; `via` stays the query language's own word (renamed before 1.0). */
  if (o.via !== undefined)
    throw new Error(`${at} has a filter with "via", which is now "whose": the column of ${String(o.has)} that points at this record.`);
  const stray = Object.keys(o).find((key) => !HAS_KEYS.has(key));
  if (stray !== undefined) throw new Error(`${at} has a filter with "${stray}": a { has } filter takes has, filter or segment, and whose.`);
  const word = (key: string, shape: RegExp) =>
    typeof o[key] === 'string' && shape.test((o[key] as string).trim()) ? (o[key] as string).trim() : undefined;
  const has = word('has', /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/);
  if (!has) throw new Error(`${at} has a filter without the table it asks about: { has: 'opportunity', filter: 'stage' }.`);
  if ((o.filter === undefined) === (o.segment === undefined)) {
    throw new Error(
      `${at}: the filter { has: '${has}' } names a "filter" (a column of ${has}, or a path up from it) or a "segment" of ${has} — one of them.`,
    );
  }
  const asks = o.filter === undefined ? word('segment', WORD) : word('filter', PATH);
  if (!asks) {
    throw new Error(
      `${at}: the filter { has: '${has}' } has a "${o.filter === undefined ? 'segment' : 'filter'}" that is not ${o.filter === undefined ? "a segment's name" : 'a column or a path'}.`,
    );
  }
  if (o.whose !== undefined && !word('whose', KEY_WORD)) {
    throw new Error(`${at}: the filter { has: '${has}' } has a "whose" that is not a column of ${has}.`);
  }
  const whose = word('whose', KEY_WORD);
  return `any ${has}${whose ? ` via ${whose}` : ''} where ${asks}`;
}

/** A `has` filter's key read back: the child table as written, the reference where it names one, and what it asks. */
export interface HasFilterKey {
  child: string;
  via?: string;
  asks: string;
}

/** The `has` filter a key is, or undefined for a column or a path. */
export function hasFilterOf(key: string): HasFilterKey | undefined {
  const m = ANY_CONDITION.exec(key.trim());
  if (!m || m[1].toLowerCase() !== 'any' || m[4] === undefined || !PATH.test(m[4].trim())) return undefined;
  return { child: m[2], ...(m[3] ? { via: m[3] } : {}), asks: m[4].trim() };
}

/**
 * The word an address names a filter by: a column or a path as it is
 * (`?account_id.industry_id=3`), the rows that point at the record as
 * `has.` their table, the reference where the filter names one, and what
 * it asks (`?has.opportunity.stage=won`). No column is called `has.…`.
 */
export function filterAddressWord(key: string): string {
  const has = hasFilterOf(key);
  return has ? ['has', has.child, ...(has.via ? [has.via] : []), has.asks].join('.') : key;
}

/**
 * What a filter across a reference is called on its list: the record it
 * reaches says it ("Industry"), unless another of the list's filters or
 * columns is called that too, when the reference it crosses says whose it is
 * ("Account industry"). Any other filter is called by its caption.
 */
export function filterLabel(name: string, caption: (path: string) => string, near: readonly string[]): string {
  const said = caption(name);
  if (!name.includes('.') || hasFilterOf(name)) return said;
  if (!near.some((other) => other !== name && caption(other) === said)) return said;
  const whose = caption(name.split('.')[0]);
  return `${whose} ${/^[A-Z][a-z]/.test(said) ? said.charAt(0).toLowerCase() + said.slice(1) : said}`;
}
