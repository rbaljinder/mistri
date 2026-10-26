/**
 * What a search box suggests as the reader types: the distinct values of a
 * few of the list's own columns that contain what was typed, under the
 * list's standing query, counted by the server through the reader's grants
 * as a facet's values are. Kept apart from SuggestBox so the rules are
 * tested without a browser.
 */
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';

/** About a screenful: a suggestion list is a nudge, not a second list. */
export const SUGGEST_MOST = 8;
/** Long enough that a word typed at speed is one question, short enough to feel like an answer. */
export const SUGGEST_WAIT_MS = 200;

export interface Suggestion {
  value: string;
  count: number;
}

/** The breakdown one column's suggestions are read by. */
export function suggestText(table: string, column: string, typed: string, standing = ''): string {
  const condition = `${column} contains ${quoteValue(typed)}`;
  return `${table} ${andQuery(standing, condition)} count by ${column} sort count desc`.replace(/\s+/g, ' ').trim();
}

/**
 * The columns' answers as one list: each value once, whatever its case or
 * column; a value that starts with what was typed before one that merely
 * contains it, then the commoner first, then by name; at most SUGGEST_MOST.
 */
export function rankSuggestions(answers: ReadonlyArray<ReadonlyArray<Suggestion>>, typed: string, most = SUGGEST_MOST): Suggestion[] {
  const needle = typed.trim().toLowerCase();
  const byValue = new Map<string, Suggestion>();
  for (const answer of answers)
    for (const suggestion of answer) {
      const value = suggestion.value.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      const known = byValue.get(key);
      if (!known || suggestion.count > known.count) byValue.set(key, { value, count: suggestion.count });
    }
  const leads = (s: Suggestion) => (s.value.toLowerCase().startsWith(needle) ? 0 : 1);
  return [...byValue.values()].sort((a, b) => leads(a) - leads(b) || b.count - a.count || a.value.localeCompare(b.value)).slice(0, most);
}

/** One breakdown reply's rows as suggestions: the key first, the count last. */
export function suggestionsOf(reply: { columns?: string[]; rows?: Array<Record<string, unknown>>; errors?: unknown[] }): Suggestion[] {
  const keys = reply.columns ?? [];
  if (reply.errors?.length || keys.length < 2) return [];
  return (reply.rows ?? []).flatMap((row) => {
    const value = row[keys[0]];
    const count = Number(row[keys[keys.length - 1]]);
    return value == null || value === '' || !Number.isFinite(count) ? [] : [{ value: String(value), count }];
  });
}
