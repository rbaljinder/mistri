/**
 * A dashboard's time-window phrases, read and rewritten: the previous period
 * a metric compares with, and a section's own window lifted out so the
 * reader's pick can stand in its place (app.ts, resolveDashboard).
 */
/**
 * The compare most metrics mean, derived instead of hand-written: given a
 * query with exactly one "last N days/weeks/months/years" phrase, the
 * previous period is that window shifted back one length — `close_date =
 * last 90 days` becomes `close_date = previous 90 days`, everything else
 * in the query kept. `previous N` is the grammar's own phrase for exactly
 * that window, computed beside `last N` so the two spans are equal by
 * construction; the old spelling, `last 180 days and < last 90 days`, was
 * a day short (`last N days` runs to tomorrow and so covers N+1 days) — a
 * 1% bias at 90 days and a 100% one at `last 1 day`. Ambiguity refuses:
 * two window phrases (or none) means the author knows something this
 * rule does not, and the full compare query is theirs to write.
 */
export const PREVIOUS_PERIOD = 'previous period';
const WINDOW_PHRASE = /\b([A-Za-z_][\w.]*)\s*=\s*last\s+(\d+)\s+(day|week|month|year)s?\b/gi;
export function previousPeriodQuery(query: string | undefined): { query: string } | { error: string } {
  const found = [...(query ?? '').matchAll(WINDOW_PHRASE)];
  /* None is the metric with no date at all — no "over" to follow the reader's window and no window of its own — and
     is said as that, since "needs exactly one phrase" sent authors to write a phrase when the clock was the fix. */
  if (found.length === 0) {
    return {
      error:
        `compare "${PREVIOUS_PERIOD}" has no dates to compare: the metric names no "over" (a date column to follow ` +
        `the window the reader picks) and its "query" sets no "last N days/weeks/months/years" window. Give it ` +
        `over: '<a date column>', or write the compare query in full instead. See \`mistri docs dashboards\`.`,
    };
  }
  if (found.length !== 1) {
    return {
      error:
        `compare "${PREVIOUS_PERIOD}" needs exactly one "last N days/weeks/months/years" phrase in "query" — ` +
        `it has ${found.length}. Write the compare query in full instead. See \`mistri docs dashboards\`.`,
    };
  }
  const [whole, col, n, unit] = found[0];
  const len = Number(n);
  return { query: (query ?? '').replace(whole, `${col} = previous ${len} ${unit}${len === 1 ? '' : 's'}`) };
}

/** Whether a query sets any `column = last N …` window of its own. */
export const hasWindowPhrase = (query: string | undefined): boolean => [...(query ?? '').matchAll(WINDOW_PHRASE)].length > 0;

/**
 * The query with its one `column = last N …` phrase on `column` removed, or
 * undefined when it has no such phrase (or more than one — then the author
 * means something this rule does not know). Dangling `and`s are tidied so
 * `a and col = last 30 days and b` becomes `a and b`.
 */
export function withoutWindowPhrase(query: string | undefined, column: string): string | undefined {
  const found = [...(query ?? '').matchAll(WINDOW_PHRASE)].filter((m) => m[1] === column);
  if (found.length !== 1) return undefined;
  let cut = (query ?? '').replace(found[0][0], ' ');
  /* A segment's conditions are written in brackets (query.ts expandSegments), so the phrase may leave `( and b)`
     or `()` behind as well as a dangling `and`: tidied until nothing changes. */
  for (let was = ''; was !== cut;) {
    was = cut;
    cut = cut
      .replace(/\(\s*\)/g, ' ')
      .replace(/\(\s*and\s+/gi, '(')
      .replace(/\s+and\s*\)/gi, ')')
      .replace(/\s+and\s+and\s+/gi, ' and ')
      .replace(/^\s*and\s+/i, '')
      .replace(/\s+and\s*$/i, '');
  }
  return cut.replace(/\s+/g, ' ').trim();
}
