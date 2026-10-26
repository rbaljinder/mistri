/**
 * Record history on MySQL and MariaDB: the same two tables, in the database
 * the connection's URL names, on InnoDB so the append commits or rolls back
 * with the business write it describes.
 *
 * Attestation is structural here. MySQL and MariaDB word a CREATE statement
 * differently from version to version, so the stored text cannot be pinned
 * the way SQLite's is; what is compared instead is what could change a row
 * the runtime appends or reads: every column's name, type and nullability,
 * the engine, the two tables' indexes, and the absence of any trigger or any
 * other relation under the prefix.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
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

/** The part of a mysql2 connection this module speaks through. */
interface MysqlHistoryConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

const { meta, change } = RECORD_HISTORY_TABLES;
const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const at = (database: string, table: string) => `${quote(database)}.${quote(table)}`;
/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). */
async function layoutMessage(db: MysqlHistoryConnection, database: string): Promise<string | undefined> {
  try {
    const [rows] = await db.execute(`SELECT version FROM ${at(database, meta)}`);
    return layoutRefusal('The record history store', versionOfRows(Array.isArray(rows) ? rows : []), RECORD_HISTORY_VERSION);
  } catch {
    return undefined;
  }
}

const definitions = (database: string): string[] => [
  `CREATE TABLE ${at(database, meta)} (
  singleton TINYINT NOT NULL PRIMARY KEY CHECK (singleton = 1),
  version INT NOT NULL CHECK (version = ${RECORD_HISTORY_VERSION})
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${at(database, change)} (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  write_id VARCHAR(64) NOT NULL,
  at DATETIME(3) NOT NULL,
  resource VARCHAR(${RECORD_HISTORY_LIMITS.resource}) NOT NULL,
  key_json VARCHAR(${RECORD_HISTORY_LIMITS.key}) NOT NULL,
  kind VARCHAR(8) NOT NULL CHECK (kind IN ('insert', 'update', 'delete')),
  changes_json MEDIUMTEXT NOT NULL,
  actor VARCHAR(${RECORD_HISTORY_LIMITS.actor}) NOT NULL,
  actor_name VARCHAR(${RECORD_HISTORY_LIMITS.actorName}) NOT NULL,
  via VARCHAR(16) NOT NULL CHECK (via IN ('app', 'workbench', 'agent', 'api', 'form', 'system')),
  action VARCHAR(${RECORD_HISTORY_LIMITS.action}) NOT NULL,
  KEY ${quote(RECORD_HISTORY_INDEX)} (resource(191), key_json(191), id),
  KEY ${quote(RECORD_HISTORY_AT_INDEX)} (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

/* name → [data type, max length or null]; every column is NOT NULL. */
const COLUMNS: Record<string, Record<string, [string, number | null]>> = {
  [meta]: { singleton: ['tinyint', null], version: ['int', null] },
  [change]: {
    id: ['bigint', null],
    write_id: ['varchar', 64],
    at: ['datetime', null],
    resource: ['varchar', RECORD_HISTORY_LIMITS.resource],
    key_json: ['varchar', RECORD_HISTORY_LIMITS.key],
    kind: ['varchar', 8],
    changes_json: ['mediumtext', null],
    actor: ['varchar', RECORD_HISTORY_LIMITS.actor],
    actor_name: ['varchar', RECORD_HISTORY_LIMITS.actorName],
    via: ['varchar', 16],
    action: ['varchar', RECORD_HISTORY_LIMITS.action],
  },
};
const INDEXES: Record<string, string[]> = {
  [meta]: ['PRIMARY:singleton'],
  [change]: ['PRIMARY:id', `${RECORD_HISTORY_AT_INDEX}:at`, `${RECORD_HISTORY_INDEX}:resource,key_json,id`],
};

/* The instant in `toISOString()` form, as the other engines hold it, and back: DATETIME(3) keeps UTC wall time, no zone. */
const toDatetime = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const AT_ISO = (alias: string) =>
  `CONCAT(DATE_FORMAT(${alias}.at, '%Y-%m-%dT%H:%i:%s.'), LPAD(MICROSECOND(${alias}.at) DIV 1000, 3, '0'), 'Z')`;

const rowsOf = (result: [unknown, unknown]) => (Array.isArray(result[0]) ? result[0] : []) as Array<Record<string, unknown>>;
const like = `${RECORD_HISTORY_PREFIX.replace(/_/g, '\\_')}%`;

export async function mysqlRecordHistoryReady(db: MysqlHistoryConnection, database: string): Promise<boolean> {
  try {
    const tables = rowsOf(
      await db.execute(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?`,
        [database, like],
      ),
    );
    if (
      tables.length !== 2 ||
      tables.some(
        (table) =>
          !Object.hasOwn(COLUMNS, String(table.name)) || table.type !== 'BASE TABLE' || String(table.engine).toLowerCase() !== 'innodb',
      )
    )
      return false;
    const columns = rowsOf(
      await db.execute(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable,
        CHARACTER_MAXIMUM_LENGTH AS length FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?`,
        [database, like],
      ),
    );
    for (const [table, expected] of Object.entries(COLUMNS)) {
      const actual = columns.filter((column) => column.tbl === table);
      if (
        actual.length !== Object.keys(expected).length ||
        actual.some((column) => {
          const want = expected[String(column.name)];
          return (
            !want ||
            String(column.type).toLowerCase() !== want[0] ||
            column.nullable !== 'NO' ||
            (want[1] !== null && Number(column.length) !== want[1])
          );
        })
      )
        return false;
    }
    const statistics = rowsOf(
      await db.execute(
        `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [database, like],
      ),
    );
    for (const [table, expected] of Object.entries(INDEXES)) {
      const named = new Map<string, string[]>();
      for (const row of statistics.filter((item) => item.tbl === table))
        named.set(String(row.name), [...(named.get(String(row.name)) ?? []), String(row.col)]);
      const actual = [...named].map(([name, cols]) => `${name}:${cols.join(',')}`).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) return false;
    }
    const triggers = rowsOf(
      await db.execute(`SELECT 1 FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE LIKE ? LIMIT 1`, [
        database,
        like,
      ]),
    );
    if (triggers.length) return false;
    const version = rowsOf(await db.execute(`SELECT singleton, version FROM ${at(database, meta)}`));
    return version.length === 1 && Number(version[0].singleton) === 1 && Number(version[0].version) === RECORD_HISTORY_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance on the database a URL names; idempotent; a foreign layout is refused unchanged. */
