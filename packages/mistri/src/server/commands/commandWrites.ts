/**
 * The `mistri-writes` header: the tables a command's run wrote, so the page
 * that ran it asks again only the reads one of them could change, and none
 * after a run that wrote nothing. It is the other half of `mistri-reads`
 * (live/liveReads.ts), in the same names: the ids of the schema the run was
 * cataloged from.
 *
 * It is said only where it can be said whole. A run is told by its receipt, so
 * a route never answers with another run's tables; a replay, a table the run
 * wrote that its catalog does not name, or one the person cannot read (a
 * rollup over it may be on their page) leaves the header off, and the page
 * asks everything again, as it always did.
 *
 * What a database does on its own behind a write is not a statement of the
 * run, so it is not among these. A trigger the App accepts (`triggers` on a
 * resource, docs/trigger-effects.md) writes rows the run did not: an App that
 * names any says nothing here, and its pages read everything again. A trigger
 * the App does not know of is not known here either, as live sync does not
 * see it: a read over the table it writes is asked again when it also reads
 * the written table (a parent its child's trigger totals does, by the
 * reference between them), and otherwise by the page.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppDef } from '../../shared/app.js';

export const WRITES_HEADER = 'mistri-writes';

const told = new AsyncLocalStorage<Map<string, readonly string[]>>();

/** Run a route's command, hearing what each run under it wrote: by receipt id. */
export function hearingWrites<T>(work: (heard: ReadonlyMap<string, readonly string[]>) => Promise<T>): Promise<T> {
  const heard = new Map<string, readonly string[]>();
  return told.run(heard, () => work(heard));
}

/** A run's own word of the tables it wrote, to the route that is hearing; nothing where none is. */
export function tellWrites(receiptId: string, tables: readonly string[]): void {
  told.getStore()?.set(receiptId, tables);
}

/** The header for a route's answer: the tables of the run whose receipt the answer names, or undefined. */
export function writesHeader(
  app: Pick<AppDef, 'resources'>,
  heard: ReadonlyMap<string, readonly string[]>,
  answer: unknown,
): string | undefined {
  // A trigger the App accepts writes beside the run's own statements: what the run wrote is then not all that changed.
  if (Object.values(app.resources ?? {}).some((resource) => resource.triggers?.length)) return undefined;
  const receipt = answer && typeof answer === 'object' ? (answer as { receiptId?: unknown; replayed?: unknown }) : undefined;
  if (typeof receipt?.receiptId !== 'string' || receipt.replayed !== false) return undefined;
  const tables = heard.get(receipt.receiptId);
  /* `tables=` with nothing after it is a run that wrote nothing: said, where an absent header says "not known". */
  return tables && `tables=${[...tables].sort().map(encodeURIComponent).join(',')}`;
}
