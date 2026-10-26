/**
 * The parts of a query, as things you can take off.
 *
 * The query bar is the source of truth, which is a good design and leaves one
 * gap: undoing part of what you built means editing the text by hand. Having
 * clicked a column header to sort and a filter menu to narrow, going back to
 * "the same thing but unsorted" meant finding `sort contract_id` in a line of
 * text and deleting exactly it — the interface could write the language but
 * not un-write it.
 *
 * So the clauses are shown as chips and removing one rewrites the text. The
 * text stays authoritative; this is a second way to edit it, not a second
 * place to keep it.
 *
 * The split is by keyword, which the grammar makes safe: a query is a table,
 * then conditions, then any of `show`, `sort`/`order by` and `limit` in that
 * order. Only the trailing keywords are looked for, so a *value* containing
 * the word "limit" cannot be mistaken for the clause — the boundary is found
 * from the right, and only outside quotes.
 */

import { say } from './copy/workbench/clauses.js';
/* The split itself is shared (shared/clauses.ts): the server reads a first
   page's list question by the same rule (server/http/firstPaintRooms.ts). */
import { maskQuoted, splitQuery } from '@mistriwork/engine/shared/clauses.js';

export { maskQuoted, splitQuery };

/**
 * The row count the query itself asks for, if any. A number, or null.
 *
 * Read rather than parsed properly, because the client has no parser — the
 * language lives on the server. Reading it *here*, off the same split as the
 * chips, is what makes it right for a limit that is not the last thing typed:
 * the table view matched `limit N` anchored at the end of the string, which
 * found nothing at all in `customer limit 40000 sort name`, so the page size
 * went out instead and forty thousand rows came back as twenty — the same lie
 * that anchoring was supposed to have fixed, in the clause order nobody tried.
 * It lived beside its caller in the browser, where nothing could test it.
 *
 * The split also settles what a *value* containing the word means, which no
 * regex here could: `name = "limit 5"` is a name.
 *
 * `limit = 5`, on a table with a column called `limit`, is a filter — no
 * number follows the keyword, so this hands back nothing and the caller falls
 * back to the page size, which is what being wrong has always cost.
 */
