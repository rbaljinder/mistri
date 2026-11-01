/**
 * One tenant-source fixture per engine, so the tenant source suites run as a
 * dialect matrix: SQLite always, PostgreSQL when `TABLEWALK_TEST_PG` names a
 * disposable database (and required by `TABLEWALK_REQUIRE_LIVE=1`), like the
 * other live suites. A suite states its schema once per engine and writes its
 * tests once; where the engines honestly differ (a file path, a lock that
 * waits instead of failing) the test says so.
 *
 * Every engine has a control connection no source owns — the SQLite file's
 * own handle, or a plain pg client — for fixture DDL, outside edits and
 * membership maintenance.
 *
 * A tenant App's database holds only its declared resources and reserved
 * tables: every other visible table would join its catalog without an owner.
 * So the PostgreSQL engine does not use `TABLEWALK_TEST_PG` itself, which CI
 * seeds for other suites, but a database beside it on the same server — its
 * name with a suffix — created once if absent, so the role needs CREATEDB.
 * Before each test it drops every `__mistri_*` table and fixture table there.
 * Each suite names its own database, with a UUID in it, and drops it when it
 * ends: two runs on one server reset only their own tables, never each other's.
 */
import { randomUUID } from 'node:crypto';
import { postgresRuntimeSql } from './runtimeSql.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  describePostgresRelations,
  migratePostgresCommandJournal,
} from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { PostgresAdapter } from '../../packages/engine/src/adapters/postgres.js';
import { PgConnectionManager, type PgQuery } from '../../packages/engine/src/adapters/postgresPool.js';
import { readSqliteReadCatalog } from '../../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { SqliteAdapter } from '../../packages/engine/src/adapters/sqlite.js';
import type { TenantMembershipLookup, TenantMembershipRecord } from '../../packages/mistri/src/server/tenant/tenantMembership.js';
import type { TenantOwnershipSnapshot } from '../../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  openPostgresTenantReadSource,
  openSqliteTenantReadSource,
  type TenantReadSource,
} from '../../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  readSqliteTenantMembership,
  type TenantStoreAdministration,
  type TenantStoreBinding,
} from '../../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
  readPostgresTenantMembership,
} from '../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import {
  openPostgresTenantWriteSource,
  openSqliteTenantWriteSource,
  type TenantWriteSource,
} from '../../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { DatabaseSchema } from '../../packages/engine/src/shared/schema.js';
import { liveSkip } from '../live.js';

export type TenantDialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;

