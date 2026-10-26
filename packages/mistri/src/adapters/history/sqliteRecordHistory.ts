/**
 * Record history on SQLite: the layout, its attestation, the explicit
 * provisioning step and the statements the runtime runs — an append on the
 * business write's own handle, a read of one record's rows, and a read of the
 * newest rows across resources (a dashboard's activity).
 *
 * The layout is attested the way the command journal's is: SQLite keeps each
 * CREATE statement's text, so the reserved tables and their one index must
 * read exactly as this version writes them, with no trigger or view under the
 * prefix. A trigger could rewrite or drop the rows a write appends.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  RECORD_HISTORY_AT_INDEX,
  RECORD_HISTORY_INDEX,
  RECORD_HISTORY_LIMITS,
  RECORD_HISTORY_PREFIX,
  RECORD_HISTORY_TABLES,
  RECORD_HISTORY_VERSION,
  RecordHistoryUnavailable,
  assertActivityQuery,
  assertChangeRow,
  assertHistoryQuery,
  parseStoredChanges,
  type RecordActivityQuery,
  type RecordChangeRow,
  type RecordHistoryQuery,
  type StoredRecordChange,
} from './recordHistory.js';
import type { WriteVia } from '@mistriwork/engine/adapters/writeAttribution.js';

const { meta, change } = RECORD_HISTORY_TABLES;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${RECORD_HISTORY_VERSION})
)`,
  ],
  [
    change,
    `CREATE TABLE "${change}" (
  id INTEGER PRIMARY KEY,
  write_id TEXT COLLATE BINARY NOT NULL,
  at TEXT NOT NULL,
  resource TEXT COLLATE BINARY NOT NULL CHECK (length(CAST(resource AS BLOB)) <= ${RECORD_HISTORY_LIMITS.resource}),
  key_json TEXT COLLATE BINARY NOT NULL CHECK (json_valid(key_json) AND length(CAST(key_json AS BLOB)) <= ${RECORD_HISTORY_LIMITS.key}),
  kind TEXT NOT NULL CHECK (kind IN ('insert', 'update', 'delete')),
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json) AND length(CAST(changes_json AS BLOB)) <= ${RECORD_HISTORY_LIMITS.changes}),
  actor TEXT COLLATE BINARY NOT NULL,
  actor_name TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('app', 'workbench', 'agent', 'api', 'form', 'system')),
  action TEXT NOT NULL
)`,
  ],
]);
const INDEXES = new Map<string, string>([
  [RECORD_HISTORY_INDEX, `CREATE INDEX "${RECORD_HISTORY_INDEX}" ON "${change}" (resource, key_json, id)`],
  [RECORD_HISTORY_AT_INDEX, `CREATE INDEX "${RECORD_HISTORY_AT_INDEX}" ON "${change}" (at)`],
]);

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
    .all(
      RECORD_HISTORY_PREFIX.length,
      RECORD_HISTORY_PREFIX,
      RECORD_HISTORY_PREFIX.length,
      RECORD_HISTORY_PREFIX,
    ) as unknown as CatalogEntry[];
}

/** Exactly this version's two tables and two indexes, nothing else under the prefix, and its version row. */
export function sqliteRecordHistoryReady(db: DatabaseSync): boolean {
  if (
    db
      .prepare(`SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
      .get(RECORD_HISTORY_PREFIX.length, RECORD_HISTORY_PREFIX, RECORD_HISTORY_PREFIX.length, RECORD_HISTORY_PREFIX)
  )
    return false;
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  const indexes = entries.filter((entry) => entry.type === 'index');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && entry.type !== 'index') ||
    indexes.some((entry) => !((entry.sql === null && definitions.has(entry.tbl_name)) || INDEXES.get(entry.name) === entry.sql)) ||
    [...INDEXES.keys()].some((name) => !indexes.some((entry) => entry.name === name))
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === RECORD_HISTORY_VERSION;
}

function assertSqliteRecordHistory(db: DatabaseSync): void {
  if (!sqliteRecordHistoryReady(db))
    throw new RecordHistoryUnavailable(layoutRefusal('The record history store', sqliteLayoutVersion(db, meta), RECORD_HISTORY_VERSION));
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteRecordHistory(existingPath: string): { version: typeof RECORD_HISTORY_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Record history provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        for (const ddl of INDEXES.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(RECORD_HISTORY_VERSION);
        provisioned = true;
      }
      assertSqliteRecordHistory(db);
      db.exec('COMMIT');
      return { version: RECORD_HISTORY_VERSION, provisioned };
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
export function appendSqliteRecordChange(db: DatabaseSync, row: RecordChangeRow): void {
  const changes = assertChangeRow(row);
  db.prepare(`INSERT INTO main."${change}" (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.writeId,
    row.at,
    row.resource,
    row.key,
    row.kind,
    changes,
    row.actor,
    row.actorName,
    row.via,
    row.action,
  );
}

/**
 * One record's rows, newest first, since the last time a record with its key
 * was deleted: a key the database handed out again belongs to a new record,
 * and the old one's history is not the new one's.
 */
/* `attested`: the adapter holds an attestation under the schema epoch it just read (sqlite.ts, storeEpoch). */
export function readSqliteRecordHistory(db: DatabaseSync, query: RecordHistoryQuery, attested = false): StoredRecordChange[] {
  assertHistoryQuery(query);
  if (!attested) assertSqliteRecordHistory(db);
  const rows = db
    .prepare(`SELECT id, write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action
    FROM main."${change}"
    WHERE resource = ? AND key_json = ?
      AND id > COALESCE((SELECT MAX(id) FROM main."${change}" WHERE resource = ? AND key_json = ? AND kind = 'delete'), 0)
      ${query.before === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ?`)
    .all(query.resource, query.key, query.resource, query.key, ...(query.before === undefined ? [] : [query.before]), query.limit) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: Number(row.id),
    writeId: String(row.write_id),
    at: String(row.at),
    resource: String(row.resource),
    key: String(row.key_json),
    kind: row.kind as StoredRecordChange['kind'],
    changes: parseStoredChanges(row.changes_json),
    actor: String(row.actor),
    actorName: String(row.actor_name),
    via: row.via as WriteVia,
    action: String(row.action),
  }));
}

