/**
 * How long one read statement may run, and how the caller of a read stops it.
 *
 * The cap is one number for every engine: the Postgres pools
 * open with it, `sql` may lower it for a single statement, and
 * nothing raises it. The stop is a signal the caller owns — an MCP client's
 * cancel — and it reaches the adapters ambiently, through
 * AsyncLocalStorage, because a tool call gets to the driver through shared
 * read services (readRecords, readCount, readView) whose signatures are
 * about rows, not about who may abandon them. Each adapter decides what
 * stopping means for its engine: Postgres cancels the backend, SQLite kills the process a raw statement runs in and checks
 * between the statements it runs itself.
 *
 * Only reads are stopped. A write that has started runs to its end, so its
 * outcome is known rather than guessed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The cap every read statement runs under unless a caller lowers it. */
export const STATEMENT_TIMEOUT_MS = 30_000;

/** Below this a cap loses races to the fast path, so a caller cannot ask for less. */
const STATEMENT_TIMEOUT_FLOOR_MS = 100;

/**
 * The cap for one statement: the caller's, when it gave one, held between
 * the floor and the default. Politeness only lowers.
 */
export function statementCap(asked?: number): number {
  if (asked === undefined || !Number.isFinite(asked)) return STATEMENT_TIMEOUT_MS;
  return Math.max(STATEMENT_TIMEOUT_FLOOR_MS, Math.min(STATEMENT_TIMEOUT_MS, Math.floor(asked)));
}

/** A read stopped before it finished: the caller cancelled it, or its cap ran out. */
export class StatementStopped extends Error {
  constructor(
    readonly reason: 'cancelled' | 'timeout',
    readonly capMs?: number,
    options?: ErrorOptions,
  ) {
    super(
      reason === 'cancelled'
        ? 'The statement was cancelled and stopped.'
        : `The statement ran past its ${capMs ?? STATEMENT_TIMEOUT_MS} ms cap and was stopped.`,
      options,
    );
    this.name = 'StatementStopped';
  }
}

const calls = new AsyncLocalStorage<AbortSignal>();

/** Run `work` so that every read it starts can be stopped by `signal`. */
export function withCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return calls.run(signal, work);
}

/** Shared acquisition belongs to its host, not the first request that opens
 * it. Explicitly detach inherited cancellation, including async descendants. */
export function withoutCancellation<T>(work: () => T): T {
  return calls.exit(work);
}

/** The stop signal of the call this code runs for, when there is one. */
export function cancellation(): AbortSignal | undefined {
  return calls.getStore();
}

/** @throws StatementStopped when the call has been cancelled. */
export function throwIfCancelled(signal: AbortSignal | undefined = cancellation()): void {
  if (signal?.aborted) throw new StatementStopped('cancelled');
}

/**
 * Run `stop` once if `signal` aborts before the returned disarm is called:
 * an adapter's "cancel the statement I just started". An already aborted
 * signal stops at once.
 */
export function onCancel(signal: AbortSignal | undefined, stop: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    stop();
    return () => {};
  }
  signal.addEventListener('abort', stop, { once: true });
  return () => signal.removeEventListener('abort', stop);
}

/**
 * Whether a failure is a stopped statement, and why: a StatementStopped, or
 * an engine saying its own cap ran out, in the words each one uses —
 * Postgres's statement_timeout.
 */
export function stoppedReason(error: unknown): 'cancelled' | 'timeout' | undefined {
  if (error instanceof StatementStopped) return error.reason;
  const message = error instanceof Error ? error.message : '';
  return /canceling statement due to statement timeout|maximum statement execution time exceeded|max_statement_time exceeded/i.test(message)
    ? 'timeout'
    : undefined;
}
