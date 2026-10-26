/**
 * Where an App's sessions live: a SQLite file of mistri's own, or a
 * PostgreSQL database named by a `postgres://` URL in the same manifest
 * field (`auth.store`). Better Auth is handed whichever this opens; what
 * differs is how the layout is brought up and what the server can observe
 * synchronously afterwards.
 *
 * The file store keeps its behaviour: created on first start, migrated by
 * Better Auth itself before sign-in is accepted (its own tables; a store of
 * another mistri layout version is refused first), and read directly by the
 * tenant binding's synchronous lookups. The PostgreSQL store is attested at
 * start and never migrated implicitly — `migratePostgresAuthStore` is the
 * maintenance step, as the command journal's is — and offers no synchronous
 * lookups, so it does not carry a tenant binding.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  attestPostgresAuthStore,
  AuthStoreUnavailable,
  POSTGRES_AUTH_PREFIX,
  POSTGRES_AUTH_SEARCH_PATH,
} from '../../adapters/auth/postgresAuthStore.js';
import { SQLITE_AUTH_META_DDL, SQLITE_AUTH_META_TABLE, SQLITE_AUTH_STORE_VERSION } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { postgresPoolDefaults, type PgPool, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { transactionScoped } from '@mistriwork/engine/adapters/postgresPooler.js';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/** A `postgres://` or `postgresql://` URL selects the PostgreSQL store. */
export const isPostgresAuthStore = (store: string): boolean => POSTGRES_URL.test(store);

export interface AuthStoreHandle {
  readonly kind: 'sqlite' | 'postgres';
  /** For the startup log. A file is its path; a PostgreSQL store is a fixed
   * label, never its URL, whose every part may be an expanded `${NAME}`. */
  readonly label: string;
  /** What Better Auth is given as `database`. */
  readonly database: unknown;
  /** Bring the layout to the one this build expects (file) or attest it (PostgreSQL). */
  readonly prepare: (migrate: () => Promise<void>) => Promise<void>;
  /** The open handle for the tenant binding's synchronous observations; the file store only. */
  readonly file?: DatabaseSync;
  /** Idempotent. */
  readonly close: () => void;
}

/**
 * Before Better Auth touches the file. Unlike the other stores, this one is
 * migrated at start: Better Auth owns these tables and makes them itself, so
 * the version row is written at that same point, for a new file. Only a
 * version row that says another version is refused, unchanged. Returns whether the file needs its row once Better Auth has run.
 * (`mistri migrate stores up` adds the row offline too.)
 */
function checkSqliteAuthStore(db: DatabaseSync): boolean {
  const catalog = db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema').all() as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];
  const refuse = (found: number | null) => {
    const message = layoutRefusal('The SQLite authentication store', found, SQLITE_AUTH_STORE_VERSION);
    if (message) throw new AuthStoreUnavailable(message);
  };
  if (catalog.some((entry) => entry.type === 'table' && entry.name === SQLITE_AUTH_META_TABLE)) {
    refuse(sqliteLayoutVersion(db, SQLITE_AUTH_META_TABLE));
    return false;
  }
  return true;
}

