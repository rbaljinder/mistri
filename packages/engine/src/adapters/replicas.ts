/**
 * Read replicas: which database a read goes to.
 *
 * A connection may name replicas (`"replicas": [url, …]` in its config). A
 * read goes to one only when three things hold, and to the primary otherwise:
 *
 * - The work it runs in said it tolerates lag (`lagTolerantReads`): a list,
 *   a dashboard's breakdowns, a count, an export, the Workbench grid. The
 *   HTTP layer says so per route (packages/engine/src/server/http/readRouting.ts). Nothing
 *   else does, so a read nobody classified — a record page, a command, the
 *   catalog, a store — stays on the primary by default.
 * - No enclosing work pinned the primary (`primaryReads`): a write's own
 *   reads, a record page composed from list reads, the catalog. A pin is not
 *   undone by a lag-tolerant route nested inside it.
 * - Whoever is asking has not written in the last FRESH_READ_MS. A write
 *   sends that browser's reads to the primary for that long, so the list it
 *   returns to after a save shows the save. The marker travels with the
 *   browser, not the process (a short-lived cookie, readRouting.ts), so it
 *   holds across pods and two anonymous visitors never share one. A client
 *   without cookies — a bearer-token API or MCP caller — is keyed by its
 *   token in this process instead: per pod, which is a replica's lag and
 *   nothing worse.
 *
 * Replicas take turns. One that fails to connect, or loses its connection,
 * is passed over for REPLICA_BACKOFF_MS and the read runs again on the
 * primary; a read the primary would refuse as well (a bad filter, a
 * cancel) is not run twice. Replica sessions are read-only the way the
 * primary's readers are (postgresPool.ts, mysql.ts), so a write that
 * reached one by mistake would be refused by the server.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentSpan } from './telemetry/trace.js';
import { isPoolBusy } from './poolMetrics.js';
import { StatementStopped } from './statementControl.js';
import { inBackgroundWork } from './writeLanes.js';

/** How long a person's reads stay on the primary after they write: well past a healthy replica's lag. */
export const FRESH_READ_MS = 10_000;
/** How long a replica that failed is passed over before it is tried again. */
export const REPLICA_BACKOFF_MS = 30_000;
/** The most replicas one connection may name. Past this, a pooler or a load balancer is the tool. */
export const MAX_REPLICAS = 8;

type Preference = 'replica' | 'primary';
const preference = new AsyncLocalStorage<Preference>();

/**
 * Who the current work is for, as far as read-your-write cares. Set by the
 * HTTP layer for the whole request, so a write anywhere in it and a read
 * anywhere after it agree.
 */
export interface ReadContext {
  /** The request arrived with a fresh write marker, or wrote since: its reads stay on the primary. */
  fresh: boolean;
  /** A caller with no cookie jar (a bearer token): its writes are remembered here, in this process, under this key. */
  readonly key?: string;
  /** Called on the request's first write: the HTTP layer sets the marker the browser carries back. */
  readonly onWrite?: () => void;
}
const reader = new AsyncLocalStorage<ReadContext>();

/** Run `work` for `context`: its writes keep its later reads on the primary. */
export function readsAs<T>(context: ReadContext, work: () => T): T {
  return reader.run(context, work);
}

/** Run `work` with its reads allowed on a replica, unless something around it pinned the primary. */
export function lagTolerantReads<T>(work: () => T): T {
  return preference.getStore() === 'primary' ? work() : preference.run('replica', work);
}

/** Run `work` with every read on the primary, whatever runs inside it. */
export function primaryReads<T>(work: () => T): T {
  return preference.getStore() === 'primary' ? work() : preference.run('primary', work);
}

/* Whether any connection in this process has replicas. Until one does, a
   write sets no marker: a deployment without replicas sends no cookie. */
let replicasConfigured = false;

/* Last write per keyed caller, in this process. Pruned as it grows, so many
   tokens cannot grow it without bound. */
const wrote = new Map<string, number>();
const PRUNE_AT = 4_096;

/** A write began for the current caller: its reads go to the primary for FRESH_READ_MS. Background work is nobody's. */
export function noteWrite(now = Date.now()): void {
  if (!replicasConfigured || inBackgroundWork()) return;
  const context = reader.getStore();
  if (!context) return;
  if (!context.fresh) {
    context.fresh = true;
    context.onWrite?.();
  }
  if (context.key === undefined) return;
  wrote.delete(context.key);
  wrote.set(context.key, now);
  if (wrote.size > PRUNE_AT) {
    for (const [key, at] of wrote) {
      if (now - at < FRESH_READ_MS) break;
      wrote.delete(key);
    }
  }
}