/**
 * A feed's rows across resources, newest first (recordHistory.ts,
 * RecordActivityQuery). Read in the primary key's order, which is the order
 * the rows were appended; a record whose key was deleted since a row is not
 * that row's record, so the row is left out, found through the record index.
 */
export function readSqliteRecordActivity(db: DatabaseSync, query: RecordActivityQuery, attested = false): StoredRecordChange[] {
  assertActivityQuery(query);
  if (!attested) assertSqliteRecordHistory(db);
  // One tenant's feed: each tenant-owned resource's rows by the owner its stored key names (historyKey).
  const owned = Object.entries(query.owners?.columns ?? {});
  const rows = db
    .prepare(`SELECT c.id, c.write_id, c.at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM main."${change}" c
    WHERE c.resource IN (${query.resources.map(() => '?').join(', ')}) AND c.kind <> 'delete'
      ${query.from === undefined ? '' : 'AND c.at >= ?'} ${query.to === undefined ? '' : 'AND c.at < ?'} ${query.after === undefined ? '' : 'AND c.id > ?'}
      ${owned.length ? `AND (c.resource NOT IN (${owned.map(() => '?').join(', ')})${owned.map(() => ' OR (c.resource = ? AND json_extract(c.key_json, ?) = ?)').join('')})` : ''}
      AND NOT EXISTS (SELECT 1 FROM main."${change}" d WHERE d.resource = c.resource AND d.key_json = c.key_json AND d.kind = 'delete' AND d.id > c.id)
    ORDER BY c.id ${query.after === undefined ? 'DESC' : 'ASC'} LIMIT ?`)
    .all(
      ...query.resources,
      ...(query.from === undefined ? [] : [query.from]),
      ...(query.to === undefined ? [] : [query.to]),
      ...(query.after === undefined ? [] : [query.after]),
      ...owned.map(([resource]) => resource),
      ...owned.flatMap(([resource, column]) => [resource, `$."${column}"`, query.owners!.tenant]),
      query.limit,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    writeId: String(row.write_id),
    at: String(row.at),
    resource: String(row.resource),
    key: String(row.key_json),
    kind: row.kind as StoredRecordChange['kind'],
    changes: parseStoredChanges(row.changes_json),
    actor: String(row.actor),
    actorName: String(row.actor_name),
    via: row.via as WriteVia,
    action: String(row.action),
  }));
}
