/**
 * Live sync's change store, read the same way on every engine: where the
 * newest settled row is, the rows after a position, whether a subscriber's
 * cursor is still inside what is kept, and the minute's prune.
 *
 * A position orders rows as they committed. On SQLite that is the id, since
 * one file commits one transaction at a time. On PostgreSQL it is the
 * transaction id and then the row id, read only below the snapshot horizon
 * (adapters/live/postgresLiveChange.ts), so a lower id that commits late is
 * still ahead of every position. MySQL has neither: its rows are read by id,
 * and an id missing from the run is waited for a few seconds (a transaction
 * that took it may still commit) before the reader moves past it.
 *
 * A cursor, the thing a client holds, is a row id and nothing else; its
 * position is looked up again, so a client never carries a transaction id.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { storeHostOf } from '@mistriwork/engine/adapters/storeHost.js';
import type { StoredLiveChange } from '../../adapters/live/liveChange.js';
import {
  POSTGRES_LIVE_START,
  locatePostgresLiveCursor,
  postgresLiveChangeReady,
  postgresLiveHead,
  postgresLiveUnsettled,
  prunePostgresLiveChanges,
  readPostgresLiveChanges,
} from '../../adapters/live/postgresLiveChange.js';
import {
  pruneSqliteLiveChanges,
  readSqliteLiveChanges,
  sqliteLiveChangeReady,
  sqliteLiveHead,
  sqliteLiveKept,
} from '../../adapters/live/sqliteLiveChange.js';
import {
  mysqlLiveChangeReady,
  mysqlLiveHead,
  mysqlLiveKept,
  pruneMysqlLiveChanges,
  readMysqlLiveChanges,
} from '../../adapters/live/mysqlLiveChange.js';

/** Where a reader stands in commit order. `xact` only on PostgreSQL. */
export interface LivePosition {
  readonly id: string;
  readonly xact?: string;
}

/** Whether `a` is past `b` in commit order. */
export function livePast(a: LivePosition, b: LivePosition): boolean {
  if (a.xact !== undefined && b.xact !== undefined) {
    const ax = BigInt(a.xact),
      bx = BigInt(b.xact);
    if (ax !== bx) return ax > bx;
  }
  return BigInt(a.id) > BigInt(b.id);
}

interface LiveRead {
  readonly change: StoredLiveChange;
  readonly position: LivePosition;
}

/** One database's change store, as the hub reads it. */
export interface LiveStore {
  readonly dialect: 'sqlite' | 'postgres' | 'mysql';
  /** Whether the store stands attested: until it does, live sync is off on this database. */
  ready(): Promise<boolean>;
  /** The newest settled position: a new subscriber starts there. */
  head(): Promise<LivePosition>;
  /** Settled rows past `from`, oldest first. */
  read(from: LivePosition, limit: number): Promise<LiveRead[]>;
  /** A cursor's position, or undefined when its row is pruned, lost or never was: the subscriber is reset. */
  locate(cursor: string): Promise<LivePosition | undefined>;
  /** Rows older than `before` (ms), the newest always kept. */
  prune(before: number): Promise<number>;
  /** A cheap look for a commit on the database since the last look (SQLite's data_version, MySQL's newest id). */
  moved?(): Promise<boolean>;
  /**
   * Whether a row past `from` has committed but cannot be read in order yet
   * (PostgreSQL: an older transaction holds the horizon; MySQL: an id before
   * it is still being waited for). Nothing will announce when it can: the
   * hub reads again on its own while this says yes.
   */
  unsettled?(from: LivePosition): Promise<boolean>;
}

/** How long a MySQL reader waits for an id missing from the run before moving past it. */
const MYSQL_GAP_MS = 3_000;

const nonNegative = (cursor: string) => /^(0|[1-9][0-9]{0,18})$/.test(cursor);