/** Whether a read starting now may go to a replica. */
export function replicaReadWanted(now = Date.now()): boolean {
  if (preference.getStore() !== 'replica') return false;
  const context = reader.getStore();
  if (context?.fresh) return false;
  const at = context?.key === undefined ? undefined : wrote.get(context.key);
  return at === undefined || now - at >= FRESH_READ_MS;
}

/** A replica read that must go to the primary instead, for a reason the replica's own error does not say. */
export class ReplicaUnavailable extends Error {
  constructor(
    readonly failure: 'down' | 'retry',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReplicaUnavailable';
  }
}

/**
 * Why a replica's read failed, as far as routing cares:
 * `down` — it could not be reached or lost its connection: pass it over and use the primary;
 * `retry` — this read cannot be answered there now (its pool is full, it lags behind a
 *   migration, recovery cancelled it): use the primary, keep the replica;
 * undefined — the primary would refuse it too, so the error is the answer.
 */
export function replicaFailure(error: unknown): 'down' | 'retry' | undefined {
  if (error instanceof ReplicaUnavailable) return error.failure;
  if (error instanceof StatementStopped) return undefined;
  if (isPoolBusy(error)) return 'retry';
  const e = (error ?? {}) as { code?: unknown; errno?: unknown; fatal?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (NETWORK.has(code) || e.fatal === true) return 'down';
  /* PostgreSQL: connection exceptions (08), the server going away (57P01–03),
     no room (53300), credentials (28) and a database missing (3D000) are the
     replica's state, not the read's. */
  if (/^(08|28)[0-9A-Z]{3}$/.test(code) || ['57P01', '57P02', '57P03', '53300', '3D000'].includes(code)) return 'down';
  /* A standby cancels a read that conflicts with replay; a relation or column
     missing on the replica is a migration that has not reached it yet. */
  if (code === '40001' && /recovery/i.test(message)) return 'retry';
  if (code === '42P01' || code === '42703') return 'retry';
  if (MYSQL_DOWN.has(code)) return 'down';
  if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') return 'retry';
  if (/Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED/i.test(message)) return 'down';
  return undefined;
}

const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN']);
const MYSQL_DOWN = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'ER_SERVER_SHUTDOWN',
]);

/** One connection's replicas, taken in turn, each passed over for a while after it fails. */
export class ReplicaSet<Pool> {
  private next = 0;
  private readonly downUntil: number[];
  /** Reads answered by each replica, and reads that fell back to the primary from it. */
  readonly served: number[];
  readonly fellBack: number[];

  constructor(
    readonly pools: readonly Pool[],
    private readonly now: () => number = () => Date.now(),
  ) {
    if (pools.length > 0) replicasConfigured = true;
    this.downUntil = pools.map(() => 0);
    this.served = pools.map(() => 0);
    this.fellBack = pools.map(() => 0);
  }

  /** The next replica that is not being passed over, or undefined when every one is. */
  pick(): { index: number; pool: Pool } | undefined {
    const at = this.now();
    for (let tried = 0; tried < this.pools.length; tried++) {
      const index = (this.next + tried) % this.pools.length;
      if (this.downUntil[index] <= at) {
        this.next = (index + 1) % this.pools.length;
        return { index, pool: this.pools[index] };
      }
    }
    return undefined;
  }

  /** Pass replica `index` over for REPLICA_BACKOFF_MS. */
  down(index: number): void {
    this.downUntil[index] = this.now() + REPLICA_BACKOFF_MS;
  }

  /** Whether replica `index` is in use now (not being passed over). */
  healthy(index: number): boolean {
    return this.downUntil[index] <= this.now();
  }

  /**
   * Run one read: on a replica when the work wants one and one is in turn,
   * else on the primary. A replica that cannot answer hands the read to the
   * primary (replicaFailure); any other failure is the read's own.
   */
  async read<T>(onReplica: (pool: Pool) => Promise<T>, onPrimary: () => Promise<T>): Promise<T> {
    const chosen = replicaReadWanted() ? this.pick() : undefined;
    const span = currentSpan();
    if (!chosen) {
      span?.setAttribute('mistri.read.pool', 'primary');
      return onPrimary();
    }
    try {
      const out = await onReplica(chosen.pool);
      this.served[chosen.index] += 1;
      span?.setAttribute('mistri.read.pool', 'replica');
      return out;
    } catch (error) {
      const failure = replicaFailure(error);
      if (!failure) throw error;
      if (failure === 'down') this.down(chosen.index);
      this.fellBack[chosen.index] += 1;
      span?.event('replica fallback', { 'mistri.replica': chosen.index + 1, 'mistri.replica.failure': failure });
      span?.setAttribute('mistri.read.pool', 'primary');
      return onPrimary();
    }
  }
}
