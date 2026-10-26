/**
 * The one connection a migration run holds, on each engine, and the lock that
 * keeps two deploys from migrating at once.
 *
 * Not the adapters: those read, through pools, in read-only transactions.
 * A migration writes DDL on one private connection and holds it for the run.
 *
 * - SQLite: node:sqlite, with foreign keys off as the SQLite manual's table
 *   rebuild asks and as Flyway's driver leaves them; each migration's
 *   transaction checks them before it commits instead. The lock is SQLite's
 *   own: every step is a `BEGIN IMMEDIATE` that re-reads the history.
 * - PostgreSQL: `pg`, a session advisory lock held for the run, on the number
 *   Flyway derives from the same history table, so tablewalk and Flyway
 *   exclude each other as well as themselves.
 * - MySQL: `mysql2` with multiple statements, since a file is sent whole and
 *   the server, not a splitter, reads its triggers; `GET_LOCK` for the run.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { postgresPoolDefaults } from '../../adapters/postgresPool.js';
import { pgConnectionOptions } from '../../adapters/postgresValues.js';
import { product } from '../product.js';

export type Dialect = 'sqlite' | 'postgres' | 'mysql';

export interface MigrationDb {
  readonly dialect: Dialect;
  /** Where the history lives: a PostgreSQL schema or MySQL database; none on SQLite. */
  readonly home: string | undefined;
  /** The account the history says installed a migration. */
  readonly user: string;
  /** A statement with `?` parameters, its rows. */
  all<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** A script's whole text, every statement in it. */
  script(sql: string): Promise<void>;
  /** Hold the run's lock (a no-op on SQLite, whose lock is each step's write transaction). */
  lock(table: string, waitMs: number, waiting: () => void): Promise<void>;
  close(): Promise<void>;
}

export const quoteIdent = (dialect: Dialect, name: string) =>
  dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** Java's String.hashCode, which Flyway's advisory lock number is built on. */
function javaHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash;
}