/** After Better Auth has made the tables of a new store (see checkSqliteAuthStore). */
function markSqliteAuthStore(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SQLITE_AUTH_META_DDL);
    db.prepare(`INSERT INTO "${SQLITE_AUTH_META_TABLE}" (singleton, version) VALUES (1, ?)`).run(SQLITE_AUTH_STORE_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function openSqliteAuthStore(path: string, fence: () => void): AuthStoreHandle {
  fence();
  mkdirSync(dirname(path), { recursive: true });
  fence();
  const database = new DatabaseSync(path);
  let closed = false;
  return {
    kind: 'sqlite',
    label: path,
    database,
    file: database,
    prepare: async (migrate) => {
      fence();
      const created = checkSqliteAuthStore(database);
      await migrate();
      if (created) markSqliteAuthStore(database);
      fence();
    },
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

type ClientClass = new (options: Record<string, unknown>) => PgQuery;
interface PoolModule {
  Pool?: new (options: Record<string, unknown>) => PgPool;
  Client?: ClientClass;
  default?: PoolModule;
}

/** A statement's cap on the store, on a session or in each transaction. */
const AUTH_STATEMENT_CAP_MS = 30_000;

/**
 * The driver's client, made safe behind a transaction-mode pooler: every
 * statement runs in a transaction that sets the store's search path and cap
 * with `SET LOCAL` (postgresPooler.ts), whether Better Auth's Kysely adapter,
 * pg-pool's own `pool.query` or the platform's observers sent it. A query
 * with a callback, as pg-pool's is, is answered through it.
 */
function transactionPooledClient(Client: ClientClass): ClientClass {
  return class extends (Client as new (options: Record<string, unknown>) => PgQuery) {
    #scoped = transactionScoped(
      { query: (request: unknown, params?: unknown) => super.query(request as string, params as unknown[]) } as PgQuery,
      {
        role: 'write',
        capMs: AUTH_STATEMENT_CAP_MS,
        untrusted: false,
        searchPath: POSTGRES_AUTH_SEARCH_PATH,
      },
    );
    override query(...args: unknown[]): never {
      const done = typeof args.at(-1) === 'function' ? (args.pop() as (error: unknown, result?: unknown) => void) : undefined;
      const request = args[0];
      /* A submittable (a cursor, a stream) runs on the session as the driver
         schedules it, outside any transaction this could open. */
      if (request && typeof request === 'object' && typeof (request as { submit?: unknown }).submit === 'function')
        throw new Error('The authentication store does not stream behind a transaction-mode pooler.');
      const pending = (this.#scoped.query as (request: unknown, params?: unknown) => Promise<unknown>)(request, args[1]);
      if (!done) return pending as never;
      pending.then(
        (result) => done(null, result),
        (error: unknown) => done(error),
      );
      return undefined as never;
    }
  } as unknown as ClientClass;
}

export async function openPostgresAuthStore(url: string): Promise<AuthStoreHandle> {
  const specifier = 'pg';
  const pg = (await import(specifier).catch(() => {
    throw new Error('A postgres:// authentication store needs the "pg" package. Install it with: npm install pg');
  })) as PoolModule;
  const Pool = pg.Pool ?? pg.default?.Pool;
  const Client = pg.Client ?? pg.default?.Client;
  if (!Pool || !Client) throw new Error('Could not find the Pool and Client exports in the "pg" package.');
  /* `search_path` is the whole of how Better Auth's unqualified table names
     land in the runtime schema; `public` is deliberately not on it, and
     `pg_catalog` is named first (see POSTGRES_AUTH_SEARCH_PATH). It was a
     startup `options` parameter until rc.1, which PgBouncer refuses or drops
     rather than carry to the server: behind it every Better Auth statement
     ran on the server's default path and failed with `relation "auth_user"
     does not exist`. On a
     session of our own, direct or through a session-mode pooler, it is set
     once as the client connects. Behind a transaction-mode pooler
     (`--pooler transaction`) nothing is set on a session, since a session
     setting stays on whichever server connection the pooler lent and
     follows it to the pooler's next client: each statement carries the path
     and the cap in its own transaction, as the App's pools do. Small and
     short-lived: sign-in traffic is a few statements per request. */
  const pooled = postgresPoolDefaults().pooler === 'transaction';
  const pool = new Pool({
    ...pgConnectionOptions(url),
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(pooled ? { Client: transactionPooledClient(Client) } : {}),
    onConnect: async (client: { query(text: string): Promise<unknown>; on(event: 'error', listener: () => void): unknown }) => {
      /* An idle client's error is the pool's to hear; a leased one's is its
         own. When the store's backends are ended under a lease (a failover,
         an administrator's pg_terminate_backend), node-postgres emits 'error'
         on that client, and an 'error' nobody hears ends the process — every
         App's sign-in and API with it. The query the client was running
         rejects with the same failure, and is answered there, as the store
         being unavailable. */
      client.on('error', () => {});
      if (!pooled) await client.query(`SET search_path TO ${POSTGRES_AUTH_SEARCH_PATH}; SET statement_timeout = ${AUTH_STATEMENT_CAP_MS}`);
    },
  });
  pool.on('error', () => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void pool.end().catch(() => {});
  };
  try {
    await attestPostgresAuthStore(pool);
  } catch (error) {
    close();
    throw error;
  }
  return {
    kind: 'postgres',
    label: `postgresql auth store (the ${POSTGRES_AUTH_PREFIX} tables in schema ${RUNTIME_SCHEMA})`,
    database: pool,
    /* Attested, not migrated: Better Auth's own migration is not run here.
       The layout it would plan against is exactly the one just attested. */
    prepare: async () => {
      await attestPostgresAuthStore(pool);
    },
    close,
  };
}
