/**
 * A sort written the way the query bar writes it — "due_on desc, name" —
 * parsed to the structure a planner runs. One spelling for one question: a
 * structured orderBy lived beside textual sort in tab queries, and remembering
 * which surface wanted which was a tax on every author.
 *
 * A page section's `sort` (pageConfig.ts) and a record view's list section
 * (recordview.ts) both read it here, so the two cannot drift into accepting
 * different text. `example` is the surface's own sample, quoted in the error.
 */
export function parseSortText(raw: unknown, at: string, example: string): Array<{ column: string; direction: 'asc' | 'desc' }> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${at} has a "sort" that is not query-bar text like "${example}".`);
  }
  return raw.split(',').map((part) => {
    const words = part.trim().split(/\s+/);
    const column = words[0] ?? '';
    const direction = (words[1] ?? 'asc').toLowerCase();
    if (!column || words.length > 2 || (direction !== 'asc' && direction !== 'desc')) {
      throw new Error(`${at} has a "sort" it cannot read at "${part.trim()}". Write it like the query bar: "${example}".`);
    }
    return { column, direction: direction as 'asc' | 'desc' };
  });
}
