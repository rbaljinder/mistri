/**
 * A query's trailing clauses, found by keyword: the client's chips take them
 * off one at a time (client/clauses.js), and a list's question is built and
 * read by them on both sides (listQuestion.ts).
 *
 * The split is by keyword, which the grammar makes safe: a query is a table,
 * then conditions, then any of `show`, `sort`/`order by` and `limit` in that
 * order. Only the trailing keywords are looked for, so a *value* containing
 * the word "limit" cannot be mistaken for the clause — the boundary is found
 * from the right, and only outside quotes.
 */

/** Trailing clause keywords, longest first so `order by` wins over `order`. */
const TAIL = [
  { key: 'limit', pattern: /\blimit\b/i },
  { key: 'sort', pattern: /\b(?:sort|order\s+by)\b/i },
  { key: 'show', pattern: /\bshow\b/i },
] as const;

/**
 * Positions of characters that are inside a quoted value.
 *
 * `status = "sort code"` contains the word `sort` and does not contain a sort
 * clause. Scanning for quotes first is what keeps the two apart.
 */
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) {
        spans.push([start, i]);
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      start = i;
    }
  }
  if (quote) spans.push([start, text.length]);
  return spans;
}

const inside = (spans: Array<[number, number]>, at: number) => spans.some(([a, b]) => at > a && at < b);

/* The quote mask every scanner here reads through; the client imports it from this module. */
export { maskQuoted } from './maskQuoted.js';

/** A query's parts: its table, its conditions and each trailing clause it has, keyword and all. */
interface QueryParts {
  table: string;
  filter: string;
  show?: string;
  sort?: string;
  limit?: string;
}

/** Break a query into its table, filter and trailing clauses. */
export function splitQuery(text: unknown): QueryParts {
  const query = String(text ?? '').trim();
  const spans = quotedSpans(query);

  const firstSpace = query.search(/\s/);
  const table = firstSpace < 0 ? query : query.slice(0, firstSpace);
  let rest = firstSpace < 0 ? '' : query.slice(firstSpace + 1);
  const offset = firstSpace + 1;

  const parts: QueryParts = { table, filter: '' };

  /* Boundaries are found first, then sorted by *position* — not peeled off in
     grammar order.

     Peeling assumed the clauses arrive in the order the grammar lists them. The
     parser does not require that, and `customer limit 5 sort name` is a query
     someone will type. Peeling `limit` first took everything from `limit` to
     the end, so the sort clause was swallowed into it: the chip read "5 sort
     name" and removing the limit removed the sort with it.

     The last occurrence of each keyword wins, because a clause word can appear
     earlier as an unquoted value; quoted ones are excluded outright. */
  const marks: Array<{ key: 'limit' | 'sort' | 'show'; at: number }> = [];
  for (const { key, pattern } of TAIL) {
    let at = -1;
    let from = 0;
    for (;;) {
      const found = rest.slice(from).search(pattern);
      if (found < 0) break;
      const absolute = from + found;
      if (!inside(spans, offset + absolute)) at = absolute;
      from = absolute + 1;
    }
    if (at >= 0) marks.push({ key, at });
  }
  marks.sort((a, b) => a.at - b.at);

  marks.forEach(({ key, at }, i) => {
    const until = marks[i + 1]?.at ?? rest.length;
    parts[key] = rest.slice(at, until).trim();
  });
  if (marks.length) rest = rest.slice(0, marks[0].at);

  parts.filter = rest.trim();
  return parts;
}
