/**
 * The PostgreSQL connections of one database: a bounded reader pool, a
 * writer pool, and one background writer, each opened on first use, every
 * lease given back in `finally`.
 *
 * Three things vary by deployment, per manager or, for the whole process,
 * from the command line:
 *
 * - How many readers the pool may hold: for an App as many as its writers
 *   (at least balancedPoolSize), four for the database browser, unless told
 *   otherwise; one to sixty-four.
 * - How many writers: balancedPoolSize for a process serving Apps unless told otherwise
 *   (`pool.write`, `--write-pool`; writeLanes.ts), one to sixty-four, each running one
 *   transaction beside the others (writeLanes.ts orders writes of one
 *   record). The database browser keeps one: its writes run one at a time,
 *   the order its Undo depends on (docs/postgresql.md).
 * - Background work — a job's command — writes through a connection of its
 *   own, so it never takes the writer a person's save is waiting for.
 * - What sits between this process and the server. Directly, or through a
 *   pooler that gives each client a whole server session, the read-only
 *   default and the statement cap are set once per physical connection.
 *   Through a transaction-mode pooler they are set per transaction instead
 *   (postgresPooler.ts): the next transaction may run on another server
 *   connection, and anything set on this one stays for the pooler's next
 *   client.
 *
 * Every checkout is metered (poolMetrics.ts) — the wait for a connection,
 * how long it was held, how many are queued now — for the operator surface.
 *
 * A connection that names replicas gets a manager per replica, sized like
 * this one's readers, and the reader handle's statements go to one of them
 * when the work they run in tolerates lag (replicas.ts). Everything that
 * leases a whole client — a snapshot, a raw SQL read, a store's read, every
 * write — stays here, on the primary.
 */
import { cancellation, onCancel, STATEMENT_TIMEOUT_MS, StatementStopped, throwIfCancelled } from './statementControl.js';
import {
  PoolBusy,
  PoolMeter,
  POOL_QUEUE_PER_CONNECTION,
  POOL_QUEUE_WAIT_MS,
  type PoolerMode,
  type PoolRole,
  type PoolRoleStats,
} from './poolMetrics.js';
import { pgConnectionOptions } from './postgresValues.js';
import { sealedPgOptions } from './net/untrustedDatabase.js';
import type { NetworkPolicy } from './net/networkPolicy.js';
import { transactionScoped } from './postgresPooler.js';
import { balancedPoolSize, inBackgroundWork, isWriterCount, lockTimeoutMs, MAX_WRITERS, writeOrder, writerPoolSize } from './writeLanes.js';
import { startSpan } from './telemetry/trace.js';
import type * as ServerTiming from './telemetry/serverTiming.js';
import { configureServerSettings, serverSettings } from './serverSettings.js';
import { MAX_REPLICAS, noteWrite, primaryReads, ReplicaSet } from './replicas.js';

export interface PgResult<Row> {
  rows: Row[];
  fields: Array<{ name: string }>;
  rowCount: number | null;
}

export interface PgQuery {
  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
}

export interface PgClient extends PgQuery {
  release(destroy?: boolean | Error): void;
  /** Native clients expose checkout-local lifecycle events. Optional only for
   * legacy test/load adapters; observed snapshot checkouts require both. */
  on?(event: 'error' | 'end', listener: () => void): unknown;
  off?(event: 'error' | 'end', listener: () => void): unknown;
  /** The backend this client talks to: what a cancel names. */
  readonly processID?: number | null;
}

