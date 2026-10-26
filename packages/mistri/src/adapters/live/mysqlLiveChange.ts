/**
 * Live sync's store on MySQL and MariaDB: the same two tables, in the
 * database the connection's URL names, on InnoDB so the row commits or rolls
 * back with the writes it describes. Attestation is structural, as record
 * history's is (../history/mysqlRecordHistory.ts).
 *
 * MySQL has neither NOTIFY nor a snapshot horizon a reader can ask for, so
 * an id is handed out at insert and commits land in any order. The hub reads
 * past the ids it has seen and keeps a gap open for a few seconds before it
 * gives up on it (server/live/liveSource.ts): a transaction still open past
 * that is late, never lost from the store, and a reconnect replays it.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
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

/** The part of a mysql2 connection this module speaks through. */
interface MysqlLiveConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

const { meta, change } = LIVE_CHANGE_TABLES;
const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const at = (database: string, table: string) => `${quote(database)}.${quote(table)}`;
async function layoutMessage(db: MysqlLiveConnection, database: string): Promise<string | undefined> {
  try {
    const [rows] = await db.execute(`SELECT version FROM ${at(database, meta)}`);
    return layoutRefusal('The live sync store', versionOfRows(Array.isArray(rows) ? rows : []), LIVE_CHANGE_VERSION);
  } catch {
    return undefined;
  }
}

const definitions = (database: string): string[] => [
  `CREATE TABLE ${at(database, meta)} (
  singleton TINYINT NOT NULL PRIMARY KEY CHECK (singleton = 1),
  version INT NOT NULL CHECK (version = ${LIVE_CHANGE_VERSION})
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${at(database, change)} (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at BIGINT NOT NULL,
  actor VARCHAR(${LIVE_CHANGE_LIMITS.actor}) NOT NULL,
  tenant VARCHAR(${LIVE_CHANGE_LIMITS.tenant}) NULL,
  entries_json MEDIUMTEXT NOT NULL,
  KEY ${quote(LIVE_CHANGE_INDEX)} (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

/* name → [data type, max length or null, nullable]. */
const COLUMNS: Record<string, Record<string, [string, number | null, boolean]>> = {
  [meta]: { singleton: ['tinyint', null, false], version: ['int', null, false] },
  [change]: {
    id: ['bigint', null, false],
    at: ['bigint', null, false],
    actor: ['varchar', LIVE_CHANGE_LIMITS.actor, false],
    tenant: ['varchar', LIVE_CHANGE_LIMITS.tenant, true],
    entries_json: ['mediumtext', null, false],
  },
};
const INDEXES: Record<string, string[]> = {
  [meta]: ['PRIMARY:singleton'],
  [change]: ['PRIMARY:id', `${LIVE_CHANGE_INDEX}:at`],
};

const rowsOf = (result: [unknown, unknown]) => (Array.isArray(result[0]) ? result[0] : []) as Array<Record<string, unknown>>;
const like = `${LIVE_CHANGE_PREFIX.replace(/_/g, '\\_')}%`;

export async function mysqlLiveChangeReady(db: MysqlLiveConnection, database: string): Promise<boolean> {
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
            column.nullable !== (want[2] ? 'YES' : 'NO') ||
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
    return version.length === 1 && Number(version[0].singleton) === 1 && Number(version[0].version) === LIVE_CHANGE_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance on the database a URL names; idempotent; a foreign layout is refused unchanged. */
export async function provisionMysqlLiveChange(url: string): Promise<{ version: typeof LIVE_CHANGE_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^(mysql|mariadb):\/\//i.test(url)) throw new Refusal('Live sync provisioning requires a mysql:// URL.');
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as {
    createConnection?: (options: unknown) => Promise<MysqlLiveConnection & { end(): Promise<void> }>;
    default?: { createConnection?: (options: unknown) => Promise<MysqlLiveConnection & { end(): Promise<void> }> };
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find a createConnection export in the "mysql2" package.');
  const db = await createConnection({ uri: url.replace(/^mariadb:/i, 'mysql:'), multipleStatements: false });
  try {
    const current = rowsOf(await db.query('SELECT DATABASE() AS db'))[0]?.db;
    if (typeof current !== 'string' || !current) throw new Refusal('Live sync provisioning needs a URL that names a database.');
    const locked = rowsOf(await db.query('SELECT GET_LOCK(?, 30) AS held', ['mistri.live-change.provision']))[0]?.held;
    if (Number(locked) !== 1) throw new Refusal('Another live sync provisioning is running on this server.');
    try {
      const present = rowsOf(
        await db.execute(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? LIMIT 1`, [current, like]),
      );
      let provisioned = false;
      if (!present.length) {
        for (const ddl of definitions(current)) await db.query(ddl);
        await db.execute(`INSERT INTO ${at(current, meta)} (singleton, version) VALUES (1, ?)`, [LIVE_CHANGE_VERSION]);
        provisioned = true;
      }
      if (!(await mysqlLiveChangeReady(db, current))) throw new LiveChangeUnavailable(await layoutMessage(db, current));
      return { version: LIVE_CHANGE_VERSION, provisioned };
    } finally {
      await db.query('SELECT RELEASE_LOCK(?)', ['mistri.live-change.provision']).catch(() => {});
    }
  } finally {
    await db.end().catch(() => {});
  }
}

