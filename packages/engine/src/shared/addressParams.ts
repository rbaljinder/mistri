/** Data-only lexical pieces of the existing browser list address grammar.
 * These helpers do not authorize fields, coerce schema values or validate an
 * API request. Callers own parameter uniqueness, limits and refusal policy.
 * Numeric lexemes remain text so large integers are never rounded here. */
import { slug as slugOf } from './slug.js';

/** A tab label's existing address spelling; shared without client state. */
export function tabSlug(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A tab's word in an address: the App's own language's, whatever language its label is said in. */
export const tabKey = (tab: { label: string; slug?: string }): string => tab.slug ?? tabSlug(tab.label);

/** A record tab's word in an address: a section group's name, a related list's title. */
export function tabWord(token: string): string {
  if (token.startsWith('tab:')) return slugOf(token.slice(4), token);
  if (token.startsWith('section:')) return `section-${token.slice(8)}`;
  return slugOf(token, token);
}

/** Whether a tab token is the one an address's word names. */
export const tabMatches = (token: string, asked: string | undefined): boolean =>
  asked !== undefined && (token === asked || tabWord(token) === asked);

export function addressFilterValue(
  raw: string,
): { kind: 'values'; values: string[] } | { kind: 'range'; min?: string; max?: string } | undefined {
  if (!raw.trim()) return undefined;
  const range = /^(-?\d+(?:\.\d+)?)?\.\.(-?\d+(?:\.\d+)?)?$/.exec(raw.trim());
  if (range && (range[1] || range[2]))
    return { kind: 'range', ...(range[1] ? { min: range[1] } : {}), ...(range[2] ? { max: range[2] } : {}) };
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? { kind: 'values', values } : undefined;
}

/** Undefined means the whole sort is outside this grammar. Preserve the
 * browser's existing identifier spelling, duplicate fields and ordering;
 * an API consumer must apply its own declared-field and ambiguity checks. */
export function addressSortValue(raw: string): { field: string; descending: boolean }[] | undefined {
  if (!/^-?[A-Za-z_][\w.]*(,-?[A-Za-z_][\w.]*)*$/.test(raw)) return undefined;
  return raw.split(',').map((field) => ({ field: field.startsWith('-') ? field.slice(1) : field, descending: field.startsWith('-') }));
}

/** All time, said where a dashboard opens on a window of its own (`window: 'last 30 days'`): `?period=all-time`. */
export const ALL_TIME = 'all-time';