export interface PgPool extends PgQuery {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface PgPoolOptions {
  connectionString?: string;
  ssl?: { rejectUnauthorized: true };
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  /** Idle clients the pool keeps past `idleTimeoutMillis`. */
  min?: number;
  /** Idle clients do not keep the process alive on their own. */
  allowExitOnIdle?: boolean;
  onConnect(client: PgQuery): Promise<void>;
  /** Send each query as it is asked, without waiting for the one before to be answered (node-postgres 8.21+). */
  pipeline?: boolean;
}

type PgPoolLoader = () => Promise<unknown>;

/* The leases whose client sends each query without waiting for the one before
   (a writer's, on node-postgres): what pipelined() may send together. */
const pipelining = new WeakSet<PgQuery>();
/** This lease's client pipelines: several queries asked at once leave together. */
export const pipelines = (client: PgQuery): boolean => pipelining.has(client);

/** The one-off client a cancel is sent from. */
interface PgCancelClient {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}
type PgClientClass = new (options: {
  connectionString?: string;
  ssl?: { rejectUnauthorized: true };
  connectionTimeoutMillis: number;
}) => PgCancelClient;

const loadPg: PgPoolLoader = async () => {
  const specifier = 'pg';
  return import(specifier).catch(() => {
    throw new Error('Postgres support needs the "pg" package. Install it with: npm install pg');
  });
};

/** The database browser's reader pool size unless a connection or the command line says otherwise.
 * An App's is balanced against its writers (appReaders). */
export const DEFAULT_READERS = 4;
/** Readers kept connected through an idle spell. Without them the first read
 * after thirty quiet seconds paid a new connection and its two SETs — and a
 * dashboard's fan-out paid it several times at once. Two, not the whole pool:
 * a warm connection is a server backend held for nothing most of the day. */
const WARM_READERS = 2;
/** The most readers one database's pool may hold. Past this, a pooler in front of the server is the tool. */
export const MAX_READERS = 64;

/** What pg-pool says when no connection came free within the acquisition timeout. */
const ACQUISITION_TIMEOUT = /timeout exceeded when trying to connect/i;

/** Whether `value` is a reader pool size a manager accepts: a whole number from 1 to 64. */
export function isReaderCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_READERS;
}

export interface PgConnectionOptions {
  /** Reader connections held at once, 1–64. The process default when absent. */
  readonly readers?: number;
  /** Writer connections held at once, 1–64, where writes are keyed (writeLanes.ts); one where they are serial. */
  readonly writers?: number;
  /** How long a writer waits for a lock. The process's (`--lock-timeout`) when absent. */
  readonly lockTimeoutMs?: number;
  /** What sits between this process and the server. The process default when absent. */
  readonly pooler?: PoolerMode;
  /** The statement cap every lease runs under. Only tests lower it. */
  readonly capMs?: number;
  /** How long a checkout may queue behind a full pool before it is refused as busy (poolMetrics.ts). Only tests change it. */
  readonly queueWaitMs?: number;
  /** How many checkouts per pool connection may queue before the next is refused. Only tests change it. */
  readonly queuePerConnection?: number;
  /** Read replicas of this database, by URL: lag-tolerant reads go to them in turn (replicas.ts). */
  readonly replicas?: readonly string[];
  /** Set when an untrusted client typed the address: it is dialled sealed, through this policy (untrustedDatabase.ts). */
  readonly network?: NetworkPolicy;
  /**
   * Readers send each query as it is asked, as writers do: for an owner that
   * asks several statements of one snapshot at once and waits on them in
   * order (a tenant read source, `readSnapshot`'s `ahead`). Off for every
   * other reader, whose callers ask one statement at a time anyway.
   */
  readonly pipelineReads?: boolean;
  /** What server timing calls this database (serverTiming.ts): `app` unless a replica's manager says otherwise. */
  readonly timingLabel?: string;
}

/* Server timing (telemetry/serverTiming.ts) is loaded with the first pool, not with this module: a print-and-exit
   flag reaches this file through the settings it reads and never opens a pool (test/cli-startup.test.ts counts what
   it loads). Every lease comes from a pool, so a lease always finds it loaded. */
let timing: typeof ServerTiming | undefined;

/** What no one chose: an App (keyed writes) reads as widely as it writes, never fewer, because writes without
 * readers to match only moved the queue to the reads; the database browser keeps four. */
function defaultReaders(writers: number): number {
  return writeOrder() === 'keyed' ? Math.min(MAX_READERS, Math.max(balancedPoolSize(), writers)) : DEFAULT_READERS;
}

/**
 * The defaults every manager in this process takes when it names none: the
 * command line's `--read-pool` and `--pooler`. Server-wide on purpose
 * (serverSettings.ts): besides the registry's adapters, tenant sources, the
 * job host and startup checks open pools of their own on the same databases,
 * and a transaction-mode pooler in front of one of them has to be honored by
 * every one; a per-connection switch would reach only some. Called once, at
 * startup; whatever it leaves unsaid returns to the built-in default. The
 * reader count stays unset until a manager is made: the write order, which
 * says whether this is an App, is configured after the flags are read.
 */