/** One row, on the business write's connection, inside its transaction. */
export async function appendMysqlLiveChange(db: MysqlLiveConnection, database: string, row: LiveChangeRow): Promise<void> {
  const entries = assertLiveChangeRow(row);
  await db.execute(`INSERT INTO ${at(database, change)} (at, actor, tenant, entries_json) VALUES (?, ?, ?, ?)`, [
    row.at,
    row.actor,
    row.tenant,
    entries,
  ]);
}

/** The newest row's id, or 0. */
export async function mysqlLiveHead(db: MysqlLiveConnection, database: string): Promise<string> {
  const row = rowsOf(await db.execute(`SELECT CAST(max(id) AS CHAR) AS id FROM ${at(database, change)}`))[0];
  return row?.id === null || row?.id === undefined ? '0' : String(row.id);
}

/** Committed rows after `id` (and the ones named in `gaps`), oldest first, at most `limit`. */
export async function readMysqlLiveChanges(
  db: MysqlLiveConnection,
  database: string,
  after: string,
  limit: number,
  gaps: readonly string[] = [],
): Promise<StoredLiveChange[]> {
  const rows = rowsOf(
    await db.query(
      `SELECT CAST(id AS CHAR) AS id, at, actor, tenant, entries_json FROM ${at(database, change)}
      WHERE id > ?${gaps.length ? ` OR id IN (${gaps.map(() => '?').join(', ')})` : ''} ORDER BY id LIMIT ${Number(limit) | 0}`,
      [after, ...gaps],
    ),
  );
  return rows.map((row) =>
    Object.freeze({
      id: String(row.id),
      at: Number(row.at),
      actor: String(row.actor),
      tenant: typeof row.tenant === 'string' ? row.tenant : null,
      entries: parseLiveEntries(row.entries_json),
    }),
  );
}

/** Whether a cursor's row is still kept. */
export async function mysqlLiveKept(db: MysqlLiveConnection, database: string, id: string): Promise<boolean> {
  return rowsOf(await db.execute(`SELECT 1 AS found FROM ${at(database, change)} WHERE id = ?`, [id])).length === 1;
}

/** Rows older than `before` (ms), the newest always kept. */
export async function pruneMysqlLiveChanges(db: MysqlLiveConnection, database: string, before: number): Promise<number> {
  const [newest] = rowsOf(await db.execute(`SELECT max(id) AS id FROM ${at(database, change)}`));
  if (newest?.id === null || newest?.id === undefined) return 0;
  const [result] = await db.execute(`DELETE FROM ${at(database, change)} WHERE at < ? AND id < ?`, [before, newest.id]);
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}