/** The engines a matrix suite runs on, each with its node:test skip. */
export const TENANT_DIALECTS: ReadonlyArray<{ readonly dialect: TenantDialect; readonly skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

/* Every table any tenant matrix suite creates. A suite's own database is
   reused across its own fixtures, so each PostgreSQL reset drops them all: a
   leftover table from an earlier fixture would otherwise be part of the next
   one's catalog. */
const FIXTURE_TABLES = [
  'lead_co_applicant',
  'intake_co_applicant',
  'db_child',
  'db_parent',
  'db_local_child',
  'db_local',
  'db_note',
  'db_item',
  'db_person',
  'db_hidden',
  'db_fixed',
  'db_country',
  'db_review',
  'db_lead',
  'db_dealer',
  'unknown_business',
  'review_file',
  'intake_submission',
  'lead',
  'vehicle',
  'vehicle_model',
  'dealer',
];

/** A nondeterministic ICU collation on PostgreSQL, the counterpart of SQLite's
 * NOCASE: `=` under it ignores case. Created once, never dropped. */
export const CASE_INSENSITIVE = 'tablewalk_fixture_ci';

export interface Statement {
  readonly sql: string;
  readonly writer: boolean;
}
export interface Interception {
  readonly calls: number;
  restore(): void;
}
export interface InterceptOptions {
  /** Which statements, on connections the sources own — never the control one. */
  match(statement: Statement): boolean;
  /** Throw before the statement runs, or run it and then throw: a lost
   * acknowledgement. Without a fault, run it and then call `after`. */
  fault?: 'before' | 'after';
  after?(): void;
}

export interface TenantEngine {
  readonly dialect: TenantDialect;
  /** SQLite's file, for the tests that are about a file. */
  readonly path: string;
  /** PostgreSQL's dedicated database, for the tests that are about a URL. */
  readonly url: string;
  /** The writer's opening statement as the engine's adapter sends it. */
  readonly begin: string;
  /** A fixture table's physical ID as the adapter names it. */
  id(name: string): string;
  /** Run SQL on the control connection. `?` placeholders; none in literals. */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  all(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  get(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown> | undefined>;
  /** The catalog as the tenant sources read it on this engine. */
  physicalSchema(): Promise<DatabaseSchema>;
  /** The ordinary adapter's introspection. */
  introspect(): Promise<DatabaseSchema>;
  provisionStore(binding: TenantStoreBinding): Promise<void>;
  migrateCommandJournal(): Promise<unknown>;
  /** The reserved layout under a prefix, to show a refusal changed nothing. */
  layout(prefix: string): Promise<unknown>;
  maintenance(binding: TenantStoreBinding, run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  readMembership(binding: TenantStoreBinding, lookup: TenantMembershipLookup): Promise<TenantMembershipRecord | null>;
  /** `trustFor`: how long a PostgreSQL catalog attestation stands (openPostgresTenantReadSource). Zero unless a case
      says otherwise, so every read here reads the digest, which is what the reattestation cases prove; the window has
      cases of its own. */
  openRead(
    ownership: TenantOwnershipSnapshot,
    binding: TenantStoreBinding,
    now?: () => number,
    trustFor?: number,
  ): Promise<TenantReadSource>;
  openWrite(ownership: TenantOwnershipSnapshot, binding: TenantStoreBinding, now?: () => number): Promise<TenantWriteSource>;
  /** Faults or observes statements on source connections until restored (or the test ends). */
  intercept(t: TestContext, options: InterceptOptions): Interception;
  /** PostgreSQL only: a further plain connection, for a statement that must wait
   * on a lock while the control connection stays free. Closed with the engine. */
  session(): Promise<PgQuery>;
  /** SQLite only: the control handle, for the tests that are about SQLite itself. */
  sqlite(): DatabaseSync;
  close(): Promise<void>;
}

const intercepted = () => new Error('PRIVATE_SENTINEL: intercepted statement');

/* ---------- SQLite ---------- */

function sqliteEngine(setup: string): TenantEngine {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-dialect-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  db.exec(setup);
  const params = (values: readonly unknown[] = []) => values as never[];
  return {
    dialect: 'sqlite',
    path,
    url: '',
    begin: 'BEGIN IMMEDIATE',
    id: (name) => name,
    async exec(sql, values) {
      if (values) db.prepare(sql).run(...params(values));
      else db.exec(sql);
    },
    async all(sql, values) {
      return db
        .prepare(sql)
        .all(...params(values))
        .map((row) => ({ ...row }));
    },
    async get(sql, values) {
      const row = db.prepare(sql).get(...params(values));
      return row ? { ...row } : undefined;
    },
    async physicalSchema() {
      db.exec('BEGIN');
      try {
        return readSqliteReadCatalog(db).schema;
      } finally {
        db.exec('COMMIT');
      }
    },
    async introspect() {
      const adapter = new SqliteAdapter(path);
      try {
        return await adapter.introspect();
      } finally {
        await adapter.close();
      }
    },
    async provisionStore(binding) {
      provisionSqliteTenantStore(path, binding);
    },
    async migrateCommandJournal() {
      return migrateSqliteCommandJournal(path);
    },
    async layout(prefix) {
      return db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, ?) = ? ORDER BY name')
        .all(prefix.length, prefix)
        .map((row) => ({ ...row }));
    },
    async maintenance(binding, run) {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, binding));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    async readMembership(binding, lookup) {
      return readSqliteTenantMembership(db, binding, lookup);
    },
    async openRead(ownership, binding, now) {
      return openSqliteTenantReadSource(path, ownership, binding, now);
    },
    openWrite: (ownership, binding, now) => openSqliteTenantWriteSource(path, ownership, binding, now),
    intercept(t, options) {
      const exec = DatabaseSync.prototype.exec,
        prepare = DatabaseSync.prototype.prepare;
      const writers = new WeakSet<DatabaseSync>();
      let calls = 0;
      const handle = <T>(self: DatabaseSync, sql: string, run: () => T): T => {
        if (self === db) return run();
        if (sql === 'BEGIN IMMEDIATE') writers.add(self);
        if (!options.match({ sql, writer: writers.has(self) })) return run();
        calls++;
        if (options.fault === 'before') throw intercepted();
        const result = run();
        if (options.fault === 'after') throw intercepted();
        options.after?.();
        return result;
      };
      const mocks = [
        t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
          return handle(this, sql, () => exec.call(this, sql));
        }),
        t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
          return handle(this, sql, () => prepare.call(this, sql));
        }),
      ];
      return {
        get calls() {
          return calls;
        },
        restore() {
          for (const mock of mocks) mock.mock.restore();
        },
      };
    },
    session: () => Promise.reject(new Error('A SQLite fixture has no further session.')),
    sqlite: () => db,
    async close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* ---------- PostgreSQL ---------- */

export interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
/** A database one test owns, named by a UUID beside TABLEWALK_TEST_PG (the role
 * needs CREATEDB), and a drop that ends every session still using it. */
export async function uuidPostgresDatabase(prefix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!/^[a-z][a-z0-9_]{0,22}$/.test(prefix) || !LIVE)
    throw new Error('A UUID PostgreSQL database needs TABLEWALK_TEST_PG and a plain prefix.');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = await pgClient(LIVE);
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(LIVE);
  url.pathname = `/${name}`;
  let dropped = false;
  return {
    url: url.href,
    drop: async () => {
      if (dropped) return;
      const dropper = await pgClient(LIVE);
      /* Marked dropped only once the drop has actually happened. Setting the flag
       first made the guard mean "someone has tried" rather than "it is gone",
       so a drop that threw — a refused connection, a server at its connection
       limit — was never retried and left a database behind under a UUID name
       no later run can recognise as garbage. The whole parallel lane rests on
       every fixture cleaning up after itself, so a silent failure here is the
       expensive kind. A second call after a success is still a no-op, and two
       calls that race only cost a redundant DROP ... IF EXISTS. */
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        dropped = true;
      } finally {
        await dropper.end();
      }
    },
  };
}
export async function pgClient(url: string): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  // A connect or reply that never comes fails the test instead of keeping its process alive (a stalled file once
  // held the whole gate for 42 minutes).
  const created = new Client({
    connectionString: url,
    statement_timeout: 10_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await created.connect();
  return created;
}

const dedicated = new Map<string, Promise<string>>();
/** The URL of a database beside `TABLEWALK_TEST_PG`, named with `suffix`,
 * created on first use. Same server, same credentials. */
export function dedicatedPostgresUrl(suffix: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(suffix) || !LIVE)
    return Promise.reject(new Error('A dedicated PostgreSQL database needs TABLEWALK_TEST_PG and a plain suffix.'));
  let pending = dedicated.get(suffix);
  if (!pending) {
    pending = (async () => {
      const url = new URL(LIVE),
        name = `${decodeURIComponent(url.pathname.slice(1)) || 'postgres'}_${suffix}`;
      if (!/^[A-Za-z0-9_]{1,63}$/.test(name)) throw new Error('TABLEWALK_TEST_PG names a database this suite cannot extend.');
      const admin = await pgClient(LIVE);
      try {
        if (!(await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [name])).rows.length) {
          await admin.query(`CREATE DATABASE "${name}"`).catch((error: { code?: string }) => {
            if (error.code !== '42P04') throw error;
          });
        }
      } finally {
        await admin.end();
      }
      url.pathname = `/${name}`;
      return url.toString();
    })();
    dedicated.set(suffix, pending);
  }
  return pending;
}
/** Drops a database `dedicatedPostgresUrl` created for one run. Only a suffix
 * ending in a UUID's 32 hex digits is accepted, so a name that is not one
 * run's own can never be dropped from under another run. */
