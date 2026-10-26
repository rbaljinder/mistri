/**
 * The order an adapter's writes run in, and how long one may wait on a lock.
 *
 * Two orders, chosen once per server (cli/browserMain.ts, cli/mistriMain.ts, embed/handler.ts; serverSettings.ts):
 *
 * - `serial`, the database browser's. Every write — an edit, a raw SQL
 *   statement, a transaction — waits for the one before it, on the one
 *   writer connection. The Workbench's Undo reverts the last write, and "the
 *   last" is a meaningful word only while writes commit one at a time; a raw
 *   statement lands after the edit queued before it. docs/postgresql.md
 *   states this contract, and it stays.
 * - `keyed`, an App's. A write waits only for earlier writes that name one
 *   of its keys — the same record of the same table — and runs beside
 *   everything else, each on a writer connection of its own from the pool.
 *   Two saves of one record still commit in the order they arrived; saves
 *   of two records no longer queue behind each other. What makes that safe
 *   without the queue is the database's own locking, which already held
 *   across pods (docs/postgresql.md "Several writers").
 *
 * A write that names no key (a transaction whose rows are known only inside
 * it, an insert) waits for nothing in `keyed` order; one that names `all`
 * (a raw SQL write, shutdown) waits for everything before it and holds back
 * everything after it, in either order.
 *
 * In-process deadlock is impossible by construction: a write's waits are
 * taken, all at once, when it is queued, and only on writes queued before
 * it, so the waits form no cycle. Rows locked *inside* a transaction are the
 * database's to order, and its deadlock detector and `lock_timeout` bound
 * them; nothing here takes a key lazily.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';
import { startSpan } from './telemetry/trace.js';
import { configureServerSettings, serverSettings, type WriteOrder } from './serverSettings.js';

/** The keys a write names, or `all`: see the file comment. */
export type LaneKeys = readonly string[] | 'all';

/** How long a writer waits for a row or table lock before it gives up, unless told otherwise. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** The shortest and longest lock waits a deployment may ask for. */
export const MIN_LOCK_TIMEOUT_MS = 100;
export const MAX_LOCK_TIMEOUT_MS = 30_000;

export const MAX_WRITERS = 64;

/**
 * The reader and the writer pool an App's database gets unless told: twice
 * the cores, from four to sixteen. A node process is one core of JavaScript,
 * and with fewer connections than requests in flight the pool, not the
 * database, is what a write waits for (a 500-user soak: Postgres idle, 98%
 * of writer checkouts queued behind four writers). Sixteen caps the sum
 * (readers + writers, per pod per database; docs/postgresql.md does it)
 * well inside a stock server's 100 connections.
 */
export function balancedPoolSize(cores: number = availableParallelism()): number {
  return Math.min(16, Math.max(4, 2 * cores));
}

/** The writer pool's size where an App writes, unless a connection or the command line says otherwise. */
const DEFAULT_WRITERS = balancedPoolSize();

/** Whether `value` is a writer pool size: a whole number from 1 to 64. */
export function isWriterCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WRITERS;
}

/**
 * The order every adapter this process opens from now on writes in: `keyed`
 * where the process serves Apps, `serial` (the default) for the database
 * browser. Called once, at startup, before a connection opens; an adapter
 * reads it when it is made. A handler mounted in a host's process carries its
 * own (serverSettings.ts), and this is the process's, outside any.
 */
export function configureWriteOrder(order: WriteOrder): void {
  if (order !== 'serial' && order !== 'keyed') throw new RangeError('The write order is "serial" or "keyed".');
  configureServerSettings({ writeOrder: order });
}

export function writeOrder(): WriteOrder {
  return serverSettings().writeOrder;
}

/** `--write-pool`: the writers an App's PostgreSQL or MySQL source holds, unless its connection names a number. */
export function configureWriterPool(writers: number = balancedPoolSize()): void {
  if (!isWriterCount(writers))
    throw new RangeError(`A write pool holds 1 to ${MAX_WRITERS} connections; ${String(writers)} is not one of them.`);
  configureServerSettings({ writers });
}

export function writerPoolSize(): number {
  return serverSettings().writers ?? DEFAULT_WRITERS;
}

/** Whether `ms` is a lock wait a deployment may set: whole milliseconds from 100 to 30,000. */
export function isLockTimeout(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= MIN_LOCK_TIMEOUT_MS && ms <= MAX_LOCK_TIMEOUT_MS;
}

/** `--lock-timeout`: how long any writer of this process waits for a lock. At most the statement cap, which would stop it anyway. */
export function configureLockTimeout(ms: number = DEFAULT_LOCK_TIMEOUT_MS): void {
  if (!isLockTimeout(ms)) throw new RangeError(`A lock timeout is ${MIN_LOCK_TIMEOUT_MS} to ${MAX_LOCK_TIMEOUT_MS} milliseconds.`);
  configureServerSettings({ lockTimeoutMs: ms });
}

export function lockTimeoutMs(): number {
  return serverSettings().lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
}

const background = new AsyncLocalStorage<true>();

/**
 * Run `work` as background work — a job's command, an effect's delivery —
 * so every writer lease beneath it comes from the background connection
 * (postgresPool.ts), never from the pool a person's save is waiting on.
 */
