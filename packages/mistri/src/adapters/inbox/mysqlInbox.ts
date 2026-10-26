/**
 * Notifications on MySQL and MariaDB: the same two tables, in the database
 * the connection's URL names, on InnoDB so a notice commits or rolls back
 * with the write that sent it. Attested structurally, as the record
 * history's is: every column's name, type and nullability, the engine, the
 * indexes, and no trigger or other relation under the prefix.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
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

/** The part of a mysql2 connection this module speaks through. */
interface MysqlInboxConnection {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

const { meta, notice, mail, optout } = INBOX_TABLES;
const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const at = (database: string, table: string) => `${quote(database)}.${quote(table)}`;
/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). */
async function layoutMessage(db: MysqlInboxConnection, database: string): Promise<string | undefined> {
  try {
    const [rows] = await db.execute(`SELECT version FROM ${at(database, meta)}`);
    return layoutRefusal('The notification store', versionOfRows(Array.isArray(rows) ? rows : []), INBOX_VERSION);
  } catch {
    return undefined;
  }
}

const definitions = (database: string): string[] => [
  `CREATE TABLE ${at(database, meta)} (
  singleton TINYINT NOT NULL PRIMARY KEY CHECK (singleton = 1),
  version INT NOT NULL CHECK (version = ${INBOX_VERSION})
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${at(database, notice)} (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app VARCHAR(${INBOX_LIMITS.app}) NOT NULL,
  recipient VARCHAR(${INBOX_LIMITS.recipient}) NOT NULL,
  at VARCHAR(40) NOT NULL,
  resource VARCHAR(${INBOX_LIMITS.resource}) NOT NULL,
  key_json VARCHAR(${INBOX_LIMITS.key}) NOT NULL,
  title VARCHAR(${INBOX_LIMITS.title}) NOT NULL,
  uses_json TEXT NOT NULL,
  actor VARCHAR(${INBOX_LIMITS.actor}) NOT NULL,
  actor_name VARCHAR(${INBOX_LIMITS.actorName}) NOT NULL,
  action VARCHAR(${INBOX_LIMITS.action}) NOT NULL,
  read_at VARCHAR(40) NULL,
  KEY ${quote(INBOX_INDEX)} (app, recipient(191), id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${at(database, mail)} (
  notice BIGINT NOT NULL PRIMARY KEY,
  state VARCHAR(16) NOT NULL,
  attempts INT NOT NULL,
  due_at VARCHAR(40) NOT NULL,
  last_error VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE ${at(database, optout)} (
  holder VARCHAR(64) NOT NULL PRIMARY KEY,
  at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

/* name → [data type, max length or null, nullable]. */
const COLUMNS: Record<string, Record<string, [string, number | null, boolean?]>> = {
  [meta]: { singleton: ['tinyint', null], version: ['int', null] },
  [notice]: {
    id: ['bigint', null],
    app: ['varchar', INBOX_LIMITS.app],
    recipient: ['varchar', INBOX_LIMITS.recipient],
    at: ['varchar', 40],
    resource: ['varchar', INBOX_LIMITS.resource],
    key_json: ['varchar', INBOX_LIMITS.key],
    title: ['varchar', INBOX_LIMITS.title],
    uses_json: ['text', null],
    actor: ['varchar', INBOX_LIMITS.actor],
    actor_name: ['varchar', INBOX_LIMITS.actorName],
    action: ['varchar', INBOX_LIMITS.action],
    read_at: ['varchar', 40, true],
  },
  [mail]: {
    notice: ['bigint', null],
    state: ['varchar', 16],
    attempts: ['int', null],
    due_at: ['varchar', 40],
    last_error: ['varchar', 500, true],
  },
  [optout]: { holder: ['varchar', 64], at: ['varchar', 40] },
};
const INDEXES: Record<string, string[]> = {
  [meta]: ['PRIMARY:singleton'],
  [notice]: ['PRIMARY:id', `${INBOX_INDEX}:app,recipient,id`],
  [mail]: ['PRIMARY:notice'],
  [optout]: ['PRIMARY:holder'],
};

const rowsOf = (result: [unknown, unknown]) => (Array.isArray(result[0]) ? result[0] : []) as Array<Record<string, unknown>>;
const like = `${INBOX_PREFIX.replace(/_/g, '\\_')}%`;

export async function mysqlInboxReady(db: MysqlInboxConnection, database: string): Promise<boolean> {
  try {
    const tables = rowsOf(
      await db.execute(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?`,
        [database, like],
      ),
    );
    if (
      tables.length !== Object.keys(COLUMNS).length ||
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
    return version.length === 1 && Number(version[0].singleton) === 1 && Number(version[0].version) === INBOX_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance on the database a URL names; idempotent; a foreign layout is refused unchanged. */
export async function provisionMysqlInbox(url: string): Promise<{ version: typeof INBOX_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^(mysql|mariadb):\/\//i.test(url))
    throw new Refusal('Notification store provisioning requires a mysql:// URL.');
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as {
    createConnection?: (options: unknown) => Promise<MysqlInboxConnection & { end(): Promise<void> }>;
    default?: { createConnection?: (options: unknown) => Promise<MysqlInboxConnection & { end(): Promise<void> }> };
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find a createConnection export in the "mysql2" package.');
  const db = await createConnection({ uri: url.replace(/^mariadb:/i, 'mysql:'), multipleStatements: false });
  try {
    const current = rowsOf(await db.query('SELECT DATABASE() AS db'))[0]?.db;
    if (typeof current !== 'string' || !current) throw new Refusal('Notification store provisioning needs a URL that names a database.');
    // One operator at a time: MySQL commits DDL implicitly, so the check and the create must not interleave.
    const locked = rowsOf(await db.query('SELECT GET_LOCK(?, 30) AS held', ['mistri.inbox.provision']))[0]?.held;
    if (Number(locked) !== 1) throw new Refusal('Another notification store provisioning is running on this server.');
    try {
      const present = rowsOf(
        await db.execute(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? LIMIT 1`, [current, like]),
      );
      let provisioned = false;
      if (!present.length) {
        for (const ddl of definitions(current)) await db.query(ddl);
        await db.execute(`INSERT INTO ${at(current, meta)} (singleton, version) VALUES (1, ?)`, [INBOX_VERSION]);
        provisioned = true;
      }
      if (!(await mysqlInboxReady(db, current))) throw new InboxUnavailable(await layoutMessage(db, current));
      return { version: INBOX_VERSION, provisioned };
    } finally {
      await db.query('SELECT RELEASE_LOCK(?)', ['mistri.inbox.provision']).catch(() => {});
    }
  } finally {
    await db.end().catch(() => {});
  }
}

/** One notice, on the business write's connection, inside its transaction — and its place in the outbox when it is emailed too. */
export async function appendMysqlNotice(db: MysqlInboxConnection, database: string, row: NoticeRow): Promise<void> {
  const uses = assertNoticeRow(row);
  const [written] = await db.execute(
    `INSERT INTO ${at(database, notice)} (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.app, row.recipient, row.at, row.resource, row.key, row.title, uses, row.actor, row.actorName, row.action],
  );
  if (row.email) {
    await db.execute(`INSERT INTO ${at(database, mail)} (notice, state, attempts, due_at, last_error) VALUES (?, 'queued', 0, ?, NULL)`, [
      String((written as { insertId?: number | string }).insertId),
      row.at,
    ]);
  }
}

/** One person's notices in one App, newest first. */
export async function readMysqlInbox(db: MysqlInboxConnection, database: string, query: InboxQuery): Promise<StoredNotice[]> {
  assertInboxQuery(query);
  if (!(await mysqlInboxReady(db, database))) throw new InboxUnavailable(await layoutMessage(db, database));
  // LIMIT as digits: mysql2's prepared protocol refuses a bound LIMIT on some servers.
  const rows = rowsOf(
    await db.execute(
      `SELECT CAST(id AS CHAR) AS id, app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action, read_at
    FROM ${at(database, notice)} WHERE app = ? AND recipient = ?
      ${query.unread ? 'AND read_at IS NULL' : ''} ${query.before === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ${Math.trunc(query.limit)}`,
      [query.app, query.recipient, ...(query.before === undefined ? [] : [query.before])],
    ),
  );
  return rows.map(storedNotice);
}

/** Mark one person's notices read — the ids given, or all of them — and never anyone else's. */
export async function markMysqlInboxRead(db: MysqlInboxConnection, database: string, mark: InboxMark): Promise<number> {
  assertInboxMark(mark);
  if (!(await mysqlInboxReady(db, database))) throw new InboxUnavailable(await layoutMessage(db, database));
  const ids = mark.ids ?? [];
  const [result] = await db.execute(
    `UPDATE ${at(database, notice)} SET read_at = ? WHERE app = ? AND recipient = ? AND read_at IS NULL
    ${ids.length ? `AND id IN (${ids.map(() => '?').join(', ')})` : ''}`,
    [mark.at, mark.app, mark.recipient, ...ids],
  );
  return Number((result as { affectedRows?: number })?.affectedRows ?? 0);
}

/** The outbox on the writer, one statement shape for every engine (inboxMail.ts). */
export function mysqlInboxMail(
  database: string,
  through: <T>(work: (db: MysqlInboxConnection) => Promise<T>) => Promise<T>,
): InboxMailStore {
  return inboxMailStore(
    (name) => at(database, name),
    (work) =>
      through((db) =>
        work({
          all: async (sql, params) => rowsOf(await db.execute(sql, [...params])),
          run: async (sql, params) => Number(((await db.execute(sql, [...params]))[0] as { affectedRows?: number })?.affectedRows ?? 0),
        }),
      ),
  );
}
