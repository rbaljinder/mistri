/**
 * Live sync's store on SQLite: the layout, its attestation, the explicit
 * provisioning step, the append on the business write's own handle, and the
 * reads the hub runs on the read-only handle.
 *
 * Commits are serialised in one file, so a row's id is its commit order and
 * a cursor is an id. AUTOINCREMENT, so an id is never handed out twice: a
 * cursor held across a prune that emptied the table must not meet a new row
 * under its own number. The newest row is never pruned, so the oldest kept
 * row says whether a cursor is still inside what is kept.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  LIVE_CHANGE_INDEX,
  LIVE_CHANGE_LIMITS,
  LIVE_CHANGE_PREFIX,
  LIVE_CHANGE_TABLES,
  LIVE_CHANGE_VERSION,
  LiveChangeUnavailable,
  assertLiveChangeRow,
  parseLiveEntries,
  type LiveChangeRow,
  type StoredLiveChange,
} from './liveChange.js';

const { meta, change } = LIVE_CHANGE_TABLES;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${LIVE_CHANGE_VERSION})
)`,
  ],
  [
    change,
    `CREATE TABLE "${change}" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT COLLATE BINARY NOT NULL CHECK (length(actor) <= ${LIVE_CHANGE_LIMITS.actor}),
  tenant TEXT COLLATE BINARY CHECK (tenant IS NULL OR length(tenant) <= ${LIVE_CHANGE_LIMITS.tenant}),
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json) AND length(CAST(entries_json AS BLOB)) <= ${LIVE_CHANGE_LIMITS.entries})
)`,
  ],
]);
const INDEX = `CREATE INDEX "${LIVE_CHANGE_INDEX}" ON "${change}" (at)`;

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
    .all(LIVE_CHANGE_PREFIX.length, LIVE_CHANGE_PREFIX, LIVE_CHANGE_PREFIX.length, LIVE_CHANGE_PREFIX) as unknown as CatalogEntry[];
}

/** Exactly this version's two tables and one index, nothing else under the prefix, and its version row. */
export function sqliteLiveChangeReady(db: DatabaseSync): boolean {
  try {
    if (
      db
        .prepare(`SELECT 1 FROM temp.sqlite_schema
      WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
        .get(LIVE_CHANGE_PREFIX.length, LIVE_CHANGE_PREFIX, LIVE_CHANGE_PREFIX.length, LIVE_CHANGE_PREFIX)
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
        (entry) => !((entry.sql === null && definitions.has(entry.tbl_name)) || (entry.name === LIVE_CHANGE_INDEX && entry.sql === INDEX)),
      ) ||
      !indexes.some((entry) => entry.name === LIVE_CHANGE_INDEX)
    )
      return false;
    const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === LIVE_CHANGE_VERSION;
  } catch {
    return false;
  }
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the store
 * gets this version; the same layout again changes nothing; anything else
 * under the prefix is refused unchanged.
 */
export function provisionSqliteLiveChange(existingPath: string): { version: typeof LIVE_CHANGE_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Live sync provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        db.exec(inMain(INDEX));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(LIVE_CHANGE_VERSION);
        provisioned = true;
      }
      if (!sqliteLiveChangeReady(db))
        throw new LiveChangeUnavailable(layoutRefusal('The live sync store', sqliteLayoutVersion(db, meta), LIVE_CHANGE_VERSION));
      db.exec('COMMIT');
      return { version: LIVE_CHANGE_VERSION, provisioned };
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

/** One row, on the business write's own handle, inside its transaction. */
export function appendSqliteLiveChange(db: DatabaseSync, row: LiveChangeRow): void {
  const entries = assertLiveChangeRow(row);
  db.prepare(`INSERT INTO main."${change}" (at, actor, tenant, entries_json) VALUES (?, ?, ?, ?)`).run(
    row.at,
    row.actor,
    row.tenant,
    entries,
  );
}

const stored = (row: Record<string, unknown>): StoredLiveChange =>
  Object.freeze({
    id: String(row.id),
    at: Number(row.at),
    actor: String(row.actor),
    tenant: typeof row.tenant === 'string' ? row.tenant : null,
    entries: parseLiveEntries(row.entries_json),
  });

/** The newest row's id, or 0 for an empty store: where a new subscriber starts. */
export function sqliteLiveHead(db: DatabaseSync): string {
  const row = db.prepare(`SELECT max(id) AS id FROM main."${change}"`).get() as { id: number | bigint | null } | undefined;
  return String(row?.id ?? 0);
}

/** Rows after `id`, oldest first, at most `limit`. */
export function readSqliteLiveChanges(db: DatabaseSync, after: string, limit: number): StoredLiveChange[] {
  return (
    db
      .prepare(`SELECT id, at, actor, tenant, entries_json FROM main."${change}" WHERE id > ? ORDER BY id LIMIT ?`)
      .all(BigInt(after), limit) as Array<Record<string, unknown>>
  ).map(stored);
}

/** Whether rows after `id` are all still kept: the oldest kept row follows it directly, or none was ever pruned past it. */
export function sqliteLiveKept(db: DatabaseSync, after: string): boolean {
  const row = db.prepare(`SELECT min(id) AS low FROM main."${change}"`).get() as { low: number | bigint | null } | undefined;
  const sequence = db.prepare(`SELECT seq FROM main.sqlite_sequence WHERE name = ?`).get(change) as { seq: number | bigint } | undefined;
  const cursor = BigInt(after);
  if (sequence && cursor > BigInt(sequence.seq)) return false;
  if (row?.low === null || row?.low === undefined) return cursor >= BigInt(sequence?.seq ?? 0);
  return cursor >= BigInt(row.low) - 1n;
}

/** Rows older than `before` (ms), the newest always kept. On a writer, in the write queue. */
export function pruneSqliteLiveChanges(db: DatabaseSync, before: number): number {
  const result = db.prepare(`DELETE FROM main."${change}" WHERE at < ? AND id < (SELECT max(id) FROM main."${change}")`).run(before) as {
    changes: number | bigint;
  };
  return Number(result.changes);
}