/** The change store behind an adapter, or undefined where the adapter keeps no stores (an HTTP source). */
export function liveStoreOf(adapter: Adapter, now: () => number = Date.now): LiveStore | undefined {
  const host = storeHostOf(adapter);
  if (!host) return undefined;
  switch (host.dialect) {
    case 'sqlite': {
      let version: number | undefined;
      return {
        dialect: 'sqlite',
        ready: async () => sqliteLiveChangeReady(host.reader()),
        head: async () => Object.freeze({ id: sqliteLiveHead(host.reader()) }),
        read: async (from, limit) =>
          readSqliteLiveChanges(host.reader(), from.id, limit).map((change) => ({ change, position: Object.freeze({ id: change.id }) })),
        locate: async (cursor) =>
          nonNegative(cursor) && sqliteLiveKept(host.reader(), cursor) ? Object.freeze({ id: cursor }) : undefined,
        prune: (before) => host.queueWrite((write) => pruneSqliteLiveChanges(write, before)),
        /* data_version moves when any other connection to the file commits, this process's writer included. */
        moved: async () => {
          if (host.closed()) return false;
          const row = host.reader().prepare('PRAGMA data_version').get() as { data_version: number } | undefined;
          const next = Number(row?.data_version ?? 0);
          /* The first look has nothing to compare with: a commit between the hub's start and now would be missed, so it reads. */
          const moved = version === undefined || next !== version;
          version = next;
          return moved;
        },
      };
    }
    case 'postgres':
      return {
        dialect: 'postgres',
        ready: () => host.withReadClient((client) => postgresLiveChangeReady(client)),
        head: () => host.withReadClient((client) => postgresLiveHead(client)),
        read: (from, limit) =>
          host.withReadClient((client) =>
            readPostgresLiveChanges(client, from.xact === undefined ? POSTGRES_LIVE_START : { xact: from.xact, id: from.id }, limit),
          ),
        locate: (cursor) =>
          nonNegative(cursor) ? host.withReadClient((client) => locatePostgresLiveCursor(client, cursor)) : Promise.resolve(undefined),
        prune: (before) => host.withWriteClient((client) => prunePostgresLiveChanges(client, before)),
        unsettled: (from) =>
          host.withReadClient((client) =>
            postgresLiveUnsettled(client, from.xact === undefined ? POSTGRES_LIVE_START : { xact: from.xact, id: from.id }),
          ),
      };
    case 'mysql': {
      const database = host.database();
      /* Ids not in the run yet, and when each was first missed. */
      const missing = new Map<string, number>();
      let newest: string | undefined;
      return {
        dialect: 'mysql',
        ready: () => host.withReader((db) => mysqlLiveChangeReady(db, database)),
        head: async () => Object.freeze({ id: await host.withReader((db) => mysqlLiveHead(db, database)) }),
        async read(from, limit) {
          const rows = await host.withReader((db) => readMysqlLiveChanges(db, database, from.id, limit));
          const out: LiveRead[] = [];
          let expected = BigInt(from.id) + 1n;
          for (const change of rows) {
            const id = BigInt(change.id);
            /* An id skipped over may belong to a transaction still open: stop before it, until it has waited long enough. */
            for (; expected < id; expected++) {
              const key = String(expected);
              const since = missing.get(key) ?? now();
              missing.set(key, since);
              if (now() - since < MYSQL_GAP_MS) return out;
              missing.delete(key);
            }
            missing.delete(change.id);
            out.push({ change, position: Object.freeze({ id: change.id }) });
            expected = id + 1n;
          }
          return out;
        },
        locate: async (cursor) =>
          nonNegative(cursor) && (cursor === '0' ? false : await host.withReader((db) => mysqlLiveKept(db, database, cursor)))
            ? Object.freeze({ id: cursor })
            : undefined,
        prune: (before) => host.withWriter((db) => pruneMysqlLiveChanges(db, database, before)),
        /* A gap waited on: its wait ends on the clock, which no commit announces. */
        unsettled: async () => missing.size > 0,
        async moved() {
          const head = await host.withReader((db) => mysqlLiveHead(db, database));
          const moved = newest === undefined || head !== newest;
          newest = head;
          return moved;
        },
      };
    }
  }
}
