/**
 * Simple conditions, read and written through the real clause machinery.
 *
 * The filter boxes speak in single conditions — `status = open`,
 * `shipped_on is empty` — and this is the one place that reads them out of
 * a query and writes them back in. It sits on clauses.js rather than on
 * regexes of its own, because a second lexer for the language is a mirror
 * that drifts: the first cut of this file missed `last month`, split
 * quoted values on their own words, and orphaned half of an or-group. The
 * clause splitter is quote-aware, paren-aware and between-aware already;
 * everything here is set arithmetic on what it returns.
 *
 * Pure on purpose — imports clauses.js and nothing else — so the grammar
 * these boxes assume is pinned by tests that run in node.
 */
import { joinQuery, maskQuoted, splitConditions, splitQuery } from './clauses.js';

export const squeeze = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/* The texts these helpers take have no leading table name — the list's
   heading already says it — but splitQuery expects one. A throwaway token
   stands in and never comes back out (joinQuery drops the empty table). */
const parse = (text) => {
  const parts = splitQuery(`q ${squeeze(text)}`);
  return { parts, conditions: splitConditions(parts.filter) };
};

const rebuild = (parts, conditions) => squeeze(joinQuery({ ...parts, table: '', filter: conditions.join(' and ') }));

/** A single outer paren pair says grouping, not meaning; peel it. */
const ungroup = (condition) => {
  const text = squeeze(condition);
  if (!text.startsWith('(') || !text.endsWith(')')) return text;
  // Only when the parens are one pair around the whole thing.
  const inner = text.slice(1, -1);
  let depth = 0;
  for (const ch of maskQuoted(inner)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return text;
  }
  return squeeze(inner);
};

/**
 * Does this top-level condition belong to `col`, simply? An or-group is one
 * thing you either want or do not — no box owns half of it, so a column
 * that only appears inside one reads as unset and stays untouched.
 */
const owns = (condition, col) => {
  const text = squeeze(condition);
  const lower = text.toLowerCase();
  const name = col.toLowerCase();
  /* A filter that is a whole condition — the rows that point at the record, asked by one of their segments
     (`any opportunity where open`, shared/listFilters.ts) — owns itself, with no tail. */
  if (!(lower === name || lower.startsWith(`${name} `) || lower.startsWith(`${name}=`))) return false;
  if (/\bor\b/i.test(maskQuoted(text))) return false;
  return true;
};

/** The condition tail this text holds for a column — `= open`,
    `= last 30 days`, `contains "no show"`, `is empty` — or ''. */
export function conditionTail(text, col) {
  const mine = parse(text).conditions.find((condition) => owns(condition, col));
  if (!mine) return '';
  const tail = squeeze(squeeze(mine).slice(col.length));
  if (/^is\b/i.test(tail)) return tail.toLowerCase();
  if (/^contains\b/i.test(tail)) return `contains ${squeeze(tail.replace(/^contains/i, ''))}`;
  return tail.replace(/^=\s*/, '= ');
}

/**
 * Every owned tail for the column, in order — a two-condition column
 * (`stage != a and stage != b`) is two tails, and a chip that showed only
 * the first was a chip lying by half.
 */
export function ownedTails(text, col) {
  return parse(text)
    .conditions.filter((condition) => owns(condition, col))
    .map((condition) => {
      const tail = squeeze(squeeze(condition).slice(col.length));
      if (/^is\b/i.test(tail)) return tail.toLowerCase();
      if (/^contains\b/i.test(tail)) return `contains ${squeeze(tail.replace(/^contains/i, ''))}`;
      return tail.replace(/^=\s*/, '= ');
    });
}

/** Whether the text holds a condition this column owns: a whole-condition filter's has no tail to read. */
export function holdsCondition(text, col) {
  return parse(text).conditions.some((condition) => owns(condition, col));
}

/** The text with any owned `col …` condition removed, seams sewn up. */
export function stripCondition(text, col) {
  const { parts, conditions } = parse(text);
  return rebuild(
    parts,
    conditions.filter((condition) => !owns(condition, col)),
  );
}

/**
 * The tail that sets a filter which is a whole condition — the rows that
 * point at the record, asked by a segment of theirs (`any opportunity where
 * open`, shared/listFilters.ts) — with nothing after it. A facet hands it to
 * the same `set` every tail goes through, so the rail, a bar's picker and a
 * sheet's draft write it as they write any other.
 */
export const WHOLE = '\u0000whole';

/**
 * The text with this column's condition set, replaced, or ('' tail)
 * removed. `and` binds tighter than `or`, so any surviving or-group is
 * parenthesised first — narrowing it must narrow the whole alternative,
 * not quietly attach to its last arm.
 */
export function withCondition(text, col, tail) {
  const said = tail === WHOLE ? col : tail ? `${col} ${tail}` : '';
  const { parts, conditions } = parse(text);
  const kept = conditions.filter((condition) => !owns(condition, col));
  if (!said) return rebuild(parts, kept);
  const wrapped = kept.map((condition) => {
    const bare = squeeze(condition);
    return /\bor\b/i.test(maskQuoted(bare)) && ungroup(bare) === bare ? `(${bare})` : bare;
  });
  return rebuild(parts, [...wrapped, said]);
}

/**
 * One spelling for one question, so two texts that ask the same thing
 * compare equal: whitespace squeezed and redundant outer parens peeled —
 * `(a or b)` and `a or b` are the same alternative.
 */
export function canonicalize(text) {
  const { parts, conditions } = parse(text);
  return rebuild(parts, conditions.map(ungroup));
}

/** Whether the text carries a show clause of its own. Quote-aware: a value
    that merely contains the word does not count. */
export const hasShowClause = (text) => Boolean(splitQuery(`q ${squeeze(text)}`).show);

/**
 * Does any condition in the text involve this column — including inside an
 * or-group that no box owns? The guard for "this tab speaks for that
 * column", where conditionTail's simple-conditions-only answer was too
 * narrow: a stale box tail folded into an or-group tab ANDed the old tab's
 * state into the new one and showed zero rows.
 */
export function mentionsColumn(text, col) {
  const safe = String(col).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.])${safe}\\s*(=|!=|>|<|contains\\b|has\\b|is\\b|between\\b)`, 'i').test(maskQuoted(squeeze(text)));
}
