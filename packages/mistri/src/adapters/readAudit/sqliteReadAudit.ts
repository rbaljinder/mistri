/**
 * The read audit on SQLite: the layout, its attestation, the explicit
 * provisioning step, one append and the read `mistri audit reads` makes.
 *
 * Attested the way record history is (SQLite keeps each CREATE statement's
 * text), with one difference: the store owns two triggers, and they must be
 * exactly these. They are what make the log append-only, so a store with one
 * dropped or rewritten is refused, not trusted.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  READ_AUDIT_AT_INDEX,
  READ_AUDIT_LIMITS,
  READ_AUDIT_PREFIX,
  READ_AUDIT_RECORD_INDEX,
  READ_AUDIT_TABLES,
  READ_AUDIT_VERSION,
  READ_ROUTES,
  ReadAuditUnavailable,
  assertReadAuditQuery,
  assertReadAuditRow,
  readAuditFilters,
  storedReadAudit,
  type ReadAuditQuery,
  type ReadAuditRow,
  type StoredReadAudit,
} from './readAudit.js';

const { meta, row: log } = READ_AUDIT_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const metaDdl = (version: number) => `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${version})
)`;
/* The log as `version` lays it out: version 3 adds the reader's roles and membership after `command`, and version 4 a
   row-scoped token's scope after those. The upgrade from version 1 builds version 2's table, which each step after it
   rebuilds again. */
const logDdl = (version: 2 | 3 | 4) => `CREATE TABLE "${log}" (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', READ_AUDIT_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', READ_AUDIT_LIMITS.tenant)}),
  actor TEXT COLLATE BINARY NOT NULL CHECK (${bytes('actor', READ_AUDIT_LIMITS.actor)}),
  visit TEXT COLLATE BINARY CHECK (${bytes('visit', READ_AUDIT_LIMITS.visit)}),
  resource TEXT COLLATE BINARY NOT NULL CHECK (${bytes('resource', READ_AUDIT_LIMITS.resource)}),
  route TEXT NOT NULL CHECK (route IN (${READ_ROUTES.map((route) => `'${route}'`).join(', ')})),
  record_key TEXT COLLATE BINARY CHECK (${bytes('record_key', READ_AUDIT_LIMITS.record)}),
  query_json TEXT CHECK (json_valid(query_json) AND ${bytes('query_json', READ_AUDIT_LIMITS.query)}),
  row_count INTEGER CHECK (row_count >= 0),
  ids_json TEXT CHECK (json_valid(ids_json) AND ${bytes('ids_json', READ_AUDIT_LIMITS.ids)}),
  command TEXT COLLATE BINARY CHECK (${bytes('command', READ_AUDIT_LIMITS.command)}),${
    version >= 3
      ? `
  roles_json TEXT CHECK (json_valid(roles_json) AND ${bytes('roles_json', READ_AUDIT_LIMITS.roles)}),
  membership TEXT COLLATE BINARY CHECK (${bytes('membership', READ_AUDIT_LIMITS.membership)}),`
      : ''
  }${
    version >= 4
      ? `
  scope TEXT COLLATE BINARY CHECK (${bytes('scope', READ_AUDIT_LIMITS.scope)}),`
      : ''
  }
  CHECK ((record_key IS NULL) <> (query_json IS NULL)),
  CHECK ((command IS NULL) <> (route = 'command'))
)`;
const definitions = new Map<string, string>([
  [meta, metaDdl(READ_AUDIT_VERSION)],
  [log, logDdl(READ_AUDIT_VERSION)],
]);
const INDEXES = new Map<string, string>([
  [READ_AUDIT_RECORD_INDEX, `CREATE INDEX "${READ_AUDIT_RECORD_INDEX}" ON "${log}" (resource, record_key, id)`],
  [READ_AUDIT_AT_INDEX, `CREATE INDEX "${READ_AUDIT_AT_INDEX}" ON "${log}" (at)`],
]);
const APPEND_ONLY = "BEGIN SELECT RAISE(ABORT, 'The read audit is append-only.'); END";
const TRIGGERS = new Map<string, string>([
  [`${log}_no_delete`, `CREATE TRIGGER "${log}_no_delete" BEFORE DELETE ON "${log}" ${APPEND_ONLY}`],
  [`${log}_no_update`, `CREATE TRIGGER "${log}_no_update" BEFORE UPDATE ON "${log}" ${APPEND_ONLY}`],
]);

