/**
 * Group commit for the read audit: the rows appended while the flushes already
 * on their way to the database are writing leave together in the next, one
 * statement and one writer checkout for all of them, and each caller resolves
 * when the flush that holds its row has committed.
 *
 * Each audited read used to take a writer of its own for its one insert. A page
 * sends its reads together (a boot up to eight, a dashboard one per section),
 * so a page cost as many writer checkouts as it had reads, each a round trip,
 * all in line with the saves for the same writers: on a pool of four at 25 ms a
 * round trip, six people opening a page at once waited 370 ms for audit rows
 * where their reads alone took 90, and where writes are serial (one writer, a
 * tenant's queue) every read waited for every row ahead of it. A flush now
 * costs one round trip however many rows it carries, so a burst costs a few.
 *
 * It stays fail-closed. A caller's promise is the flush's: a row is reported
 * written only when the statement holding it committed, and a flush that fails
 * fails every caller in it, each answered 503 (server/readAudit.ts) and none of
 * its rows handed out. A flush is all or nothing (one INSERT on PostgreSQL, one
 * transaction on SQLite), so no caller is refused for a row that was kept.
 *
 * A flush is filed under no account in the writers' line (poolAdmission.ts): it
 * carries rows of whoever was waiting, so charging it to the account whose read
 * happened to start it would let one person's share of the line refuse
 * everyone's rows. Each row's own read was admitted as its account's already,
 * and one batcher has at most READ_AUDIT_FLUSHES in flight, so unfiled audit
 * work cannot crowd the line.
 *
 * An append that could not have been written alone is refused alone, before it
 * joins (`admit`): on SQLite, one made inside a transaction this process holds
 * would otherwise wait for a flush queued behind that same transaction.
 */
import { withoutAdmission } from '@mistriwork/engine/adapters/poolAdmission.js';
import { withoutCancellation } from '@mistriwork/engine/adapters/statementControl.js';

/** The most rows one flush carries: well inside PostgreSQL's 65,535 parameters at eleven a row, and a statement that stays small. */
const READ_AUDIT_BATCH_MOST = 256;

/**
 * How many flushes one batcher has on their way at once. Two, not one: with one,
 * the rows of a page's second wave of reads waited out the first wave's whole
 * flush before theirs could start, a round trip a person paid on an idle pool
 * (25 ms: 58 ms for eight reads became 88). With two the second wave's flush
 * starts at once and the third gathers behind both, so a burst still takes a
 * few writers, not one a read (six people at once on four writers: 5, not 48).
 */
const READ_AUDIT_FLUSHES = 2;

interface Batch<T> {
  readonly items: T[];
  readonly done: Promise<void>;
  settle(error?: unknown): void;
}

function batch<T>(): Batch<T> {
  let settle!: (error?: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (error) => (error === undefined ? resolve() : reject(error));
  });
  return { items: [], done, settle };
}

/**
 * An append that joins the next flush: `flush` is called with one batch at a
 * time, at most `parallel` at once, and must write all of its items or none. `admit`
 * runs for each append before it joins, and a throw refuses that append only.
 */
export function groupCommit<T>(
  flush: (items: readonly T[]) => Promise<void>,
  admit: (item: T) => void = () => {},
  most = READ_AUDIT_BATCH_MOST,
  parallel = READ_AUDIT_FLUSHES,
): (item: T) => Promise<void> {
  const gathering: Array<Batch<T>> = [];
  let inFlight = 0;
  let scheduled = false;
  const start = (): void => {
    scheduled = false;
    while (inFlight < parallel && gathering.length) {
      const current = gathering.shift()!;
      inFlight += 1;
      let written: Promise<void>;
      try {
        /* The flush runs on from the read that started it, so it leaves that read's line and its stop signal: a
           request that gives up must not stop the statement holding other requests' rows. */
        written = withoutCancellation(() => withoutAdmission(() => flush(current.items)));
      } catch (error) {
        written = Promise.reject(error);
      }
      written
        .then(
          () => current.settle(),
          (error: unknown) => current.settle(error ?? new Error('The read audit could not be written.')),
        )
        .finally(() => {
          inFlight -= 1;
          start();
        });
    }
  };
  return (item) => {
    try {
      admit(item);
    } catch (error) {
      return Promise.reject(error);
    }
    let open = gathering.at(-1);
    if (!open || open.items.length >= most) gathering.push((open = batch<T>()));
    open.items.push(item);
    /* The first row waits one turn of the event loop, not a timer: the reads that finished in the same turn join it,
       and a read alone pays nothing it can measure. Once `parallel` flushes are on their way, every row gathers behind them. */
    if (inFlight < parallel && !scheduled) {
      scheduled = true;
      setImmediate(start);
    }
    return open.done;
  };
}
