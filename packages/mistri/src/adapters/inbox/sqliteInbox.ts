/**
 * Notifications on SQLite: the layout, its attestation, the explicit
 * provisioning step and the statements the runtime runs — an append on the
 * business write's own handle, a person's read, and marking theirs read.
 *
 * Attested as the record history's is: SQLite keeps each CREATE statement's
 * text, so the reserved tables and their one index must read exactly as
 * this version writes them, with no trigger or view under the prefix.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  INBOX_INDEX,
  INBOX_LIMITS,
  INBOX_PREFIX,
  INBOX_TABLES,
  INBOX_VERSION,
  InboxUnavailable,
  assertInboxMark,
  assertInboxQuery,
  assertNoticeRow,
  storedNotice,
  type InboxMark,
  type InboxQuery,
  type NoticeRow,
  type StoredNotice,
} from './inbox.js';
import { inboxMailStore, type InboxMailStore } from './inboxMail.js';

const { meta, notice, mail, optout } = INBOX_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${INBOX_VERSION})
)`,
  ],
  [
    notice,
    `CREATE TABLE "${notice}" (
  id INTEGER PRIMARY KEY,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', INBOX_LIMITS.app)}),
  recipient TEXT COLLATE BINARY NOT NULL CHECK (${bytes('recipient', INBOX_LIMITS.recipient)}),
  at TEXT NOT NULL,
  resource TEXT COLLATE BINARY NOT NULL CHECK (${bytes('resource', INBOX_LIMITS.resource)}),
  key_json TEXT COLLATE BINARY NOT NULL CHECK (json_valid(key_json) AND ${bytes('key_json', INBOX_LIMITS.key)}),
  title TEXT NOT NULL CHECK (${bytes('title', INBOX_LIMITS.title)}),
  uses_json TEXT NOT NULL CHECK (json_valid(uses_json) AND ${bytes('uses_json', INBOX_LIMITS.uses)}),
  actor TEXT COLLATE BINARY NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  read_at TEXT
)`,
  ],
  [
    mail,
    `CREATE TABLE "${mail}" (
  notice INTEGER PRIMARY KEY,
  state TEXT COLLATE BINARY NOT NULL,
  attempts INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  last_error TEXT
)`,
  ],
  [
    optout,
    `CREATE TABLE "${optout}" (
  holder TEXT COLLATE BINARY PRIMARY KEY,
  at TEXT NOT NULL
)`,
  ],
]);
const INDEX = `CREATE INDEX "${INBOX_INDEX}" ON "${notice}" (app, recipient, id)`;

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function catalog(db: DatabaseSync): CatalogEntry[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(INBOX_PREFIX.length, INBOX_PREFIX, INBOX_PREFIX.length, INBOX_PREFIX) as unknown as CatalogEntry[];
}

/** Exactly this version's two tables and one index, nothing else under the prefix, and its version row. */
export function sqliteInboxReady(db: DatabaseSync): boolean {
  if (
    db
      .prepare(`SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
      .get(INBOX_PREFIX.length, INBOX_PREFIX, INBOX_PREFIX.length, INBOX_PREFIX)
  )
    return false;
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  const indexes = entries.filter((entry) => entry.type === 'index');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && entry.type !== 'index') ||
    indexes.some(
      (entry) => !((entry.sql === null && definitions.has(entry.tbl_name)) || (entry.name === INBOX_INDEX && entry.sql === INDEX)),
    ) ||
    !indexes.some((entry) => entry.name === INBOX_INDEX)
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === INBOX_VERSION;
}

function assertSqliteInbox(db: DatabaseSync): void {
  if (!sqliteInboxReady(db))
    throw new InboxUnavailable(layoutRefusal('The notification store', sqliteLayoutVersion(db, meta), INBOX_VERSION));
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteInbox(existingPath: string): { version: typeof INBOX_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Notification store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        db.exec(inMain(INDEX));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(INBOX_VERSION);
        provisioned = true;
      }
      assertSqliteInbox(db);
      db.exec('COMMIT');
      return { version: INBOX_VERSION, provisioned };
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

/** One notice, on the business write's own handle, inside its transaction — and its place in the outbox when it is emailed too. */
export function appendSqliteNotice(db: DatabaseSync, row: NoticeRow): void {
  const uses = assertNoticeRow(row);
  const written = db
    .prepare(`INSERT INTO main."${notice}" (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.app, row.recipient, row.at, row.resource, row.key, row.title, uses, row.actor, row.actorName, row.action);
  if (row.email) {
    db.prepare(`INSERT INTO main."${mail}" (notice, state, attempts, due_at, last_error) VALUES (?, 'queued', 0, ?, NULL)`).run(
      written.lastInsertRowid,
      row.at,
    );
  }
}

/** One person's notices in one App, newest first. */
/* `attested`: the adapter holds an attestation under the schema epoch it
   just read (sqlite.ts, storeEpoch), so the layout is not described again. */
export function readSqliteInbox(db: DatabaseSync, query: InboxQuery, attested = false): StoredNotice[] {
  assertInboxQuery(query);
  if (!attested) assertSqliteInbox(db);
  const rows = db
    .prepare(`SELECT id, app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action, read_at
    FROM main."${notice}" WHERE app = ? AND recipient = ?
      ${query.unread ? 'AND read_at IS NULL' : ''} ${query.before === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ?`)
    .all(query.app, query.recipient, ...(query.before === undefined ? [] : [query.before]), query.limit) as Array<Record<string, unknown>>;
  return rows.map(storedNotice);
}

/** Mark one person's notices read — the ids given, or all of them — and never anyone else's. */
export function markSqliteInboxRead(db: DatabaseSync, mark: InboxMark, attested = false): number {
  assertInboxMark(mark);
  if (!attested) assertSqliteInbox(db);
  const ids = mark.ids ?? [];
  const result = db
    .prepare(`UPDATE main."${notice}" SET read_at = ? WHERE app = ? AND recipient = ? AND read_at IS NULL
    ${ids.length ? `AND id IN (${ids.map(() => '?').join(', ')})` : ''}`)
    .run(mark.at, mark.app, mark.recipient, ...ids);
  return Number(result.changes);
}

/** The outbox on the write handle, one statement shape for every engine (inboxMail.ts). */
export function sqliteInboxMail(through: <T>(work: (db: DatabaseSync) => T | Promise<T>) => Promise<T>): InboxMailStore {
  return inboxMailStore(
    (name) => `main."${name}"`,
    (work) =>
      through((db) =>
        work({
          all: async (sql, params) => db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>,
          run: async (sql, params) => Number(db.prepare(sql).run(...(params as never[])).changes),
        }),
      ),
  );
}