export async function dropDedicatedPostgresDatabase(suffix: string): Promise<void> {
  if (!/^[a-z0-9_]*_[0-9a-f]{32}$/.test(suffix) || !LIVE)
    throw new Error('Only a UUID-suffixed dedicated PostgreSQL database may be dropped.');
  const url = new URL(LIVE),
    name = `${decodeURIComponent(url.pathname.slice(1)) || 'postgres'}_${suffix}`;
  dedicated.delete(suffix);
  const admin = await pgClient(LIVE);
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
/** `?` → `$n`, for fixture SQL that never puts a question mark in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

async function postgresEngine(setup: string, tables: readonly string[], database: string): Promise<TenantEngine> {
  const url = await dedicatedPostgresUrl(database);
  const control = await pgClient(url),
    sessions: Control[] = [];
  try {
    // Every runtime table lives in the one `mistri` schema; the App schema keeps only its migration bookkeeping.
    await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
    await control.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE lower(c.relname) LIKE '\\_\\_mistri\\_%' AND c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_temp'
      LOOP EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', r.nspname, r.relname); END LOOP; END $$`);
    await control.query(
      `DROP TABLE IF EXISTS ${[...new Set([...tables, ...FIXTURE_TABLES])].map((name) => `public.${name}`).join(', ')} CASCADE`,
    );
    await control.query('DROP FUNCTION IF EXISTS public.tablewalk_fixture_noop() CASCADE');
    await control.query(`DO $$ BEGIN
      CREATE COLLATION IF NOT EXISTS public.${CASE_INSENSITIVE} (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
      EXCEPTION WHEN unique_violation THEN NULL; END $$`);
    await control.query('CREATE FUNCTION public.tablewalk_fixture_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await control.query(setup);
  } catch (error) {
    await control.end().catch(() => {});
    throw error;
  }
  const query = (sql: string, values?: readonly unknown[]) =>
    control.query(postgresRuntimeSql(values ? numbered(sql) : sql), values as unknown[]);
  const transaction = async <T>(work: (operations: TransactionOperations) => Promise<T>): Promise<T> => {
    await control.query('BEGIN');
    const operations = new TransactionOperations();
    try {
      const out = await work(operations);
      await operations.finish();
      await control.query('COMMIT');
      return out;
    } catch (error) {
      await operations.finish().catch(() => {});
      await control.query('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  const introspect = async () => {
    const adapter = new PostgresAdapter(url, 'Tenant fixture');
    try {
      return await adapter.introspect();
    } finally {
      await adapter.close();
    }
  };
  return {
    dialect: 'postgres',
    path: '',
    begin: 'BEGIN',
    id: (name) => `public.${name}`,
    async exec(sql, values) {
      await query(sql, values);
    },
    async all(sql, values) {
      return (await query(sql, values)).rows.map((row) => ({ ...row }));
    },
    async get(sql, values) {
      const row = (await query(sql, values)).rows[0];
      return row ? { ...row } : undefined;
    },
    physicalSchema: introspect,
    introspect,
    url,
    async provisionStore(binding) {
      await migratePostgresTenantStore(url, binding);
    },
    migrateCommandJournal: () => migratePostgresCommandJournal(url),
    layout: (prefix) => describePostgresRelations(control, prefix),
    maintenance: (binding, run) => transaction((operations) => run(createPostgresTenantAdministration(control, operations, binding))),
    readMembership: (binding, lookup) => transaction(() => readPostgresTenantMembership(control, binding, lookup)),
    openRead: (ownership, binding, now, trustFor = 0) => openPostgresTenantReadSource(url, ownership, binding, now, [], trustFor),
    openWrite: (ownership, binding, now) => openPostgresTenantWriteSource(url, ownership, binding, now),
    intercept(t, options) {
      // Every source connection is leased through the manager's one private
      // method; the control connection is a plain client and never is.
      const proto = PgConnectionManager.prototype as unknown as {
        withClient(write: boolean, run: (client: PgQuery) => Promise<unknown>, destroyAfter: boolean): Promise<unknown>;
      };
      const original = proto.withClient;
      let calls = 0;
      const wrap = (client: PgQuery, writer: boolean): PgQuery => ({
        query: ((text: string, values?: unknown[]) => {
          const run = () => client.query(text, values);
          if (!options.match({ sql: text, writer })) return run();
          calls++;
          if (options.fault === 'before') return Promise.reject(intercepted());
          return run().then((result) => {
            if (options.fault === 'after') throw intercepted();
            options.after?.();
            return result;
          });
        }) as PgQuery['query'],
      });
      const mock = t.mock.method(
        proto,
        'withClient',
        function (this: unknown, write: boolean, run: (client: PgQuery) => Promise<unknown>, destroyAfter: boolean) {
          return original.call(this, write, (client: PgQuery) => run(wrap(client, write)), destroyAfter);
        },
      );
      return {
        get calls() {
          return calls;
        },
        restore() {
          mock.mock.restore();
        },
      };
    },
    async session() {
      const created = await pgClient(url);
      sessions.push(created);
      // A session is written like the engine's own statements, so it spells a runtime table the same way.
      const run = created.query.bind(created) as (text: unknown, ...rest: unknown[]) => unknown;
      (created as { query: unknown }).query = (text: unknown, ...rest: unknown[]) =>
        run(typeof text === 'string' ? postgresRuntimeSql(text) : text, ...rest);
      return created;
    },
    sqlite() {
      throw new Error('A PostgreSQL fixture has no SQLite handle.');
    },
    async close() {
      await Promise.allSettled(sessions.map((session) => session.end()));
      await control.end();
    },
  };
}

/** A fresh engine with the suite's schema. The caller closes it after its sources.
 * `database` names the PostgreSQL database of the suite's own: a suffix ending in
 * a UUID, which the suite drops with `dropDedicatedPostgresDatabase` when it
 * ends. It is required, and no suite may share a name with another, because two
 * runs on one server reset every fixture table in the database they open. */
export async function openTenantEngine(
  dialect: TenantDialect,
  setup: { sqlite: string; postgres: string; tables: readonly string[]; database: string },
): Promise<TenantEngine> {
  return dialect === 'sqlite' ? sqliteEngine(setup.sqlite) : postgresEngine(setup.postgres, setup.tables, setup.database);
}