export function asBackgroundWork<T>(work: () => T): T {
  return background.run(true, work);
}

export function inBackgroundWork(): boolean {
  return background.getStore() === true;
}

/**
 * One record's lane: its table and its key, the values as text, so the key
 * an address spells `'7'` and the one a row holds as `7` are one lane. The
 * table as the caller named it; two spellings of one table are two lanes,
 * which the row lock still orders.
 */
export function recordLane(table: string, key: Readonly<Record<string, unknown>>): string {
  const pairs = Object.keys(key)
    .sort()
    .map((column) => [column, String(key[column])]);
  return JSON.stringify([table, pairs]);
}

/** The lane of a request that names one record by its key, or none when it names none the adapter would accept (it refuses it). */
export function keyedLane(request: { table?: unknown; key?: unknown }): readonly string[] {
  const { table, key } = request ?? {};
  if (typeof table !== 'string' || !key || typeof key !== 'object' || Array.isArray(key)) return [];
  return [recordLane(table, key as Record<string, unknown>)];
}

const hinted = new AsyncLocalStorage<readonly string[]>();

/**
 * Run `work` in one record's lane: every write it starts that names no lane
 * of its own — a transaction, through whatever wrappers an App puts round
 * its adapter — takes this one. How an App's save of a record, which runs
 * as a transaction that locks the row, keeps its place behind the earlier
 * saves of that record without every wrapper learning a new argument. Only
 * the first write beneath it takes the lane: the work a lane runs sees none.
 */
export function inRecordLane<T>(table: string, key: Readonly<Record<string, unknown>>, work: () => Promise<T>): Promise<T> {
  return hinted.run(keyedLane({ table, key }), work);
}

/** All known targets and the receipt scope enter together, before any lease is taken. */
export function inWriteLanes<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
  return hinted.run([...new Set(keys)].sort(), work);
}

/**
 * The per-adapter queue. `run(keys, work)` starts `work` once every earlier
 * write it must follow has settled, and settles as `work` does.
 */
export class WriteLanes {
  /** The last `all` write: every later write waits for it. */
  private barrier: Promise<void> = Promise.resolve();
  private barrierPending = false;
  /** The last write naming each key, while it runs. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Every write not yet settled: what an `all` write waits for. */
  private readonly running = new Set<Promise<void>>();

  constructor(readonly order: WriteOrder = writeOrder()) {}

  run<T>(keys: LaneKeys, work: () => Promise<T>): Promise<T> {
    // The browser's order: everything is `all`, which is the queue it always was.
    const hint = hinted.getStore();
    const named = this.order === 'serial' ? 'all' : keys === 'all' || !hint?.length ? keys : [...keys, ...hint];
    const waits: Promise<void>[] = [];
    if (this.barrierPending) waits.push(this.barrier);
    if (named === 'all') waits.push(...this.running);
    else
      for (const key of new Set(named)) {
        const tail = this.tails.get(key);
        if (tail) waits.push(tail);
      }
    /* Only a write that really waits is said to: a span per write would
       bury the request's own statements under empty ones. */
    const queued = waits.length
      ? startSpan('write queue', {
          childOnly: true,
          attributes: { 'mistri.write.order': this.order, 'mistri.write.behind': waits.length },
        })
      : undefined;
    const ready = waits.length
      ? Promise.all(waits).then(() => {
          queued?.end();
        })
      : Promise.resolve();
    // The lane is this write's; what the write starts is not in it.
    const next = ready.then(() => (hint ? hinted.exit(work) : work()));
    const settled = next.then(
      () => {},
      () => {},
    );
    this.running.add(settled);
    void settled.then(() => this.running.delete(settled));
    if (named === 'all') {
      this.barrier = settled;
      this.barrierPending = true;
      void settled.then(() => {
        if (this.barrier === settled) this.barrierPending = false;
      });
    } else
      for (const key of new Set(named)) {
        this.tails.set(key, settled);
        void settled.then(() => {
          if (this.tails.get(key) === settled) this.tails.delete(key);
        });
      }
    return next;
  }
}

/**
 * A lock wait that ran out: PostgreSQL's `lock_timeout` (55P03), MySQL's
 * `innodb_lock_wait_timeout` (1205), anywhere in the error's causes. The
 * statement that waited failed and its transaction was rolled back, so
 * nothing it wrote landed — unless the rollback itself was never
 * acknowledged, which the caller has already said as an unknown outcome
 * and which this does not look inside.
 */
export function lockTimedOut(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 4 && at && typeof at === 'object'; depth++) {
    if ((at as { name?: unknown }).name === 'TransactionOutcomeUnknown' || (at as { outcome?: unknown }).outcome === 'unknown')
      return false;
    const { code, errno } = at as { code?: unknown; errno?: unknown };
    if (code === '55P03' || errno === 1205 || code === 'ER_LOCK_WAIT_TIMEOUT') return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** What a person is told when their write waited out a lock, and how soon to try again. */
export const ROW_LOCKED_MESSAGE = 'The record is locked by another transaction. Nothing was saved; try again in a moment.';
export const ROW_LOCKED_RETRY_AFTER_SECONDS = 1;
