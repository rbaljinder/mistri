/**
 * The write journal's store: where a connection's Undo history is kept when
 * the database holds it, so a restart does not forget the writes it could
 * still put back (journal.ts).
 *
 * The store is opt-in, like every reserved store: provisioned by an explicit
 * step (`mistri migrate stores`, `provisionStores({ only: ['undo-journal'] })`,
 * or the provisioning functions here for a host that has no App framework),
 * never by opening a connection. A writable connection whose database holds
 * this build's layout keeps its journal there; one that holds none keeps it in
 * memory, as before, and one that holds another layout keeps it in memory and
 * says why once.
 *
 * It sits in the business database, beside the rows it describes, under the
 * reserved prefix: the catalog never lists it, and a copy of the database
 * carries the history that belongs to it. What is kept is what memory holds —
 * the entry the hidden-column wrapper already stripped — so a hidden value is
 * no more in the store than it was in the journal.
 *
 * Retention is the journal's own depth (the newest `entries` per connection)
 * and an age (`days`): an Undo a week later is an overwrite more often than
 * not, and the revert's check-before-write is the only thing that would stop
 * it. An entry too large to keep is kept as a barrier instead, which is what
 * it is after a restart: a write whose inverse is gone, so no older Undo is
 * offered past it.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal, type Adapter } from '../adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion, sqliteLayoutVersion } from '../adapters/layoutRefusal.js';
import { withPostgresMaintenanceTransaction } from '../adapters/postgresMaintenance.js';
import type { PgQuery } from '../adapters/postgresPool.js';
import { storeHostOf, writeViewOf, type StoreHost } from '../adapters/storeHost.js';
import { runtimeName, runtimeSchema, runtimeTable } from '../shared/runtimeTables.js';
import { attachJournalStore, type JournalEntry, type JournalStore } from './journal.js';

const WRITE_JOURNAL_VERSION = 1;
/** The reserved prefix of its tables (`mistri.undo_*` on PostgreSQL). */
const WRITE_JOURNAL_PREFIX = '__mistri_undo_';
const META = '__mistri_undo_meta';
const ENTRY = '__mistri_undo_entry';

/** How much is kept: the journal's depth per connection, a week, and an entry of at most 4 MiB. */
export const WRITE_JOURNAL_RETENTION = Object.freeze({ entries: 50, days: 7, bytes: 4 * 1024 * 1024 });
const DAY_MS = 86_400_000;

/** Why the store cannot be used: an unprovisioned database is not this; a layout that is not this build's is. */
class WriteJournalUnavailable extends Refusal {
  constructor(message = 'The write journal store is missing or is not the layout this version expects.') {
    super(message);
    this.name = 'WriteJournalUnavailable';
  }
}

/* ---------- SQLite ---------- */

const sqliteDefinitions = new Map<string, string>([
  [
    META,
    `CREATE TABLE "${META}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${WRITE_JOURNAL_VERSION})
)`,
  ],
  [
    ENTRY,
    `CREATE TABLE "${ENTRY}" (
  connection TEXT COLLATE BINARY NOT NULL,
  id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (connection, id)
)`,
  ],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const underPrefix = `substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`;
const prefixArgs = [WRITE_JOURNAL_PREFIX.length, WRITE_JOURNAL_PREFIX, WRITE_JOURNAL_PREFIX.length, WRITE_JOURNAL_PREFIX] as const;
const sqliteCatalog = (db: DatabaseSync): CatalogEntry[] =>
  db
    .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE ${underPrefix}`)
    .all(...prefixArgs) as unknown as CatalogEntry[];

/** Exactly this version's two tables and their key indexes, nothing else under the prefix, and its version row. */
export function sqliteWriteJournalReady(db: DatabaseSync): boolean {
  try {
    if (db.prepare(`SELECT 1 FROM temp.sqlite_schema WHERE ${underPrefix} LIMIT 1`).get(...prefixArgs)) return false;
    const entries = sqliteCatalog(db);
    const tables = entries.filter((entry) => entry.type === 'table');
    if (
      tables.length !== sqliteDefinitions.size ||
      tables.some((entry) => sqliteDefinitions.get(entry.name) !== entry.sql) ||
      entries.some(
        (entry) => entry.type !== 'table' && !(entry.type === 'index' && entry.sql === null && sqliteDefinitions.has(entry.tbl_name)),
      )
    )
      return false;
    const rows = db.prepare(`SELECT singleton, version FROM main."${META}"`).all();
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === WRITE_JOURNAL_VERSION;
  } catch {
    return false;
  }
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.');

/**
 * Explicit maintenance, never run when a connection opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteWriteJournal(existingPath: string): { version: typeof WRITE_JOURNAL_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Write journal provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (sqliteCatalog(db).length === 0) {
        for (const ddl of sqliteDefinitions.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${META}" (singleton, version) VALUES (1, ?)`).run(WRITE_JOURNAL_VERSION);
        provisioned = true;
      }
      if (!sqliteWriteJournalReady(db))
        throw new WriteJournalUnavailable(layoutRefusal('The write journal store', sqliteLayoutVersion(db, META), WRITE_JOURNAL_VERSION));
      db.exec('COMMIT');
      return { version: WRITE_JOURNAL_VERSION, provisioned };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve the provisioning failure. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/* ---------- PostgreSQL ---------- */

