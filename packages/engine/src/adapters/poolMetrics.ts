/**
 * What a connection pool can say about itself: how long each checkout waited
 * for a connection, how long it held one, and how full the pool is now.
 *
 * Engine-neutral and fixed-size: cumulative counters and bucket counts on the
 * HTTP request metrics' bounds, so the operator surface carries them without
 * learning a driver, and their size never grows with traffic. One meter per
 * role of a pool — the readers, the writers, the background writer — and nothing in it names the
 * database, because the operator surface must not.
 */

/** Inclusive upper bounds, the same as the HTTP request metrics', so one scale reads both. */
export const POOL_DURATION_BOUNDS_MS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000]);

/** How long a checkout that timed out keeps its pool marked saturated. */
const SATURATION_MEMORY_MS = 60_000;

/**
 * How long a checkout may queue behind a full pool before it is refused, and
 * how many may queue (per connection the pool holds). Without them a
 * saturated server held every request for the driver's ten-second timeout and
 * then failed it as a 500: slow, and no better informed. Past either bound the
 * request is refused at once, as busy, and its client is told to come back.
 */
export const POOL_QUEUE_WAIT_MS = 2_000;
export const POOL_QUEUE_PER_CONNECTION = 8;

/** What a person is told when the server is busy, and how soon to try again. */
export const POOL_BUSY_MESSAGE = 'The server is busy; try again in a moment.';
export const POOL_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * A checkout refused because the pool is full and its queue is too long or
 * has waited too long. Thrown before anything was leased, so no statement
 * ran: a read can be asked again and a write was never begun.
 */
export class PoolBusy extends Error {
  constructor(
    readonly role: 'read' | 'write',
    readonly why: 'queue_full' | 'queue_timeout',
  ) {
    super(POOL_BUSY_MESSAGE);
    this.name = 'PoolBusy';
  }
}

/**
 * Whether `error` is a refused checkout, anywhere in its causes, and not one
 * that reports an unknown outcome (a transaction whose commit was never
 * acknowledged is not "busy": it may have landed).
 */
export function isPoolBusy(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 4 && at && typeof at === 'object'; depth++) {
    if ((at as { name?: unknown }).name === 'TransactionOutcomeUnknown' || (at as { outcome?: unknown }).outcome === 'unknown')
      return false;
    if (at instanceof PoolBusy) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** The readers, the writers, the one connection background work writes through, and a read replica's readers. */
export type PoolRole = 'read' | 'write' | 'background' | 'replica';

/** What sits between the process and the server: nothing that moves server
 * connections between clients mid-session (`session`), or a pooler that
 * does so after every transaction (`transaction`). */
export type PoolerMode = 'session' | 'transaction';

export interface PoolRoleStats {
  readonly role: PoolRole;
  /** Which of the connection's replicas, from 1, for a replica's readers. */
  readonly replica?: number;
  readonly pooler: PoolerMode;
  /** The most connections this role may hold at once. */
  readonly size: number;
  /** Physical connections the driver holds now, idle ones included; null when it does not say. */
  readonly open: number | null;
  /** Checked out now. */
  readonly inUse: number;
  /** Checkouts queued now behind a pool whose every connection is in use. */
  readonly waiting: number;
  /** A checkout is queued now, or one timed out within the last minute. */
  readonly saturated: boolean;
  /** Checkouts started, cumulative. */
  readonly checkouts: number;
  /** Checkouts that found every connection in use or already being opened, cumulative. */
  readonly queued: number;
  /** Checkouts refused at the acquisition timeout or by the queue's bounds (PoolBusy), cumulative. */
  readonly timedOut: number;
  /** Checkouts that failed otherwise: a refused connection, a failed session setup. */
  readonly failed: number;
  /** From asking to holding (or failing), one count per bucket of POOL_DURATION_BOUNDS_MS, then overflow. */
  readonly waitBuckets: readonly number[];
  /** From holding to giving back, bucketed the same way. */
  readonly holdBuckets: readonly number[];
}

/** One checkout in progress. */
export interface PoolCheckout {
  /** The connection arrived. The returned function gives it back. */
  acquired(): () => void;
  /** The checkout failed; `timedOut` when the driver gave up waiting for a connection. */
  failed(timedOut: boolean): void;
}

function record(buckets: number[], ms: number): void {
  const at = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const index = POOL_DURATION_BOUNDS_MS.findIndex((bound) => at <= bound);
  buckets[index < 0 ? POOL_DURATION_BOUNDS_MS.length : index] += 1;
}

export class PoolMeter {
  private leased = 0;
  private pending = 0;
  private checkouts = 0;
  private queued = 0;
  private timeouts = 0;
  private failures = 0;
  private lastTimeoutAt = Number.NEGATIVE_INFINITY;
  private readonly waits = Array<number>(POOL_DURATION_BOUNDS_MS.length + 1).fill(0);
  private readonly holds = Array<number>(POOL_DURATION_BOUNDS_MS.length + 1).fill(0);

  constructor(
    readonly role: PoolRole,
    readonly size: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Every connection is leased or being opened: a checkout begun now waits. */
  full(): boolean {
    return this.leased + this.pending >= this.size;
  }

  /** Checkouts queued now behind a pool whose every connection is in use. */
  waiting(): number {
    return Math.max(0, this.pending - Math.max(0, this.size - this.leased));
  }

  /** A checkout turned away before it began: counted as a timeout, so the pool reads saturated and readiness says so. */
  refuse(): void {
    this.checkouts += 1;
    this.queued += 1;
    this.timeouts += 1;
    this.lastTimeoutAt = this.now();
    record(this.waits, 0);
  }

  begin(): PoolCheckout {
    const started = this.now();
    /* Every connection is leased, or being opened for a checkout ahead of
       this one: this one waits in the driver's queue, not for a dial. */
    if (this.leased + this.pending >= this.size) this.queued += 1;
    this.checkouts += 1;
    this.pending += 1;
    let settled = false;
    return {
      acquired: () => {
        if (settled) return () => {};
        settled = true;
        this.pending -= 1;
        this.leased += 1;
        const at = this.now();
        record(this.waits, at - started);
        let returned = false;
        return () => {
          if (returned) return;
          returned = true;
          this.leased -= 1;
          record(this.holds, this.now() - at);
        };
      },
      failed: (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        this.pending -= 1;
        const at = this.now();
        // A checkout that timed out waited longest of all; it is the sample that matters most.
        record(this.waits, at - started);
        if (timedOut) {
          this.timeouts += 1;
          this.lastTimeoutAt = at;
        } else this.failures += 1;
      },
    };
  }

  stats(pooler: PoolerMode, open: number | null): PoolRoleStats {
    const waiting = this.waiting();
    return Object.freeze({
      role: this.role,
      pooler,
      size: this.size,
      open,
      inUse: this.leased,
      waiting,
      saturated: waiting > 0 || this.now() - this.lastTimeoutAt < SATURATION_MEMORY_MS,
      checkouts: this.checkouts,
      queued: this.queued,
      timedOut: this.timeouts,
      failed: this.failures,
      waitBuckets: Object.freeze([...this.waits]),
      holdBuckets: Object.freeze([...this.holds]),
    });
  }
}
