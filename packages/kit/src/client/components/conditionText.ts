/**
 * A condition as written, and the catalog's connectives: the part of
 * conditionWords.ts a list says before its words have loaded.
 *
 * The words (conditionWords.ts) are most of a filter's weight and are
 * needed only once an App's list is narrowed, so they arrive on demand
 * (useConditionWords.ts); until they have, and always in the Workbench, a
 * condition is said as written. Both halves say "as written" here, so the
 * moment before the words arrive reads exactly as the Workbench always has.
 */
import { maskQuoted, splitConditions } from '../clauses.js';
import { message } from '../messages.js';

export const squeeze = (text: string) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** "A", "A or B", "A, B or C" — the last pair by the catalog's connective, the rest by its comma. */
export function joined(words: string[], connective: 'filter.and' | 'filter.or'): string {
  if (words.length <= 1) return words[0] ?? '';
  const head = words.slice(0, -1).reduce((first, next) => message('filter.comma', { first, next }));
  return message(connective, { first: head, last: words[words.length - 1] });
}

/** Several conditions as one sentence: "Status is Open and Owner is me". */
export const andWords = (words: string[]): string => joined(words, 'filter.and');

/** A single outer pair of parentheses says grouping, not meaning. */
export function ungroup(text: string): string {
  const t = squeeze(text);
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  const masked = maskQuoted(t.slice(1, -1)) as string;
  let depth = 0;
  for (const ch of masked) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) return t;
  }
  return squeeze(t.slice(1, -1));
}

/** The language as written, where there is no App to lend its words. */
export const written = {
  tails: (column: string, tails: readonly string[]): string => tails.map((tail) => `${column} ${squeeze(tail)}`).join(' and '),
  condition: (condition: string): string => ungroup(condition),
  filter: (filter: string): string[] => (splitConditions(squeeze(filter)) as string[]).map(ungroup),
  question: (text: string): string[] => (squeeze(text) ? [squeeze(text)] : []),
};
