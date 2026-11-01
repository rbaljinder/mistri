/**
 * Live sync's hub: one per database adapter in this process, reading its
 * change store once per wake and handing each row to every subscriber on
 * it, filtered per subscriber (liveFilter.ts).
 *
 * It wakes on any of three things: PostgreSQL's NOTIFY, heard on one LISTEN
 * connection (the connection's `listen` URL behind a transaction pooler,
 * else its own), which carries every process's commits; the in-process
 * nudge a commit here sends on every engine; and a poll where neither
 * reaches — SQLite's `data_version` every 500 ms, which
 * is what hears another process on the same file, and the change
 * table every second on PostgreSQL where no LISTEN can be held.
 *
 * Its passes are serial. A new subscriber joins inside a pass: placed at the
 * hub's position, or caught up from its own cursor to it, so no row is told
 * twice or skipped between the replay and the live read that follows. Each
 * subscriber keeps its own position, so one that is ahead (its cursor came
 * from another process) is told nothing it already heard.
 *
 * Where the connection names replicas, a pass that read changes waits, at
 * most 1.5 s, for every healthy replica to have replayed past the primary's
 * position read first, so the refetch a change sets off reads a replica that
 * has it; past that the change is marked `primary`, and the client asks the
 * primary for it (readRouting.ts's fresh marker). The position never leaves.
 *
 * The hub prunes its store once a minute, subscribers or not, keeping fifteen
 * minutes; on PostgreSQL one process prunes, under an advisory lock.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { storeHostOf } from '@mistriwork/engine/adapters/storeHost.js';
import { untimed } from '@mistriwork/engine/adapters/telemetry/serverTiming.js';
import { LIVE_CHANGE_LIMITS, LIVE_CHANGE_PAGE, LIVE_CHANNEL, onLiveChanges } from '../../adapters/live/liveChange.js';
import { listenForWake, type CommandEventListener } from '../../adapters/events/postgresCommandEventWake.js';
import { deliverChange, emptyDelivery, type LiveAuthority, type LiveDelivery, type ProbeMemo } from './liveFilter.js';
import { livePast, liveStoreOf, type LivePosition, type LiveStore } from './liveStore.js';

/** One subscriber's attachment to one database. */
export interface LiveTap {
  /** The cursor it asked to resume from on this database; undefined to start at the head. */
  readonly cursor?: string;
  /** Its authority, re-resolved when stale; a throw ends the subscriber. */
  authority(): Promise<LiveAuthority>;
  /** What it is told: a delivery as of `position`. A replay's delivery may ask for a reset (`unkeyed`). */
  receive(delivery: LiveDelivery, position: LivePosition, replay: boolean, primary: boolean): void;
  /** Where it was placed on joining: the position its cursor stands at until it is told more. */
  placed(position: LivePosition): void;
  /** Its cursor is gone (pruned, lost in a crash, never this store's): it starts again at `position`. */
  reset(position: LivePosition): void;
  /** The hub cannot read this database any more: the subscriber ends, and reconnects with its cursor. */
  fail(): void;
}

interface Attached {
  readonly tap: LiveTap;
  at?: LivePosition;
  joined?: () => void;
}

interface LiveHubOptions {
  /** The PostgreSQL URL to hold LISTEN on, or undefined to poll. */
  readonly listen?: string;
  readonly now?: () => number;
  /** Test seams. */
  readonly pollMs?: number;
  readonly replicaWaitMs?: number;
}

/** A replay longer than this resets the subscriber: one full refresh is cheaper than telling it each change. */
const LIVE_REPLAY_ROWS = 5_000;
const WAKE_COALESCE_MS = 50;
const PRUNE_MS = 60_000;
const REPLICA_WAIT_MS = 1_500;
/** How soon a pass looks again for rows committed but not yet readable in order, doubling to the most. */
const UNSETTLED_MS = 100;
const UNSETTLED_MOST_MS = 2_000;
/** How often one kind of fault is written to the log, at most. */
const FAULT_LOG_MS = 60_000;

/*
 * Live sync is a convenience over a server that must stay up: no fault in it — a store that throws, a listener that
 * will not close, a subscriber whose callback throws — may reach the process as an uncaught exception or an
 * unhandled rejection, which ends it. Every timer, poll and listener callback here runs through `guard`, and every
 * promise left to run on its own ends in `logged`. A fault is written once a minute per kind, so a poll that fails
 * every half second does not fill the log.
 */
