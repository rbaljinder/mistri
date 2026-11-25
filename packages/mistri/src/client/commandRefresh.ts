/**
 * What a command that ran asks the page to read again.
 *
 * Every read, until the server said which tables the run wrote (`mistri-writes`, kit liveReads.ts `writesOf`): then
 * only the reads that could show one of them, and none of those after a run that wrote nothing — a command that only
 * works something out no longer reads a board's lists and its loader again on every click.
 *
 * A read is left alone only where both halves are known. The reads of text (a list, a count, a breakdown, a
 * component's own `useRows`) and a page's loader are filed with the tables the server says they answer from (the
 * `mistri-reads` live sync goes by, a superset by construction: references, rollups' children, computed columns'
 * paths); one with none filed is asked again, as is every other kind of read — a command's availability, a record's
 * history, the inbox — and as is everything when the run's tables are not known or name a table this page's catalog
 * does not hold. An extra read, never a missed one.
 */
import type { Query, QueryClient } from '@tanstack/react-query';
import { state } from '@mistriwork/kit/client/core.js';
import { queryReads } from '@mistriwork/kit/client/liveReads.js';

/* The families filed by table: liveInvalidate.ts's reads of text, and a free-form page's loader. */
const FILED = new Set(['run', 'count', 'breakdown', 'measure', 'mistri-ui', 'mistri-page']);

/** Whether a read could show what a run that wrote `tables` changed. */
function shows(query: Query, tables: ReadonlySet<string>): boolean {
  if (!FILED.has(String(query.queryKey[0]))) return true;
  const filed = queryReads(query.queryHash);
  return !filed || filed.some((id) => tables.has(id));
}

/** Ask again what a command that wrote `wrote` could have changed; everything, where that is not known. */
export function refreshAfterWrites(client: QueryClient, wrote: readonly string[] | undefined): Promise<void> {
  const known = new Set<string>((state.schema?.tables ?? []).map((table: { id: string }) => table.id));
  if (!wrote || !wrote.every((id) => known.has(id))) return client.invalidateQueries();
  const tables = new Set(wrote);
  return client.invalidateQueries({ predicate: (query) => shows(query, tables) });
}
