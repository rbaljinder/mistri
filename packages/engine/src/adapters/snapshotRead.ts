/**
 * A command that asked for one snapshot (`snapshot: true` on its definition,
 * docs/command-aggregates.md): every read it makes sees the database as of one
 * moment, so a total and the rows behind it, or a count and the pages that
 * follow, agree with each other while other writers carry on.
 *
 * PostgreSQL's write transaction is READ COMMITTED (postgres.ts
 * journalTransaction says why), where each statement sees what committed
 * before it began; asked for a snapshot it opens REPEATABLE READ instead. A
 * row another transaction changed after the snapshot and this one then
 * writes or locks fails with 40001, which the command host says as
 * `stale_record` — the refusal a job or workflow already retries. SQLite's
 * writer holds the file (`BEGIN IMMEDIATE`) from its first statement to its
 * last, so its reads are one snapshot already and nothing here changes it.
 *
 * Carried as the write-ahead hint is (writeAhead.ts): told by the caller that
 * knows the command, read once by the adapter for the transaction it is
 * opening, and not passed to a transaction that work opens inside.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const asked = new AsyncLocalStorage<boolean>();

/** Run `work` with the next write transaction it opens reading one snapshot. */
export function withSnapshotRead<T>(snapshot: boolean, work: () => T): T {
  return asked.run(snapshot, work);
}

/** Whether the transaction about to open here reads one snapshot. */
export function snapshotRead(): boolean {
  return asked.getStore() === true;
}

/** Run `work` without it: a transaction's own work, so nothing it opens takes the snapshot for its own. */
export function withoutSnapshotRead<T>(work: () => T): T {
  return asked.run(false, work);
}

/** PostgreSQL's serialization failure: a REPEATABLE READ transaction wrote or locked a row that moved after its snapshot. */
export function isSnapshotConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === '40001';
}