/** The advisory lock Flyway takes on PostgreSQL for this history table (PostgreSQLAdvisoryLockTemplate). */
export function flywayLockNumber(schema: string, table: string): bigint {
  return 77431708279161n + BigInt(javaHash(`${quoteIdent('postgres', schema)}.${quoteIdent('postgres', table)}`));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How long a PostgreSQL migration's statement waits for a lock before its file is rolled back and tried again. */
const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
/* What a migration needs from the session it runs on: its lock, held across
   the steps' transactions, and the --schema path. */
const SESSION_NEEDED =
  'a migration holds a session lock, which a transaction-mode pooler does not keep; run it on a URL that reaches PostgreSQL directly or through a session-mode pool';

export function dialectOf(url: string): Dialect {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  if (/^(mysql|mariadb):\/\//i.test(url)) return 'mysql';
  if (/^[a-z][\w+.-]*:\/\//i.test(url))
    throw new Error(product() + ' migrate runs on SQLite, PostgreSQL and MySQL; this connection is none of them.');
  return 'sqlite';
}

export const sqlitePath = (url: string) => url.replace(/^sqlite:(\/\/)?/i, '');

/**
 * Open the run's connection. `create` lets `up` start a SQLite file that is
 * not there yet (a fresh database migrated from nothing); every other command
 * refuses a path with nothing at it, which is a typo far more often.
 * `schemas` is the run's scope: on PostgreSQL the first is where the history
 * lives and the search path is set to them, as Flyway's `schemas` does.
 */
export async function openMigrationDb(url: string, schemas: readonly string[], create: boolean): Promise<MigrationDb> {
  const dialect = dialectOf(url);
  if (dialect === 'sqlite') {
    const path = sqlitePath(url);
    if (!create && !existsSync(path)) throw new Error(`there is no SQLite database at ${path}`);
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: false, timeout: 60_000 });
    return {
      dialect,
      home: undefined,
      user: '',
      async all<Row>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as Row[];
      },
      async run(sql, params = []) {
        db.prepare(sql).run(...(params as SQLInputValue[]));
      },
      async script(sql) {
        db.exec(sql);
      },
      async lock() {
        /* Each step's BEGIN IMMEDIATE is the lock. */
      },
      async close() {
        db.close();
      },
    };
  }
  if (dialect === 'postgres') {
    const specifier = 'pg';
    const pg = (await import(specifier).catch(() => {
      throw new Error('PostgreSQL support needs the "pg" package. Install it with: npm install pg');
    })) as {
      Client?: PgClientClass;
      default?: { Client?: PgClientClass };
    };
    const Client = pg.Client ?? pg.default?.Client;
    if (!Client) throw new Error('Could not find a Client export in the "pg" package.');
    const client = new Client({ ...pgConnectionOptions(url), connectionTimeoutMillis: 15_000 });
    await client.connect().catch(() => {
      throw new Error('the PostgreSQL database could not be opened');
    });
    try {
      const [{ current, user }] = (await client.query('SELECT current_schema() AS current, current_user AS user')).rows as Array<{
        current: string | null;
        user: string;
      }>;
      const home = schemas[0] ?? current;
      if (!home) throw new Error('the connection has no current schema (an empty search_path): name one with --schema');
      /* Behind a transaction-mode pooler (`--pooler transaction`) a session
         setting stays on whichever server connection the pooler lent and
         follows it to the pooler's next client: the lock wait below would
         reach the App's own statements. The serve-time readers of the
         migration tables (the Console, governance, analytics provisioning)
         set nothing there; what needs the session refuses. */
      const pooled = postgresPoolDefaults().pooler === 'transaction';
      if (schemas.length) {
        if (pooled) throw new Error(SESSION_NEEDED);
        await client.query(`SET search_path TO ${schemas.map((schema) => quoteIdent('postgres', schema)).join(', ')}`);
      }
      /* A migration's DDL waits for the tables it changes, and while it waits
         every App statement on those tables queues behind it: an ALTER TABLE
         stuck behind one long transaction stops the App. So it gives up after
         MIGRATION_LOCK_TIMEOUT_MS and tries again (runner.ts apply). */
      if (!pooled) await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT_MS}ms'`);
      let held: bigint | undefined;
      const numbered = (sql: string) => {
        let n = 0;
        return sql.replace(/\?/g, () => `$${++n}`);
      };
      return {
        dialect,
        home,
        user,
        async all<Row>(sql: string, params: unknown[] = []) {
          return (await client.query(numbered(sql), params)).rows as Row[];
        },
        async run(sql, params = []) {
          await client.query(numbered(sql), params);
        },
        // The simple protocol: a script of many statements in one round trip.
        async script(sql) {
          await client.query(sql);
        },
        async lock(table, waitMs, waiting) {
          if (pooled) throw new Error(SESSION_NEEDED);
          const key = flywayLockNumber(home, table);
          const started = Date.now();
          let said = false;
          for (;;) {
            const [{ locked }] = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [String(key)])).rows as Array<{
              locked: boolean;
            }>;
            if (locked) {
              held = key;
              return;
            }
            if (Date.now() - started > waitMs)
              throw new Error(
                `another migration of ${home}.${table} has held its lock for ${Math.round(waitMs / 1000)}s; try again when it has finished`,
              );
            if (!said) {
              waiting();
              said = true;
            }
            await sleep(250);
          }
        },
        async close() {
          if (held !== undefined) await client.query('SELECT pg_advisory_unlock($1::bigint)', [String(held)]).catch(() => {});
          await client.end().catch(() => {});
        },
      };
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as {
    createConnection?: MysqlCreate;
    default?: { createConnection?: MysqlCreate };
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find a createConnection export in the "mysql2" package.');
  /* Several statements a call, on this connection alone: a migration file is
     SQL its author wrote to run, and the server reads a trigger's BEGIN … END
     where a splitter would guess. The adapters keep it off. */
  const client = await createConnection({
    uri: url,
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    connectTimeout: 15_000,
  }).catch(() => {
    throw new Error('the MySQL database could not be opened');
  });
  try {
    const [rows] = (await client.query("SELECT DATABASE() AS home, SUBSTRING_INDEX(USER(), '@', 1) AS user")) as [
      Array<{ home: string | null; user: string }>,
      unknown,
    ];
    const home = rows[0].home ?? schemas[0];
    if (!home) throw new Error('the MySQL URL names no database');
    let lockName: string | undefined;
    return {
      dialect,
      home,
      user: rows[0].user,
      async all<Row>(sql: string, params: unknown[] = []) {
        return (await client.query(sql, params))[0] as Row[];
      },
      async run(sql, params = []) {
        await client.query(sql, params);
      },
      async script(sql) {
        await client.query(sql);
      },
      async lock(table, waitMs, waiting) {
        // At most 64 characters, the server's limit for a lock's name.
        const name = `mistri-migrate:${createHash('sha256').update(`${home}.${table}`).digest('hex').slice(0, 40)}`;
        const [free] = (await client.query('SELECT IS_FREE_LOCK(?) AS free', [name])) as [Array<{ free: number }>, unknown];
        if (!free[0].free) waiting();
        const [got] = (await client.query('SELECT GET_LOCK(?, ?) AS got', [name, Math.ceil(waitMs / 1000)])) as [
          Array<{ got: number | null }>,
          unknown,
        ];
        if (got[0].got !== 1)
          throw new Error(
            `another migration of ${home}.${table} has held its lock for ${Math.round(waitMs / 1000)}s; try again when it has finished`,
          );
        lockName = name;
      },
      async close() {
        if (lockName) await client.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
        await client.end().catch(() => {});
      },
    };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

type PgClientClass = new (options: unknown) => {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
};
type MysqlCreate = (config: Record<string, unknown>) => Promise<{
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}>;

/**
 * A PostgreSQL script as its statements, for a file that must run outside a
 * transaction: `CREATE INDEX CONCURRENTLY` refuses a multi-statement query,
 * which PostgreSQL runs as one implicit transaction. Reads quotes, quoted
 * names, dollar quotes and both kinds of comment, and cuts at the semicolons
 * outside them.
 */
export function splitPostgres(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const escaped = c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/\w/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? n : end + tag[0].length;
        continue;
      }
    }
    if (c === ';') {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(sql.slice(start));
  return out
    .map((statement) => statement.trim())
    .filter((statement) => statement && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(statement));
}
