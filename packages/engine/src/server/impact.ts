/**
 * What deleting a row would take with it — shared by the HTTP endpoint and
 * the MCP server, which cannot import index.ts without also running it.
 *
 * One filtered count per incoming constraint, batched, with the constraint's
 * `ON DELETE` rule beside each count: the same three rows are three
 * deletions, three holes, or a refusal depending on it, and a count without
 * the rule invites the reader to guess which.
 *
 * Only the first level. A `cascade` whose children themselves cascade would
 * need the whole reachable graph, and walking it means a query per table per
 * level on a schema that may be cyclic — expensive, and slow exactly when the
 * answer matters most. Saying "three invoice rows, which cascade" is honest
 * and useful; claiming a total that quietly stopped one level down would not
 * be.
 */
import type { Adapter } from '../adapters/adapter.js';
import { referencesTo, type DatabaseSchema } from '../shared/schema.js';

/**
 * Run `work` over `items`, at most `width` at a time, keeping input order.
 *
 * `Promise.all` over a map is the usual shape and is unbounded: it starts
 * everything and hopes the pool underneath copes. For a handful of cheap
 * queries that is right; for a dozen table scans it is a way to make one page
 * load monopolise a connection.
 */
export async function inBatches<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  }
  return out;
}

export async function deleteImpact(
  adapter: Adapter,
  schema: DatabaseSchema,
  tableId: string,
  key: Record<string, string | number>,
  errorMessage: (error: unknown) => string = (error) => (error as Error).message,
) {
  // A declared reference is not the database's: deleting its target touches no row that names it.
  const incoming = referencesTo(schema, tableId).filter((fk) => !fk.declared);
  const found = await inBatches(incoming, 4, async (fk) => {
    const conditions = fk.to.columns.map((toCol, i) => ({
      column: fk.from.columns[i] ?? fk.from.columns[0],
      op: '=' as const,
      value: key[toCol],
    }));
    if (conditions.some((c) => c.value === undefined || c.value === null)) return null;

    const base = {
      table: fk.from.table,
      columns: fk.from.columns,
      constraint: fk.name,
      onDelete: fk.onDelete,
      filter: { groups: [conditions] },
    };
    try {
      return { ...base, count: await adapter.count(fk.from.table, base.filter) };
    } catch (err) {
      // One unreadable table must not stop the report; a count nobody could
      // take is more honest as an error than as a zero.
      return { ...base, count: -1, error: errorMessage(err) };
    }
  });
  /* Constraints with nothing behind them are dropped: "0 rows point at this"
     is noise in a list whose only job is to say what would be affected. */
  return found.filter((r): r is NonNullable<typeof r> => r !== null).filter((r) => r.count !== 0);
}