export function configurePostgresPools(options: { readers?: number; pooler?: PoolerMode }): void {
  const readers = options.readers;
  if (readers !== undefined && !isReaderCount(readers))
    throw new RangeError(`A PostgreSQL read pool holds 1 to ${MAX_READERS} connections; ${String(readers)} is not one of them.`);
  const pooler = options.pooler ?? 'session';
  if (pooler !== 'session' && pooler !== 'transaction') throw new RangeError('The pooler is "session" or "transaction".');
  configureServerSettings({ readers, pooler });
}

/** The defaults, as this server's settings leave them. */
export function postgresPoolDefaults(): Readonly<{
  readers: number;
  pooler: PoolerMode;
}> {
  const settings = serverSettings();
  return {
    readers: settings.readers ?? defaultReaders(writerPoolSize()),
    pooler: settings.pooler,
  };
}

/** The pools a manager opens itself; a replica's readers are another manager's. */
type OwnRole = Exclude<PoolRole, 'replica'>;

/** Separate bounded pools keep browsing read-only and transactions on one lease. */
export class PgConnectionManager {
  private reader?: Promise<PgPool>;
  private writer?: Promise<PgPool>;
  private background?: Promise<PgPool>;
  /** The pools once they exist, for the meters' physical counts. */
  private readonly opened: Partial<Record<OwnRole, PgPool>> = {};
  private closed = false;
  private closing?: Promise<void>;
  /** What sits between this process and the server, for every lease of this manager. */
  readonly pooler: PoolerMode;
  private readonly capMs: number;
  private readonly lockMs: number;
  private readonly queueWaitMs: number;
  private readonly queuePerConnection: number;
  private readonly meters: Readonly<Record<OwnRole, PoolMeter>>;
  /* One object, so every caller of read() holds the same handle, as when the handle was the pool itself. */
  private readonly reads: PgQuery;
  /** This database's replicas, each a manager of its own whose writers are never opened. */
  private readonly replicas?: ReplicaSet<PgConnectionManager>;
  private readonly network?: NetworkPolicy;
  private readonly pipelineReads: boolean;
  private readonly timingLabel: string;

  constructor(
    private readonly connectionString: string,
    private readonly onLoad: (pg: unknown) => void = () => {},
    private readonly load: PgPoolLoader = loadPg,
    options: PgConnectionOptions = {},
  ) {
    /* Where writes run one at a time a second writer would sit idle: the
       pool is one, whatever the connection asked for. */
    const writers = writeOrder() === 'serial' ? 1 : (options.writers ?? writerPoolSize());
    const readers = options.readers ?? serverSettings().readers ?? defaultReaders(writers);
    if (!isReaderCount(readers))
      throw new RangeError(`A PostgreSQL read pool holds 1 to ${MAX_READERS} connections; ${String(readers)} is not one of them.`);
    if (!isWriterCount(writers))
      throw new RangeError(`A PostgreSQL write pool holds 1 to ${MAX_WRITERS} connections; ${String(writers)} is not one of them.`);
    this.pooler = options.pooler ?? serverSettings().pooler;
    this.network = options.network;
    this.pipelineReads = options.pipelineReads === true;
    this.timingLabel = options.timingLabel ?? 'app';
    this.capMs = options.capMs ?? STATEMENT_TIMEOUT_MS;
    this.queueWaitMs = options.queueWaitMs ?? POOL_QUEUE_WAIT_MS;
    this.queuePerConnection = options.queuePerConnection ?? POOL_QUEUE_PER_CONNECTION;
    this.lockMs = Math.min(options.lockTimeoutMs ?? lockTimeoutMs(), this.capMs);
    this.meters = Object.freeze({
      read: new PoolMeter('read', readers),
      write: new PoolMeter('write', writers),
      background: new PoolMeter('background', 1),
    });
    const replicas = options.replicas ?? [];
    if (replicas.length > MAX_REPLICAS)
      throw new RangeError(`A connection names at most ${MAX_REPLICAS} replicas; this one names ${replicas.length}.`);
    /* Sized as this manager's readers are, the same pooler, cap and queue
       bounds: a replica is where this pool's reads go, so it must hold them. */
    if (replicas.length)
      this.replicas = new ReplicaSet(
        replicas.map(
          (url) =>
            new PgConnectionManager(url, onLoad, load, {
              ...options,
              readers,
              writers,
              replicas: undefined,
              timingLabel: 'app-replica',
            }),
        ),
      );
    const run = (client: PgQuery, text: unknown, params?: unknown) =>
      (client.query as (text: unknown, params?: unknown) => Promise<unknown>)(text, params);
    const statement = (text: unknown, params?: unknown) => {
      const primary = () => this.withClient(false, (client) => run(client, text, params), false);
      return this.replicas
        ? this.replicas.read((replica) => replica.withReadClient((client) => run(client, text, params)), primary)
        : primary();
    };
    this.reads = { query: statement as PgQuery['query'] };
  }