export function explicitLimit(query) {
  const match = splitQuery(query).limit?.match(/^limit\s+(\d+)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Rebuild a query from its parts, dropping the empty ones. */
export function joinQuery(parts) {
  return [parts.table, parts.filter, parts.show, parts.sort, parts.limit]
    .filter((p) => p && String(p).trim())
    .join(' ')
    .trim();
}

/**
 * The query with one clause removed.
 *
 * @param {string} text
 * @param {'filter'|'show'|'sort'|'limit'} clause
 */
export function withoutClause(text, clause) {
  const parts = splitQuery(text);
  delete parts[clause];
  if (clause === 'filter') parts.filter = '';
  return joinQuery(parts);
}

/** Clauses present in a query, as {key, label, text} — for rendering chips. */
export function activeClauses(text) {
  const parts = splitQuery(text);
  const out = [];
  /* One chip per condition rather than one for the whole filter. A query built
     from three narrowings should be undoable one narrowing at a time — the
     interface wrote them separately, so it should be able to take them off
     separately. */
  splitConditions(parts.filter).forEach((condition, i) => {
    out.push({ key: 'filter', index: i, label: i === 0 ? 'where' : 'and', text: condition });
  });
  if (parts.show) out.push({ key: 'show', label: 'showing', text: parts.show.replace(/^show\s+/i, '') });
  if (parts.sort) out.push({ key: 'sort', label: say('sorted'), text: parts.sort.replace(/^(?:sort|order\s+by)\s+/i, '') });
  if (parts.limit) out.push({ key: 'limit', label: 'limit', text: parts.limit.replace(/^limit\s+/i, '') });
  return out;
}

/**
 * Split a filter into the conditions joined by top-level `and`.
 *
 * Top-level is the important word. `active = true and (priority = 1 or
 * priority = 2)` is two conditions, not three: the bracketed group is one
 * thing you either want or do not, and splitting inside it would produce
 * chips that cannot be removed independently without changing what the query
 * means. Depth and quoting are both tracked, so `name = "a and b"` is one
 * condition whose value happens to contain the word.
 *
 * `or` is never split on. A filter that is `a or b` comes back as a single
 * condition, which is right — removing half of an `or` is not a smaller
 * filter, it is a different one.
 */
export function splitConditions(filter) {
  const text = String(filter ?? '').trim();
  if (!text) return [];

  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  /* Set when a `between` is open and its `and` has not been seen yet.

     `between 2026-08-17 and 2026-08-27` contains an `and` that joins a range
     rather than two conditions. Without this the filter bar drew it as two
     chips — `WHERE hired_on between 2026-08-17` and `AND 2026-08-27` — and
     dismissing either produced `hired_on between 2026-08-17`, which is not a
     condition and came back as an error. One range, cut in half by the thing
     that was only supposed to be listing it.

     `splitTopLevel` in shared/query.ts has tracked this since `between`
     shipped. This copy did not, which is the whole hazard of a mirror: each
     side looks right on its own. */
  let pendingBetween = false;

  const wordAt = (word, i) => new RegExp(`^${word}\\b`, 'i').test(text.slice(i)) && (i === 0 || /[\s)]/.test(text[i - 1]));

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(') {
      depth += 1;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    if ((c === 'b' || c === 'B') && wordAt('between', i)) {
      pendingBetween = true;
      continue;
    }

    // A word boundary on both sides, so a column called `and_then` survives.
    if ((c === 'a' || c === 'A') && wordAt('and', i)) {
      // The first top-level `and` after a `between` belongs to it.
      if (pendingBetween) {
        pendingBetween = false;
        i += 2;
        continue;
      }
      parts.push(text.slice(start, i).trim());
      i += 3;
      start = i;
    }
  }
  parts.push(text.slice(start).trim());

  /* A split that yields one piece is not a split.
     
     `last_name contains and` — where the value *is* the keyword — splits at
     that `and` into `last_name contains` and nothing. Dropping the empty half
     and keeping the first left a chip with its value chopped off, which is a
     misdescription of the filter and a dismiss button wired to the wrong
     text.

     `splitTopLevel` in shared/query.ts survives this by accident of shape: it
     drops empty parts, finds fewer than two left, and falls through to
     treating the whole term as one condition — which is why the server reads
     `LIKE '%and%'` where the browser read a truncated condition. Same rule
     here, deliberately: if the keyword did not actually stand between two
     conditions, it belonged to the one. */
  const kept = parts.filter(Boolean);
  if (kept.length > 1) return kept;
  return text ? [text] : [];
}

/** The query with one condition of its filter removed, by index. */
export function withoutCondition(text, index) {
  const parts = splitQuery(text);
  const conditions = splitConditions(parts.filter);
  conditions.splice(index, 1);
  parts.filter = conditions.join(' and ');
  return joinQuery(parts);
}

/**
 * The sort clause's fields, split on commas, keyword already removed.
 *
 * `sort a, b desc` is two fields, not one field called "a, b desc". Splitting
 * here rather than at each caller is what keeps the multi-field case from
 * being everyone's separate problem.
 */
export function sortFields(query) {
  const body = splitQuery(query)
    .sort?.replace(/^(?:sort|order\s+by)\s+/i, '')
    .trim();
  if (!body) return [];
  return body.split(',').map((part) => {
    const [column, ...rest] = part.trim().split(/\s+/);
    return { column, direction: /^desc$/i.test(rest[0] ?? '') ? 'desc' : 'asc' };
  });
}

/**
 * Which way a query sorts by a column, or null if it does not.
 *
 * Answered by splitting rather than by matching, because the caller's column
 * name goes into the comparison and a reference hop contains characters a
 * regex reads as instructions: `invoice_id+line_no.sku` interpolated into a
 * pattern means "one or more `d`, then any character" — a question about a
 * different column entirely.
 */
export function sortDirection(query, column) {
  return sortFields(query).find((f) => f.column === column)?.direction ?? null;
}

/**
 * The query you get by clicking a column header.
 *
 * Cycles ascending → descending → ascending on the column already sorted by,
 * and replaces the clause otherwise. An explicit `direction` skips the cycle:
 * it means "write down what is already happening", which is what adopting the
 * default order does, and toggling it would flip the very thing being adopted.
 *
 * "Already sorted by this" means this column and nothing else. A click on one
 * header of a multi-field sort replaces the whole clause rather than toggling
 * one field of it — reversing one column of `sort a, b` is not something a
 * single click can express, and guessing would be worse than starting fresh.
 */
/**
 * Add a column to the sort rather than replacing it.
 *
 * `sort a, b desc` is expressible in the language and was reachable only by
 * typing it: every header click replaced the whole clause, so a two-column
 * sort could not be built by clicking. "Sort by title, then by hire date" is
 * an ordinary thing to want of a table.
 *
 * A column already in the clause has its direction changed **in place** rather
 * than being moved to the end. Sort order is precedence, and silently
 * re-prioritising the column somebody was only reversing would change the
 * answer in a way nothing on screen explains.
 */
export function addSort(query, column, direction) {
  const parts = splitQuery(query);
  const fields = sortFields(query);
  const desc = direction === 'desc';

  const at = fields.findIndex((f) => f.column === column);
  if (at === -1) fields.push({ column, direction: desc ? 'desc' : 'asc' });
  else fields[at] = { column, direction: desc ? 'desc' : 'asc' };

  parts.sort = `sort ${fields.map((f) => `${f.column}${f.direction === 'desc' ? ' desc' : ''}`).join(', ')}`;
  return joinQuery(parts);
}

/** How many columns the query sorts by — the menu asks, to word itself. */
export function sortCount(query) {
  return sortFields(query).length;
}

export function nextSort(query, column, direction) {
  const parts = splitQuery(query);
  const fields = sortFields(query);
  const onlyThis = fields.length === 1 && fields[0].column === column;

  const desc = direction ? direction === 'desc' : onlyThis && fields[0].direction === 'asc';

  parts.sort = `sort ${column}${desc ? ' desc' : ''}`;
  return joinQuery(parts);
}
