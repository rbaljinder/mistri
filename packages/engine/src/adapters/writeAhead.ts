/**
 * What a write transaction is about to ask, told to the adapter before it
 * begins, so the reads and locks it will open with leave behind its BEGIN in
 * one round trip instead of one round trip each (postgresTransactionHandle.ts
 * sendAhead).
 *
 * A hint, never an instruction: the adapter turns it into the exact
 * statements the transaction would send in its turn, each answered once to
 * the identical statement when it comes, and anything the transaction never
 * asks is dropped unread. A wrong hint costs the statements it sent and is
 * counted (aheadReport); it never changes an answer.
 *
 * Carried the way `inWriteLanes` carries its keys (writeLanes.ts): by the
 * caller that knows the command, through the owners between it and the
 * adapter, each of which may translate it (a tenant source's logical tables
 * to physical ones) or drop it. The adapter reads it once, for the
 * transaction it is opening, and runs that transaction's own work without
 * it, so a transaction opened inside never takes it for its own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** A record the transaction reads by its key first, and, unless only read, writes. */
interface WriteAheadTarget {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
}

export interface WriteAhead {
  /** The receipt the transaction's journal looks up before anything else (its journal's own shape; the journal checks it). */
  readonly receipt?: unknown;
  /** Records read by key before the work starts: locked, read in full through the row scope. */
  readonly targets: readonly WriteAheadTarget[];
  /** Whether those records are then written, so the write's own reads of them are sent too. */
  readonly writes: boolean;
  /** Records only read, never locked (a command's preparation): their rows are sent ahead, no FOR UPDATE with them. */
  readonly readOnly?: true;
  /** Whether the work locks each record itself first (a save's lockRecord). An unscoped transaction sends a record's
   * lock ahead only then, or where its history capture will lock it; a scoped one always locks its targets. */
  readonly locks?: true;
}

const hinted = new AsyncLocalStorage<WriteAhead | undefined>();

/** Run `work` with `hint` told to the next write transaction it opens. */
export function withWriteAhead<T>(hint: WriteAhead | undefined, work: () => T): T {
  return hinted.run(hint, work);
}

/** The hint for the transaction about to open here, if one was told. */
export function writeAhead(): WriteAhead | undefined {
  return hinted.getStore();
}

/** Run `work` with no hint: a transaction's own work, so nothing it opens takes its hint. */
export function withoutWriteAhead<T>(work: () => T): T {
  return hinted.run(undefined, work);
}

/** The hint with each target's table renamed (a tenant source's logical table to its physical one); undefined when one cannot be. */
export function renamedWriteAhead(hint: WriteAhead | undefined, rename: (table: string) => string | undefined): WriteAhead | undefined {
  if (!hint) return undefined;
  const targets: WriteAheadTarget[] = [];
  for (const target of hint.targets) {
    const table = rename(target.table);
    if (table === undefined) return undefined;
    targets.push({ table, key: target.key });
  }
  return { ...hint, targets };
}