  /**
   * A handle for single statements on the reader pool. Each statement leases
   * a client of its own for exactly its length, which is what `pool.query`
   * did — so the checkout is metered, a cancel knows which client to stop,
   * and behind a transaction-mode pooler the statement runs inside a
   * read-only transaction of its own.
   */
  async read(): Promise<PgQuery> {
    await this.pool('read');
    return this.reads;
  }

  /** Native snapshot owners opt into callback drain after cancellation. A
   * callback must settle after its driver operations are destroyed; arbitrary
   * never-settling application work cannot offer a bounded drain guarantee. */
  async withReadClient<T>(run: (client: PgQuery) => Promise<T>, destroyAfter = false, drainCancelled = false): Promise<T> {
    return this.withClient(false, run, destroyAfter, drainCancelled);
  }

  /** Private native snapshot seam: guard observes this exact checkout, not
   * instantaneous remote-server health. Ordinary read/write behavior is unchanged. */
  async withObservedReadClient<T>(run: (client: PgQuery, current: () => void) => Promise<T>): Promise<T> {
    return this.withClient(
      false,
      (client, current) => {
        if (!current) throw new Error('Observed PostgreSQL checkout is unavailable.');
        return run(client, current);
      },
      false,
      true,
      true,
    );
  }

  /** A writer for one transaction: from the writer pool, or inside background work (asBackgroundWork) the background writer. */
  async withWriteClient<T>(run: (client: PgQuery) => Promise<T>, destroyAfter = false): Promise<T> {
    return this.withClient(true, run, destroyAfter);
  }

  /** The meters of the pools opened so far, readers first, then each replica's readers. Readable after close. */
  stats(): readonly PoolRoleStats[] {
    const own = (['read', 'write', 'background'] as const).flatMap((role) => {
      const pool = this.opened[role];
      if (!pool) return [];
      const total = (pool as { totalCount?: unknown }).totalCount;
      return [this.meters[role].stats(this.pooler, typeof total === 'number' ? total : null)];
    });
    const replicas = (this.replicas?.pools ?? []).flatMap((replica, index) =>
      replica.stats().map((stats): PoolRoleStats => ({
        ...stats,
        role: 'replica',
        replica: index + 1,
      })),
    );
    return [...own, ...replicas];
  }