const pgMeta = runtimeTable('postgres', META);
const pgEntry = runtimeTable('postgres', ENTRY);
const pgPrefix = runtimeName('postgres', WRITE_JOURNAL_PREFIX.slice(0, -1)) + '_';
const pgDefinitions: readonly string[] = [
  `CREATE TABLE ${pgMeta} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${WRITE_JOURNAL_VERSION})
)`,
  `CREATE TABLE ${pgEntry} (
  connection text COLLATE "C" NOT NULL,
  id bigint NOT NULL,
  at bigint NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (connection, id)
)`,
];

/* What the DDL above reads back as, pinned so the attestation is of this layout and not of whatever is there. */
const PG_LAYOUT = JSON.stringify([
  {
    name: runtimeName('postgres', ENTRY),
    kind: 'r',
    columns: ['connection text C t', 'id bigint - t', 'at bigint - t', 'entry jsonb - t'],
    constraints: ['PRIMARY KEY (connection, id)'],
  },
  {
    name: `${runtimeName('postgres', ENTRY)}_pkey`,
    kind: 'i',
    columns: ['connection text C f', 'id bigint - f'],
    constraints: [],
  },
  {
    name: runtimeName('postgres', META),
    kind: 'r',
    columns: ['singleton integer - t', 'version integer - t'],
    constraints: ['CHECK ((singleton = 1))', `CHECK ((version = ${WRITE_JOURNAL_VERSION}))`, 'PRIMARY KEY (singleton)'],
  },
  {
    name: `${runtimeName('postgres', META)}_pkey`,
    kind: 'i',
    columns: ['singleton integer - f'],
    constraints: [],
  },
]);

/** Every relation under the prefix in the runtime schema, with its columns and constraints, in a fixed order; triggers, rules and row security disqualify it. */
async function pgRelations(client: PgQuery): Promise<{ text: string; count: number }> {
  const rows = (
    await client.query(
      `SELECT c.relname AS name, c.relkind::text AS kind,
        c.relrowsecurity OR c.relhastriggers OR c.relhasrules AS guarded,
        coalesce((SELECT json_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' ||
            coalesce((SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation AND a.attcollation <> 0
              AND a.attcollation <> (SELECT t.typcollation FROM pg_type t WHERE t.oid = a.atttypid)), '-') || ' ' ||
            CASE WHEN a.attnotnull THEN 't' ELSE 'f' END ORDER BY a.attnum)
          FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]') AS columns,
        coalesce((SELECT json_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid) COLLATE "C")
          FROM pg_constraint k WHERE k.conrelid = c.oid), '[]') AS constraints,
        (SELECT count(*) FROM pg_attrdef d WHERE d.adrelid = c.oid)::int AS defaults
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND substr(c.relname, 1, $2) = $3
      ORDER BY c.relname COLLATE "C"`,
      [runtimeSchema('postgres'), pgPrefix.length, pgPrefix],
    )
  ).rows as Array<{ name: string; kind: string; guarded: boolean; columns: string[]; constraints: string[]; defaults: number }>;
  if (rows.some((row) => row.guarded || row.defaults)) return { text: '', count: rows.length };
  return {
    text: JSON.stringify(rows.map(({ name, kind, columns, constraints }) => ({ name, kind, columns, constraints }))),
    count: rows.length,
  };
}