/* Version 1's columns, which version 2 keeps in order and adds `command` after; version 3 adds `roles_json` and
   `membership` after that, and version 4 `scope`. */
const V1_COLUMNS = 'id, at, app, tenant, actor, visit, resource, route, record_key, query_json, row_count, ids_json';
const V2_COLUMNS = `${V1_COLUMNS}, command`;
const V3_COLUMNS = `${V2_COLUMNS}, roles_json, membership`;

/* The log rebuilt as `to` lays it out. SQLite keeps a table's CREATE text and the attestation compares it whole, so
   the log is rebuilt rather than altered: its rows copied, ids kept, into the new table. The triggers go first and
   come back last; DROP TABLE fires no DELETE trigger, and nothing else may write while the transaction holds the
   file. Every row is copied: a row the new table's checks refuse fails the step, and the transaction leaves the
   store as it was. */
function rebuild(to: 2 | 3 | 4, kept: string): readonly string[] {
  const parked = `${log}_v${to - 1}`;
  return [
    ...[...TRIGGERS.keys()].map((name) => `DROP TRIGGER "${name}"`),
    ...[...INDEXES.keys()].map((name) => `DROP INDEX "${name}"`),
    `ALTER TABLE "${log}" RENAME TO "${parked}"`,
    logDdl(to),
    `INSERT INTO "${log}" (${kept}) SELECT ${kept} FROM "${parked}" ORDER BY id`,
    `DROP TABLE "${parked}"`,
    ...INDEXES.values(),
    ...TRIGGERS.values(),
    `DROP TABLE "${meta}"`,
    metaDdl(to),
    `INSERT INTO "${meta}" (singleton, version) VALUES (1, ${to})`,
  ];
}

/** Version 1 to 2, as statements for the store upgrade (storeLayouts.ts) to run in its one transaction. */
export function sqliteReadAuditUpgradeFrom1(): readonly string[] {
  return rebuild(2, V1_COLUMNS);
}

/** Version 2 to 3: every row kept, with no roles or membership, which version 2 never recorded. */
export function sqliteReadAuditUpgradeFrom2(): readonly string[] {
  return rebuild(3, V2_COLUMNS);
}