export async function provisionMysqlRecordHistory(url: string): Promise<{ version: typeof RECORD_HISTORY_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^(mysql|mariadb):\/\//i.test(url))
    throw new Refusal('Record history provisioning requires a mysql:// URL.');
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as {
    createConnection?: (options: unknown) => Promise<MysqlHistoryConnection & { end(): Promise<void> }>;
    default?: { createConnection?: (options: unknown) => Promise<MysqlHistoryConnection & { end(): Promise<void> }> };
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find a createConnection export in the "mysql2" package.');
  const db = await createConnection({ uri: url.replace(/^mariadb:/i, 'mysql:'), multipleStatements: false });
  try {
    const current = rowsOf(await db.query('SELECT DATABASE() AS db'))[0]?.db;
    if (typeof current !== 'string' || !current) throw new Refusal('Record history provisioning needs a URL that names a database.');
    // One operator at a time: the existence check and the DDL (which MySQL
    // commits implicitly) must not interleave with another provisioning run.
    const locked = rowsOf(await db.query('SELECT GET_LOCK(?, 30) AS held', ['mistri.record-history.provision']))[0]?.held;
    if (Number(locked) !== 1) throw new Refusal('Another record history provisioning is running on this server.');
    try {
      const present = rowsOf(
        await db.execute(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? LIMIT 1`, [current, like]),
      );
      let provisioned = false;
      if (!present.length) {
        for (const ddl of definitions(current)) await db.query(ddl);
        await db.execute(`INSERT INTO ${at(current, meta)} (singleton, version) VALUES (1, ?)`, [RECORD_HISTORY_VERSION]);
        provisioned = true;
      }
      if (!(await mysqlRecordHistoryReady(db, current))) throw new RecordHistoryUnavailable(await layoutMessage(db, current));
      return { version: RECORD_HISTORY_VERSION, provisioned };
    } finally {
      await db.query('SELECT RELEASE_LOCK(?)', ['mistri.record-history.provision']).catch(() => {});
    }
  } finally {
    await db.end().catch(() => {});
  }
}

/** One row, on the business write's connection, inside its transaction. */
export async function appendMysqlRecordChange(db: MysqlHistoryConnection, database: string, row: RecordChangeRow): Promise<void> {
  const changes = assertChangeRow(row);
  await db.execute(
    `INSERT INTO ${at(database, change)} (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.writeId, toDatetime(row.at), row.resource, row.key, row.kind, changes, row.actor, row.actorName, row.via, row.action],
  );
}

/** One record's rows, newest first, since its key was last deleted (see the SQLite read). */
export async function readMysqlRecordHistory(
  db: MysqlHistoryConnection,
  database: string,
  query: RecordHistoryQuery,
): Promise<StoredRecordChange[]> {
  assertHistoryQuery(query);
  if (!(await mysqlRecordHistoryReady(db, database))) throw new RecordHistoryUnavailable(await layoutMessage(db, database));
  const table = at(database, change);
  // LIMIT as digits: mysql2's prepared protocol refuses a bound LIMIT on some servers.
  const rows = rowsOf(
    await db.execute(
      `SELECT CAST(c.id AS CHAR) AS id, c.write_id, ${AT_ISO('c')} AS at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM ${table} c
    WHERE resource = ? AND key_json = ?
      AND id > COALESCE((SELECT MAX(d.id) FROM ${table} d WHERE d.resource = ? AND d.key_json = ? AND d.kind = 'delete'), 0)
      ${query.before === undefined ? '' : 'AND id < ?'}
    ORDER BY c.id DESC LIMIT ${Math.trunc(query.limit)}`,
      [query.resource, query.key, query.resource, query.key, ...(query.before === undefined ? [] : [query.before])],
    ),
  );
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

/** A feed's rows across resources, newest first (see the SQLite read). */
export async function readMysqlRecordActivity(
  db: MysqlHistoryConnection,
  database: string,
  query: RecordActivityQuery,
): Promise<StoredRecordChange[]> {
  assertActivityQuery(query);
  // A tenant App serves SQLite and PostgreSQL alone: no MySQL feed is ever one tenant's.
  if (query.owners) throw new Refusal('Invalid record activity read.');
  if (!(await mysqlRecordHistoryReady(db, database))) throw new RecordHistoryUnavailable(await layoutMessage(db, database));
  const table = at(database, change);
  // LIMIT as digits: mysql2's prepared protocol refuses a bound LIMIT on some servers.
  const rows = rowsOf(
    await db.execute(
      `SELECT CAST(c.id AS CHAR) AS id, c.write_id, ${AT_ISO('c')} AS at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM ${table} c
    WHERE c.resource IN (${query.resources.map(() => '?').join(', ')}) AND c.kind <> 'delete'
      ${query.from === undefined ? '' : 'AND c.at >= ?'} ${query.to === undefined ? '' : 'AND c.at < ?'} ${query.after === undefined ? '' : 'AND c.id > ?'}
      AND NOT EXISTS (SELECT 1 FROM ${table} d WHERE d.resource = c.resource AND d.key_json = c.key_json AND d.kind = 'delete' AND d.id > c.id)
    ORDER BY c.id ${query.after === undefined ? 'DESC' : 'ASC'} LIMIT ${Math.trunc(query.limit)}`,
      [
        ...query.resources,
        ...(query.from === undefined ? [] : [toDatetime(query.from)]),
        ...(query.to === undefined ? [] : [toDatetime(query.to)]),
        ...(query.after === undefined ? [] : [query.after]),
      ],
    ),
  );
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