/** Whether the reserved relations are exactly this version's layout with its version row. */
export async function postgresWriteJournalReady(client: PgQuery): Promise<boolean> {
  try {
    if ((await pgRelations(client)).text !== PG_LAYOUT) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${pgMeta}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === WRITE_JOURNAL_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresWriteJournal(url: string): Promise<{ version: typeof WRITE_JOURNAL_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Write journal provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await pgRelations(client)).count) {
      for (const ddl of pgDefinitions) await client.query(ddl);
      await client.query(`INSERT INTO ${pgMeta} (singleton, version) VALUES (1, $1)`, [WRITE_JOURNAL_VERSION]);
      provisioned = true;
    }
    if (!(await postgresWriteJournalReady(client)))
      throw new WriteJournalUnavailable(
        layoutRefusal('The write journal store', await postgresLayoutVersion(client, pgMeta), WRITE_JOURNAL_VERSION),
      );
    return { version: WRITE_JOURNAL_VERSION, provisioned };
  });
}

/* ---------- what is kept ---------- */

/** The stored form: the entry without the columns that say where and when it is. */
function stored(entry: JournalEntry): string {
  const { id: _id, connection: _connection, at: _at, ...rest } = entry;
  const json = JSON.stringify(rest);
  if (Buffer.byteLength(json) <= WRITE_JOURNAL_RETENTION.bytes) return json;
  // Kept as what it is after a restart: a write with no inverse left, which blocks every older Undo.
  const { steps, ...plain } = rest;
  return JSON.stringify({
    ...plain,
    revertible: false,
    blocksUndo: true,
    reason: 'This write was too large to keep its Undo across a restart.',
    steps: steps.length ? [{ table: steps[0].table }] : [],
  } satisfies Omit<JournalEntry, 'id' | 'connection' | 'at'>);
}

function revived(connection: string, id: unknown, at: unknown, json: unknown): JournalEntry {
  const body = (typeof json === 'string' ? JSON.parse(json) : json) as Omit<JournalEntry, 'id' | 'connection' | 'at'>;
  return { ...body, id: Number(id), connection, at: new Date(Number(at)).toISOString() };
}

const atOf = (entry: JournalEntry) => {
  const at = Date.parse(entry.at);
  return Number.isFinite(at) ? at : Date.now();
};
const oldest = () => Date.now() - WRITE_JOURNAL_RETENTION.days * DAY_MS;

function sqliteStore(host: Extract<StoreHost, { dialect: 'sqlite' }>): JournalStore {
  const prune = (db: DatabaseSync, connection: string) =>
    db
      .prepare(
        `DELETE FROM main."${ENTRY}" WHERE connection = ? AND (at < ? OR id NOT IN
          (SELECT id FROM main."${ENTRY}" WHERE connection = ? ORDER BY id DESC LIMIT ?))`,
      )
      .run(connection, oldest(), connection, WRITE_JOURNAL_RETENTION.entries);
  return {
    load: (connection) =>
      host.queueWrite((db) => {
        prune(db, connection);
        return (
          db.prepare(`SELECT id, at, entry_json FROM main."${ENTRY}" WHERE connection = ? ORDER BY id`).all(connection) as Array<
            Record<string, unknown>
          >
        ).map((row) => revived(connection, row.id, row.at, row.entry_json));
      }),
    append: (entry) =>
      host.queueWrite((db) => {
        db.prepare(`INSERT INTO main."${ENTRY}" (connection, id, at, entry_json) VALUES (?, ?, ?, ?)`).run(
          entry.connection,
          entry.id,
          atOf(entry),
          stored(entry),
        );
        prune(db, entry.connection);
      }),
    update: (entry) =>
      host.queueWrite((db) => {
        db.prepare(`UPDATE main."${ENTRY}" SET entry_json = ? WHERE connection = ? AND id = ?`).run(
          stored(entry),
          entry.connection,
          entry.id,
        );
      }),
    remove: (connection, id) =>
      host.queueWrite((db) => {
        db.prepare(`DELETE FROM main."${ENTRY}" WHERE connection = ? AND id = ?`).run(connection, id);
      }),
  };
}