/** Version 3 to 4: every row kept, with no scope, which version 3 never recorded. */
export function sqliteReadAuditUpgradeFrom3(): readonly string[] {
  return rebuild(4, V3_COLUMNS);
}

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const UNDER_PREFIX = 'substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE';
const prefixArgs = [READ_AUDIT_PREFIX.length, READ_AUDIT_PREFIX, READ_AUDIT_PREFIX.length, READ_AUDIT_PREFIX] as const;
function catalog(db: DatabaseSync): CatalogEntry[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE ${UNDER_PREFIX}`)
    .all(...prefixArgs) as unknown as CatalogEntry[];
}

/** Exactly this version's two tables, two indexes and two triggers, nothing else under the prefix, and its version row. */
export function sqliteReadAuditReady(db: DatabaseSync): boolean {
  if (db.prepare(`SELECT 1 FROM temp.sqlite_schema WHERE ${UNDER_PREFIX} LIMIT 1`).get(...prefixArgs)) return false;
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  const indexes = entries.filter((entry) => entry.type === 'index');
  const triggers = entries.filter((entry) => entry.type === 'trigger');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && entry.type !== 'index' && entry.type !== 'trigger') ||
    indexes.some((entry) => !((entry.sql === null && definitions.has(entry.tbl_name)) || INDEXES.get(entry.name) === entry.sql)) ||
    [...INDEXES.keys()].some((name) => !indexes.some((entry) => entry.name === name)) ||
    triggers.length !== TRIGGERS.size ||
    triggers.some((entry) => TRIGGERS.get(entry.name) !== entry.sql)
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === READ_AUDIT_VERSION;
}

function assertSqliteReadAudit(db: DatabaseSync): void {
  if (!sqliteReadAuditReady(db))
    throw new ReadAuditUnavailable(layoutRefusal('The read audit store', sqliteLayoutVersion(db, meta), READ_AUDIT_VERSION));
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteReadAudit(existingPath: string): { version: typeof READ_AUDIT_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Read audit provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        for (const ddl of INDEXES.values()) db.exec(inMain(ddl));
        // A trigger lives in its table's schema; SQLite keeps the text as written, so it is written unqualified.
        for (const ddl of TRIGGERS.values()) db.exec(ddl);
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(READ_AUDIT_VERSION);
        provisioned = true;
      }
      assertSqliteReadAudit(db);
      db.exec('COMMIT');
      return { version: READ_AUDIT_VERSION, provisioned };
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

/*
 * The schema epoch an append trusts: the main schema's version, everything in
 * temp (a temp trigger can sit on a main table), and the meta row (a data
 * fact). A store's other statements read it as a statement of its own
 * (sqlite.ts, attestedStore); an append is on every audited read, so it rides
 * in the insert's own WHERE instead, and a request pays one statement.
 */
const MAIN_EPOCH = '(SELECT schema_version FROM main.pragma_schema_version)';
const TEMP_EPOCH = `(SELECT coalesce(group_concat(type || ':' || name || ':' || tbl_name || ':' || coalesce(sql, ''), char(10)), '') FROM temp.sqlite_schema)`;
const META_ROW = `(SELECT count(*) FROM main."${meta}" WHERE singleton = 1 AND version = ${READ_AUDIT_VERSION})`;
const COLUMNS =
  'at, app, tenant, actor, visit, resource, route, record_key, query_json, row_count, ids_json, command, roles_json, membership, scope';
const attestedEpochs = new WeakMap<DatabaseSync, { main: number; temp: string }>();

const values = (row: ReadAuditRow) =>
  [
    row.at,
    row.app,
    row.tenant,
    row.actor,
    row.visit ?? null,
    row.resource,
    row.route,
    row.record ?? null,
    row.query ?? null,
    row.count ?? null,
    row.ids ?? null,
    row.command ?? null,
    row.roles === undefined ? null : JSON.stringify(row.roles),
    row.membership ?? null,
    row.scope ?? null,
  ] as const;

/**
 * One row, in one statement while the layout this handle attested stands: the
 * insert happens only if the epoch is still the attested one, so a store
 * altered since (a trigger dropped, a temp shadow) inserts nothing, is
 * described again, and refused if it is not this version's.
 */
export function appendSqliteReadAudit(db: DatabaseSync, row: ReadAuditRow): void {
  assertReadAuditRow(row);
  const known = attestedEpochs.get(db);
  if (known) {
    const done = db
      .prepare(`INSERT INTO main."${log}" (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${MAIN_EPOCH} = ? AND ${TEMP_EPOCH} = ? AND ${META_ROW} = 1`)
      .run(...values(row), known.main, known.temp);
    if (Number(done.changes) === 1) return;
    attestedEpochs.delete(db);
  }
  const epoch = db.prepare(`SELECT ${MAIN_EPOCH} AS main, ${TEMP_EPOCH} AS temp`).get() as { main: number; temp: string };
  assertSqliteReadAudit(db);
  db.prepare(`INSERT INTO main."${log}" (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values(row));
  attestedEpochs.set(db, { main: Number(epoch.main), temp: String(epoch.temp) });
}

/**
 * Rows gathered by a group commit (groupCommit.ts), in one transaction: one
 * commit, so one sync to disk, and all of them kept or none. A batch of one is
 * the one statement it always was.
 */
export function appendSqliteReadAudits(db: DatabaseSync, rows: readonly ReadAuditRow[]): void {
  for (const row of rows) assertReadAuditRow(row);
  if (rows.length <= 1) {
    if (rows.length) appendSqliteReadAudit(db, rows[0]!);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) appendSqliteReadAudit(db, row);
    db.exec('COMMIT');
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Preserve the append's failure. */
    }
    throw error;
  }
}

/* `attested`: the adapter holds an attestation under the schema epoch it just read (sqlite.ts, storeEpoch). */
export function readSqliteReadAudit(db: DatabaseSync, query: ReadAuditQuery, attested = false): StoredReadAudit[] {
  assertReadAuditQuery(query);
  if (!attested) assertSqliteReadAudit(db);
  const filters = readAuditFilters(query);
  const clause = ([column, op]: (typeof filters)[number]) =>
    op === 'shown' ? `(${column} = ? OR EXISTS (SELECT 1 FROM json_each(ids_json) WHERE value = ?))` : `${column} ${op} ?`;
  const rows = db
    .prepare(`SELECT id, at, app, tenant, actor, visit, resource, route, record_key, query_json, row_count, ids_json, command, roles_json, membership, scope
    FROM main."${log}" ${filters.length ? `WHERE ${filters.map(clause).join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`)
    .all(...filters.flatMap(([, op, value]) => (op === 'shown' ? [value, value] : [value])), query.limit) as Array<Record<string, unknown>>;
  return rows.map(storedReadAudit);
}