const faultLogged = new Map<string, number>();
function liveFault(where: string, error: unknown): void {
  const now = Date.now();
  if (now - (faultLogged.get(where) ?? -Infinity) < FAULT_LOG_MS) return;
  faultLogged.set(where, now);
  console.error(`mistri: live sync: ${where}: ${error instanceof Error ? error.message : String(error)}`);
}
/** Run a callback nothing above it will catch; a throw or a rejection is logged, never raised. */
export function guard(where: string, run: () => unknown): void {
  try {
    const result = run();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function')
      void Promise.resolve(result).catch((error: unknown) => liveFault(where, error));
  } catch (error) {
    liveFault(where, error);
  }
}

export class LiveHub {
  private readonly attached = new Set<Attached>();
  private readonly joining: Attached[] = [];
  private position?: LivePosition;
  /** Moves at each stop: a pass begun before it reads nothing after it (`pass`). */
  private run = 0;
  private passing: Promise<void> = Promise.resolve();
  private scheduled?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private pruner?: ReturnType<typeof setInterval>;
  private listener?: Promise<CommandEventListener | undefined>;
  private unnudge?: () => void;
  private unsettledMs = UNSETTLED_MS;
  private closed = false;
  private readonly now: () => number;
  /** Passes that read rows and probes run, for tests and the operator surface. */
  readonly counters = { passes: 0, rows: 0, probes: 0 };

  constructor(
    readonly adapter: Adapter,
    private readonly store: LiveStore,
    private readonly options: LiveHubOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    /* Made inside whichever request first subscribed: its timers are the process's, not that request's. */
    this.pruner = untimed(() => setInterval(() => guard('prune', () => this.prune()), PRUNE_MS));
    this.pruner.unref?.();
  }

  get subscribers(): number {
    return this.attached.size;
  }

  /** Whether its wake runs (LISTEN, the nudge, the poll): from the first subscriber to the last. */
  get waking(): boolean {
    return this.unnudge !== undefined;
  }