function postgresStore(host: Extract<StoreHost, { dialect: 'postgres' }>): JournalStore {
  const prune = (client: PgQuery, connection: string) =>
    client.query(
      `DELETE FROM ${pgEntry} WHERE connection = $1 AND (at < $2 OR id NOT IN
        (SELECT id FROM ${pgEntry} WHERE connection = $1 ORDER BY id DESC LIMIT $3))`,
      [connection, oldest(), WRITE_JOURNAL_RETENTION.entries],
    );
  return {
    load: (connection) =>
      host.withWriteClient(async (client) => {
        await prune(client, connection);
        const rows = (await client.query(`SELECT id, at, entry FROM ${pgEntry} WHERE connection = $1 ORDER BY id`, [connection]))
          .rows as Array<Record<string, unknown>>;
        return rows.map((row) => revived(connection, row.id, row.at, row.entry));
      }),
    append: (entry) =>
      host.withWriteClient(async (client) => {
        await client.query(`INSERT INTO ${pgEntry} (connection, id, at, entry) VALUES ($1, $2, $3, $4::jsonb)`, [
          entry.connection,
          entry.id,
          atOf(entry),
          stored(entry),
        ]);
        await prune(client, entry.connection);
      }),
    update: (entry) =>
      host.withWriteClient(async (client) => {
        await client.query(`UPDATE ${pgEntry} SET entry = $1::jsonb WHERE connection = $2 AND id = $3`, [
          stored(entry),
          entry.connection,
          entry.id,
        ]);
      }),
    remove: (connection, id) =>
      host.withWriteClient(async (client) => {
        await client.query(`DELETE FROM ${pgEntry} WHERE connection = $1 AND id = $2`, [connection, id]);
      }),
  };
}

/**
 * The store an adapter's database holds, or undefined where it holds none of
 * it (the journal then stays in memory). An adapter a wrapper narrowed is
 * looked through to the one it wraps. Throws WriteJournalUnavailable for a
 * layout that is not this build's.
 */
async function writeJournalStoreOf(adapter: Adapter): Promise<JournalStore | undefined> {
  const host = storeHostOf(adapter) ?? storeHostOf(writeViewOf(adapter)?.over);
  if (!host) return undefined;
  if (host.dialect === 'sqlite') {
    const db = host.reader();
    if (!sqliteCatalog(db).length) return undefined;
    if (!sqliteWriteJournalReady(db))
      throw new WriteJournalUnavailable(layoutRefusal('The write journal store', sqliteLayoutVersion(db, META), WRITE_JOURNAL_VERSION));
    return sqliteStore(host);
  }
  return host.withReadClient(async (client) => {
    if (!(await pgRelations(client)).count) return undefined;
    if (!(await postgresWriteJournalReady(client)))
      throw new WriteJournalUnavailable(
        layoutRefusal('The write journal store', await postgresLayoutVersion(client, pgMeta), WRITE_JOURNAL_VERSION),
      );
    return postgresStore(host);
  });
}

/**
 * Keep `connection`'s journal in its database when the database holds the
 * store: what it held is read back, and every write from here on is kept
 * there too. Never fatal: a store that cannot be read leaves the journal in
 * memory, said through `warn`. Resolves to whether the store is now used.
 */
export async function keepWriteJournal(
  connection: string,
  adapter: Adapter,
  warn: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
  try {
    const store = await writeJournalStoreOf(adapter);
    if (!store) return false;
    await attachJournalStore(connection, store, warn);
    return true;
  } catch (error) {
    warn(`"${connection}": Undo history is kept in memory for this run: ${(error as Error).message}`);
    return false;
  }
}