  /**
   * `work` on each replica in use now, its failures left out: what live sync
   * asks of every healthy replica before it tells readers of a change, so a
   * refetch it sets off reads a replica that has the change (server/live).
   */
  async onHealthyReplicas<T>(work: (client: PgQuery) => Promise<T>): Promise<T[]> {
    const set = this.replicas;
    if (!set) return [];
    const answers = await Promise.allSettled(
      set.pools.map((replica, index) => (set.healthy(index) ? replica.withReadClient(work) : Promise.reject(new Error('passed over')))),
    );
    return answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []));
  }

  /** Each replica: whether it is in use now, and how many reads it answered and handed back to the primary. */
  replicaHealth(): ReadonlyArray<{
    replica: number;
    healthy: boolean;
    served: number;
    fellBack: number;
  }> {
    const set = this.replicas;
    return set
      ? set.pools.map((_, index) => ({
          replica: index + 1,
          healthy: set.healthy(index),
          served: set.served[index],
          fellBack: set.fellBack[index],
        }))
      : [];
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= Promise.all([this.endPools(), ...(this.replicas?.pools ?? []).map((replica) => replica.close())]).then(() => {});
    return this.closing;
  }

  /* What pg is told about where to connect: the URL, or for an untrusted
     address every part spelled out so nothing comes from this process. */
  private dialOptions(): Partial<ReturnType<typeof pgConnectionOptions>> {
    return this.network
      ? (sealedPgOptions(this.connectionString, this.network) as Partial<ReturnType<typeof pgConnectionOptions>>)
      : pgConnectionOptions(this.connectionString);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Postgres connection manager is closed.');
  }

  private async pool(role: OwnRole): Promise<PgPool> {
    this.assertOpen();
    const pending =
      role === 'write'
        ? (this.writer ??= this.createPool('write'))
        : role === 'background'
          ? (this.background ??= this.createPool('background'))
          : (this.reader ??= this.createPool('read'));
    const pool = await pending;
    this.assertOpen();
    return pool;
  }

  private async createPool(role: OwnRole): Promise<PgPool> {
    const pg = await this.load();
    timing ??= await import('./telemetry/serverTiming.js');
    this.assertOpen();
    this.onLoad(pg);
    const module = pg as {
      Pool?: new (options: PgPoolOptions) => PgPool;
      default?: { Pool?: new (options: PgPoolOptions) => PgPool };
    };
    const Pool = module.Pool ?? module.default?.Pool;
    if (!Pool) throw new Error('Could not find a Pool export in the "pg" package.');
    const write = role !== 'read';
    const session = this.pooler === 'session';
    const pool = new Pool({
      ...this.dialOptions(),
      max: this.meters[role].size,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      /* Readers only: a writer is opened for a write and may go. The idle
         ones never keep the process alive by themselves, so a one-shot mode
         that forgets to close still exits. */
      ...(write
        ? {}
        : {
            min: Math.min(WARM_READERS, this.meters[role].size),
            allowExitOnIdle: true,
          }),
      /* A writer sends each statement as it is asked, not after the one
         before it is answered: a transaction that asks several at once
         (pipelined, postgresTransactionHandle.ts) pays one round trip for
         them. One asked at a time is sent and answered exactly as before.
         A reader only where its owner asked (pipelineReads). */
      ...(write || this.pipelineReads ? { pipeline: true } : {}),
      /* pg awaits this hook for every physical client before its first
         checkout. Behind a transaction-mode pooler a session setting would
         land on whichever server connection the client holds at that moment
         and stay there for the pooler's next client, so nothing is set; each
         lease sets its own, per transaction. */
      onConnect: async (client) => {
        /* A leased client's 'error' is its own to hear: the pool listens only
           while it is idle, and a backend ended under a lease (a failover, a
           pg_terminate_backend) would otherwise end the process. The query it
           was running rejects with the same failure, which is where it is
           answered. */
        (client as PgClient).on?.('error', () => {});
        if (!session) return;
        if (!write) await client.query('SET default_transaction_read_only = on');
        /* A writer also stops waiting for a lock after lockMs: a row held by
           another transaction (another pod, a migration's DDL) fails the
           statement fast, with 55P03, rather than holding this connection —
           and the save behind it — for the whole statement cap. One message:
           the settings are two statements and one round trip. */
        await client.query(
          write
            ? `SET statement_timeout = '${this.capMs / 1000}s'; SET lock_timeout = '${this.lockMs}ms'`
            : `SET statement_timeout = '${this.capMs / 1000}s'`,
        );
      },
    });
    // pg removes failed idle clients itself; an unhandled pool error would crash Node.
    pool.on('error', () => {});
    this.opened[role] = pool;
    /* In use and waiting, for the process entry of server timing (a no-op when it is off). pg-pool's own counters. */
    const counts = pool as unknown as {
      totalCount?: number;
      idleCount?: number;
      waitingCount?: number;
    };
    if (timing.serverTimingOn()) {
      timing.registerGauge(`pool-${role}-use`, () => (counts.totalCount ?? 0) - (counts.idleCount ?? 0));
      timing.registerGauge(`pool-${role}-wait`, () => counts.waitingCount ?? 0);
    }
    /* With server timing on, the round trip from here to this database, once, on a connection of its own: a
       driver without a Client (a test's) is not measured. */
    if (!write)
      void timing.probeRoundTrips(this.timingLabel, () => {
        const found = pg as {
          Client?: PgClientClass;
          default?: { Client?: PgClientClass };
        };
        const Client = found.Client ?? found.default?.Client;
        return Client && new Client({ ...this.dialOptions(), connectionTimeoutMillis: 10_000 });
      });
    return pool;
  }

  /* `write` stays a boolean: test/support/tenantDialects.ts intercepts every
     lease here, by that flag, to fault a writer's COMMIT and nothing else. */
  private async withClient<T>(
    write: boolean,
    run: (client: PgQuery, current?: () => void) => Promise<T>,
    destroyAfter: boolean,
    drainCancelled = false,
    observeCheckout = false,
  ): Promise<T> {
    const role: OwnRole = !write ? 'read' : inBackgroundWork() ? 'background' : 'write';
    /* Only reads are stopped on cancel: a write that has started runs to its
       end, so its outcome is known rather than guessed. */
    const signal = write ? undefined : cancellation();
    throwIfCancelled(signal);
    const pool = await this.pool(role);
    /* A write that finds every writer busy says so on the request's trace
       (the dev observer): the wait for a connection, beside the wait in its
       lane (writeLanes.ts) and the statements that follow. */
    const waiting =
      write && this.meters[role].full()
        ? startSpan('writer wait', {
            childOnly: true,
            attributes: { 'db.client.connection.pool.name': role },
          })
        : undefined;
    const meter = this.meters[role];
    /* The background writer is one connection that jobs wait for by design;
       a person's read or write is answered, not held. */
    const bounded = role !== 'background';
    if (bounded && meter.waiting() >= meter.size * this.queuePerConnection) {
      meter.refuse();
      throw new PoolBusy(write ? 'write' : 'read', 'queue_full');
    }
    const checkout = meter.begin();
    const had = timing?.poolWait(`${this.timingLabel}-${role}`);
    let client: PgClient;
    try {
      client = await (bounded ? this.connectWithin(pool, write ? 'write' : 'read') : pool.connect());
      had?.();
    } catch (error) {
      had?.();
      if (error instanceof PoolBusy) {
        checkout.failed(true);
        waiting?.fail('pool_busy');
        waiting?.end();
        throw error;
      }
      checkout.failed(ACQUISITION_TIMEOUT.test(error instanceof Error ? error.message : ''));
      waiting?.fail('pool_timeout');
      waiting?.end();
      throw error;
    }
    waiting?.end();
    timing?.timeClient(client, this.timingLabel);
    const giveBack = checkout.acquired();
    const scoped =
      this.pooler === 'transaction'
        ? transactionScoped(client, {
            role: write ? 'write' : 'read',
            capMs: this.capMs,
            untrusted: destroyAfter,
            ...(write ? { lockTimeoutMs: this.lockMs } : {}),
            /* A writer's client pipelines (below): a statement it sends outside
               a transaction leaves with its BEGIN and COMMIT, in one round trip. */
            pipelines: (client as { pipeline?: unknown }).pipeline === true,
          })
        : undefined;
    let destroy = destroyAfter;
    /* A cancelled client never goes back to the pool: the cancel travels on
       another connection and can land late, and it must not land on a
       statement a later lease of the same backend has started. */
    let cancelled = false;
    let released = false;
    let invalidateHealth = () => {},
      removeHealthListeners = () => {};
    const release = (destroyed: boolean) => {
      if (released) return;
      released = true;
      invalidateHealth();
      client.release(destroyed);
    };
    /* Behind a transaction-mode pooler the backend id a client was told is
       the pooler's, not the server's, so a pg_cancel_backend by it would
       stop whatever unrelated statement holds that id on the server. The
       ordinary caller stops waiting at once instead; snapshot owners destroy
       the client first and then drain their callback. Server work remains
       bounded by the transaction's cap, not by local callback completion. */
    let stop: ((error: Error) => void) | undefined;
    const stopped =
      scoped && signal && !drainCancelled
        ? new Promise<never>((_, reject) => {
            stop = reject;
          })
        : undefined;
    void stopped?.catch(() => {});
    const disarm = onCancel(signal, () => {
      cancelled = true;
      invalidateHealth();
      if (scoped) {
        const reason = new StatementStopped('cancelled');
        if (drainCancelled) {
          // Invalidate continuations first, then break active driver I/O before
          // awaiting callback/finally drain. This drains local promises, not
          // server locks: server work may persist until its configured cap.
          // Never cancel a pooler's backend ID.
          scoped.close(reason);
          // A release exception must not escape the AbortSignal listener. The
          // operation remains cancelled, and still waits for its callback.
          try {
            release(true);
          } catch {
            /* No retry of a possibly released client. */
          }
        } else stop?.(reason);
      } else void this.cancel(client.processID);
    });
    try {
      this.assertOpen();
      throwIfCancelled(signal);
      let borrowed: PgQuery = scoped ?? client;
      let health: (() => void) | undefined;
      if (observeCheckout) {
        if (typeof client.on !== 'function' || typeof client.off !== 'function')
          throw new Error('Observed PostgreSQL checkout is unavailable.');
        let healthy = true;
        const on = client.on.bind(client),
          off = client.off.bind(client);
        invalidateHealth = () => {
          healthy = false;
        };
        removeHealthListeners = () => {
          off('error', invalidateHealth);
          off('end', invalidateHealth);
        };
        on('error', invalidateHealth);
        on('end', invalidateHealth);
        health = () => {
          this.assertOpen();
          throwIfCancelled(signal);
          if (!healthy || released) throw new Error('Observed PostgreSQL checkout is unavailable.');
        };
        const current = health,
          target = borrowed;
        function query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
        function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
        async function query(text: string | { text: string; values?: unknown[]; rowMode?: string }, params?: unknown[]) {
          try {
            current();
            const result = typeof text === 'string' ? await target.query(text, params) : await target.query(text);
            current();
            return result;
          } catch (error) {
            invalidateHealth();
            throw error;
          }
        }
        borrowed = Object.freeze({ query });
      }
      /* A write's own reads — the pre-flight count, a reread — are of the
         primary it writes. */
      const lent = borrowed;
      /* A lease that runs statements it does not control (destroyAfter: the
         SQL tool's) brackets each in a savepoint it awaits first
         (postgresPooler.ts), so one sent behind another would overtake it:
         that lease asks one at a time. */
      if ((client as { pipeline?: unknown }).pipeline === true && !destroyAfter) pipelining.add(lent);
      const running = write ? primaryReads(() => run(lent, health)) : run(borrowed, health);
      if (stopped) void running.catch(() => {});
      const out = await (stopped ? Promise.race([running, stopped]) : running);
      health?.();
      await scoped?.settle();
      health?.();
      if (drainCancelled) throwIfCancelled(signal);
      return out;
    } catch (error) {
      destroy = true;
      if (scoped && !cancelled) await scoped.settle().catch(() => {});
      if (cancelled) throw error instanceof StatementStopped ? error : new StatementStopped('cancelled', undefined, { cause: error });
      throw error;
    } finally {
      /* The person who wrote reads the primary for a while after, so the
         list they go back to shows what they saved (replicas.ts). Noted
         however the write ended: a failed one may still have committed. */
      if (write) noteWrite();
      disarm();
      try {
        release(destroy || cancelled);
      } finally {
        try {
          removeHealthListeners();
        } finally {
          giveBack();
        }
      }
    }
  }

  /**
   * A connection, or PoolBusy once the queue-wait budget is spent. The driver
   * cannot withdraw a request it has queued, so one that arrives late is given
   * straight back to the pool rather than leaked.
   */
  private connectWithin(pool: PgPool, role: 'read' | 'write'): Promise<PgClient> {
    const connecting = pool.connect();
    return new Promise<PgClient>((resolve, reject) => {
      let over = false;
      const timer = setTimeout(() => {
        over = true;
        reject(new PoolBusy(role, 'queue_timeout'));
      }, this.queueWaitMs);
      connecting.then(
        (client) => {
          clearTimeout(timer);
          if (over) client.release();
          else resolve(client);
        },
        (error) => {
          clearTimeout(timer);
          if (!over) reject(error);
        },
      );
    });
  }

  /**
   * Stop what backend `pid` is running, with pg_cancel_backend from a
   * connection of its own: the pool's may all be busy, one of them with the
   * statement being stopped. Best effort — a cancel that cannot connect
   * leaves the statement to its cap.
   */
  private async cancel(pid: number | null | undefined): Promise<void> {
    if (!pid) return;
    try {
      const pg = (await this.load()) as {
        Client?: PgClientClass;
        default?: { Client?: PgClientClass };
      };
      const Client = pg.Client ?? pg.default?.Client;
      if (!Client) return;
      const client = new Client({
        ...this.dialOptions(),
        connectionTimeoutMillis: 10_000,
      });
      client.on('error', () => {});
      await client.connect();
      try {
        await client.query('SELECT pg_cancel_backend($1)', [pid]);
      } finally {
        await client.end().catch(() => {});
      }
    } catch {
      /* The statement's cap still stops it. */
    }
  }

  private async endPools(): Promise<void> {
    const opened = await Promise.allSettled([this.reader, this.writer, this.background]);
    const ended = await Promise.allSettled(opened.map((result) => (result.status === 'fulfilled' ? result.value?.end() : undefined)));
    const failed = ended.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

/** What a runtime store leases for each of its transactions: one writer
 * client, returned (or destroyed, on failure) before the call resolves. */
export type PgWriteClientSource = Pick<PgConnectionManager, 'withWriteClient'>;