  /** Attach a subscriber; resolves once it is placed (and caught up), so its `hello` follows its replay. */
  attach(tap: LiveTap): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Live sync has stopped.'));
    const entry: Attached = { tap };
    const joined = new Promise<void>((resolve) => (entry.joined = resolve));
    this.attached.add(entry);
    this.joining.push(entry);
    this.start();
    this.wake(0);
    return joined;
  }

  detach(tap: LiveTap): void {
    for (const entry of this.attached)
      if (entry.tap === tap) {
        this.attached.delete(entry);
        /* A subscriber that leaves before its pass is not joined, but its attach settles: whoever awaits it (a
           choice cache's listening promise) must not wait for a pass that will skip it. */
        entry.joined?.();
        entry.joined = undefined;
      }
    if (!this.attached.size) this.stop();
  }

  /** Something may have committed: read the store soon. */
  wake(delay = WAKE_COALESCE_MS): void {
    if (this.closed || !this.attached.size) return;
    if (this.scheduled) return;
    /* The pass is the process's work, though a save's commit or a subscriber's request usually wakes it: begun
       inside that request it was timed as part of it, its store read, authorities and probes counted as the save's
       round trips and database time whenever the save was still answering when the pass ran. */
    this.scheduled = untimed(() =>
      setTimeout(
        () =>
          guard('wake', () => {
            this.scheduled = undefined;
            this.passing = this.passing
              .then(() => this.pass())
              .catch((error: unknown) => {
                liveFault('read', error);
                this.failAll();
              })
              .catch((error: unknown) => liveFault('read', error));
          }),
        delay,
      ),
    );
    this.scheduled.unref?.();
  }

  /** Stop for good: its adapter is closing. Each subscriber still attached ends, and reconnects to the adapter that replaces it. */
  async close(): Promise<void> {
    this.closed = true;
    const attached = [...this.attached];
    this.attached.clear();
    this.joining.length = 0;
    for (const entry of attached) {
      entry.joined?.();
      guard('subscriber', () => entry.tap.fail());
    }
    this.stop();
    if (this.pruner) clearInterval(this.pruner);
    this.pruner = undefined;
    await this.passing.catch(() => {});
  }

  /** One prune, now (the minute's timer calls it). */
  async prune(): Promise<number> {
    try {
      return await this.store.prune(this.now() - LIVE_CHANGE_LIMITS.retentionMs);
    } catch (error) {
      liveFault('prune', error);
      return 0;
    }
  }

  private start(): void {
    if (this.unnudge) return;
    this.unnudge = onLiveChanges(() => guard('nudge', () => this.wake()));
    const listen = this.store.dialect === 'postgres' ? this.options.listen : undefined;
    if (listen) {
      this.listener = listenForWake(listen, LIVE_CHANNEL, () => guard('notify', () => this.wake())).then(
        (listener) => {
          /* A subscriber is placed before LISTEN is in place, so a commit announced in between was heard by no one
             (CI's slower connect lost the first one): look once, as a reconnect does. */
          if (this.unnudge) {
            this.wake(0);
            return listener;
          }
          guard('listen', () => listener.close());
          return undefined;
        },
        () => {
          /* No LISTEN: poll the table instead, as behind a transaction pooler. */
          guard('poll', () => this.polling(this.options.pollMs ?? 1_000, false));
          return undefined;
        },
      );
    } else this.polling(this.options.pollMs ?? (this.store.dialect === 'postgres' ? 1_000 : 500), this.store.dialect !== 'postgres');
  }

  private polling(ms: number, cheap: boolean): void {
    if (this.poll || !this.unnudge) return;
    this.poll = untimed(() =>
      setInterval(
        () =>
          guard('poll', async () => {
            if (!cheap || !this.store.moved) return this.wake(0);
            let moved = true;
            try {
              moved = await this.store.moved();
            } catch (error) {
              liveFault('poll', error);
            }
            if (moved) this.wake(0);
          }),
        ms,
      ),
    );
    this.poll.unref?.();
  }

  private stop(): void {
    this.unnudge?.();
    this.unnudge = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = undefined;
    const listener = this.listener;
    this.listener = undefined;
    if (listener) guard('listen', async () => (await listener)?.close());
    /* With nobody listening the position goes stale; the next subscriber reads the head again. */
    this.position = undefined;
    /* And nobody is still joining: a subscriber that left before its pass would otherwise keep its stream, and
       what the stream holds, until the next one arrived. */
    for (const entry of this.joining) {
      entry.joined?.();
      entry.joined = undefined;
    }
    this.joining.length = 0;
    this.run += 1;
  }

  private failAll(): void {
    for (const entry of [...this.attached]) {
      this.attached.delete(entry);
      entry.joined?.();
      guard('subscriber', () => entry.tap.fail());
    }
    this.joining.length = 0;
    this.stop();
  }

  /* A pass awaits the store between its steps, and the last subscriber can
     leave in any of those waits: stop() clears the position, and a pass that
     went on read from `undefined` ("Cannot read properties of undefined
     (reading 'xact')") and, failing, ended every subscriber, the ones that
     joined in the meantime too. Under connection loss streams end and join
     constantly, so it was common. A pass therefore holds its position in a
     local and gives up once the hub has stopped since it began; the next
     subscriber's wake starts a pass of its own from the head. */
  private async pass(): Promise<void> {
    if (this.closed || !this.attached.size) return;
    const run = this.run;
    const stopped = () => this.closed || run !== this.run;
    const head = this.position ?? (await this.store.head());
    if (stopped()) return;
    let from = (this.position = head);
    for (let entry = this.joining.shift(); entry; entry = stopped() ? undefined : this.joining.shift()) {
      if (!this.attached.has(entry)) {
        entry.joined?.();
        entry.joined = undefined;
        continue;
      }
      try {
        await this.join(entry, from);
        if (entry.at) entry.tap.placed(entry.at);
      } catch (error) {
        liveFault('join', error);
        this.attached.delete(entry);
        guard('subscriber', () => entry.tap.fail());
      }
      entry.joined?.();
      entry.joined = undefined;
    }
    if (stopped()) return;
    for (;;) {
      const rows = await this.store.read(from, LIVE_CHANGE_PAGE);
      if (stopped()) return;
      if (!rows.length) break;
      this.counters.passes += 1;
      this.counters.rows += rows.length;
      const primary = await this.replicasBehind();
      if (stopped()) return;
      const memo: ProbeMemo = new Map();
      const live = [...this.attached].filter((entry) => entry.at);
      const authorities = new Map<Attached, LiveAuthority>();
      await Promise.all(
        live.map(async (entry) => {
          try {
            authorities.set(entry, await entry.tap.authority());
          } catch {
            /* Its stream has ended itself; it detaches. */
          }
        }),
      );
      const deliveries = new Map<Attached, LiveDelivery>();
      for (const { change, position } of rows) {
        for (const entry of live) {
          const authority = authorities.get(entry);
          if (!authority || !entry.at || !livePast(position, entry.at)) continue;
          let delivery = deliveries.get(entry);
          if (!delivery) deliveries.set(entry, (delivery = emptyDelivery()));
          await deliverChange(change, authority, delivery, this.counted(memo));
          entry.at = position;
        }
      }
      if (stopped()) return;
      from = this.position = rows[rows.length - 1].position;
      this.unsettledMs = UNSETTLED_MS;
      /* One subscriber's throw is its own end, not every other's. */
      for (const [entry, delivery] of deliveries)
        if (this.attached.has(entry))
          try {
            entry.tap.receive(delivery, entry.at!, false, primary);
          } catch (error) {
            liveFault('subscriber', error);
            this.attached.delete(entry);
            guard('subscriber', () => entry.tap.fail());
          }
      if (rows.length < LIVE_CHANGE_PAGE) break;
    }
    /* A row committed behind a transaction still open elsewhere was announced already, and that transaction's end
       announces nothing: look again until it can be read, backing off while it is held. */
    if (this.store.unsettled && (await this.store.unsettled(from))) {
      if (stopped()) return;
      this.wake(this.unsettledMs);
      this.unsettledMs = Math.min(this.unsettledMs * 2, UNSETTLED_MOST_MS);
    } else this.unsettledMs = UNSETTLED_MS;
  }

  /* Probes, counted as they are first asked: the memo shares one between subscribers of one scope. */
  private counted(memo: ProbeMemo): ProbeMemo {
    const counters = this.counters;
    return new Proxy(memo, {
      get(target, property) {
        if (property === 'set')
          return (key: string, value: Promise<ReadonlySet<string>>) => {
            counters.probes += 1;
            return target.set(key, value);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /* A subscriber placed at the head, or replayed from its cursor up to the hub's position. */
  private async join(entry: Attached, position: LivePosition): Promise<void> {
    const cursor = entry.tap.cursor;
    if (cursor === undefined) {
      entry.at = position;
      return;
    }
    const located = await this.store.locate(cursor);
    if (!located) {
      entry.at = position;
      entry.tap.reset(position);
      return;
    }
    if (!livePast(position, located)) {
      entry.at = located;
      return;
    }
    const authority = await entry.tap.authority();
    const delivery = emptyDelivery();
    const memo: ProbeMemo = new Map();
    let from = located,
      read = 0;
    for (;;) {
      const rows = (await this.store.read(from, LIVE_CHANGE_PAGE)).filter((row) => !livePast(row.position, position));
      if (!rows.length) break;
      read += rows.length;
      if (read > LIVE_REPLAY_ROWS) {
        entry.at = position;
        entry.tap.reset(position);
        return;
      }
      for (const { change } of rows) await deliverChange(change, authority, delivery, this.counted(memo));
      from = rows[rows.length - 1].position;
      if (!livePast(position, from)) break;
    }
    entry.at = position;
    if (delivery.unkeyed) entry.tap.reset(position);
    else if (delivery.tables.size) entry.tap.receive(delivery, position, true, false);
  }

  /* Whether a healthy replica is still behind the primary after the wait: then refetches go to the primary. */
  private async replicasBehind(): Promise<boolean> {
    const host = storeHostOf(this.adapter);
    if (host?.dialect !== 'postgres') return false;
    // With no replica to be behind, the primary's position is a question nobody asks: one round trip saved per pass.
    if (!host.hasReplicas()) return false;
    try {
      const lsn = await host.withReadClient(
        async (client) => (await client.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]?.lsn as string | undefined,
      );
      if (!lsn) return false;
      const deadline = this.now() + (this.options.replicaWaitMs ?? REPLICA_WAIT_MS);
      for (;;) {
        const caught = await host.onHealthyReplicas(
          async (client) =>
            (await client.query('SELECT coalesce(pg_last_wal_replay_lsn() >= $1::pg_lsn, true) AS caught', [lsn])).rows[0]?.caught === true,
        );
        if (caught.every(Boolean)) return false;
        if (this.now() >= deadline) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      return true;
    }
  }
}

const hubs = new WeakMap<object, LiveHub>();

/** The hub of an adapter whose change store attests, made on first ask; undefined where it keeps no store. */
export async function liveHubOf(adapter: Adapter, options: LiveHubOptions = {}): Promise<LiveHub | undefined> {
  const known = hubs.get(adapter);
  if (known) return known;
  const store = liveStoreOf(adapter);
  if (!store || !(await store.ready().catch(() => false))) return undefined;
  const raced = hubs.get(adapter);
  if (raced) return raced;
  const hub = new LiveHub(adapter, store, options);
  hubs.set(adapter, hub);
  return hub;
}

/** The hub already made for an adapter, without making one: for the operator surface and tests. */
export const madeLiveHub = (adapter: object): LiveHub | undefined => hubs.get(adapter);

/** Forget an adapter's hub (its adapter closed), stopping it. */
export async function dropLiveHub(adapter: object): Promise<void> {
  const hub = hubs.get(adapter);
  hubs.delete(adapter);
  await hub?.close();
}
