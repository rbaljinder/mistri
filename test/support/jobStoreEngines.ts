/**
 * One job-store fixture per engine, so the contract suites run unchanged on
 * SQLite and on PostgreSQL. PostgreSQL is live and opt-in exactly like the
 * other live suites: `TABLEWALK_TEST_PG` names a disposable database this
 * fixture resets (it drops the job namespace and its own fixture tables in
 * `public` before each test), and `TABLEWALK_REQUIRE_LIVE=1` turns a missing
 * server into a failure. PostgreSQL stores here use the caller's clock, so a
 * test's injected time means the same thing on both engines; the database
 * clock has its own proof in postgres-job-store.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, type TestContext } from 'node:test';
import { runtimeTable } from '../../packages/engine/src/shared/runtimeTables.js';
import { openSqliteJobStore } from '../../packages/mistri/src/adapters/jobs/jobStore.js';
import type { JobStore } from '../../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { JOB_PREFIX, JOB_TABLES, provisionSqliteJobStore } from '../../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import type { JobPolicyInput } from '../../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import {
  migratePostgresJobStore,
  openPostgresJobStore,
  type PostgresJobStoreOptions,
} from '../../packages/mistri/src/adapters/jobs/postgresJobStore.js';
import { PgConnectionManager, type PgQuery } from '../../packages/engine/src/adapters/postgresPool.js';
import { liveSkip } from '../live.js';

/** Whether the live half runs at all. This is the skip decision and nothing
 * else: no fixture may put a store in this database, because every reset here
 * drops whole namespaces and two runs would drop each other's. */
export const LIVE_PG = process.env.TABLEWALK_TEST_PG;

/* The database this process owns, beside the server's, named with a UUID and
   created on first use — so the job, delivery, event and journal namespaces a
   fixture resets are only ever its own run's. Dropped when the process ends. */
let owned: Promise<{ url: string; name: string }> | undefined;
export function ownedPostgresDatabase(): Promise<string> {
  if (!LIVE_PG) return Promise.reject(new Error('An owned PostgreSQL database needs TABLEWALK_TEST_PG.'));
  owned ??= (async () => {
    const url = new URL(LIVE_PG),
      base = decodeURIComponent(url.pathname.slice(1)) || 'postgres';
    const name = `${base}_fixture_${randomUUID().replaceAll('-', '')}`;
    if (!/^[A-Za-z0-9_]{1,63}$/.test(name)) throw new Error('TABLEWALK_TEST_PG names a database this fixture cannot extend.');
    const admin = await connect(LIVE_PG);
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    url.pathname = `/${name}`;
    return { url: url.href, name };
  })();
  return owned.then((created) => created.url);
}
after(async () => {
  if (!owned) return;
  const created = await owned.catch(() => undefined);
  if (!created) return;
  const admin = await connect(LIVE_PG!);
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${created.name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});
/** Refuses any database this run does not own: a name must end in a UUID's 32
 * hex digits, so the server's shared database can never be reset under another
 * run. A caller that passes the shared URL — or nothing — fails here, loudly. */
export function assertOwnedPostgresDatabase(url: string | undefined): string {
  const name = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : '';
  if (!/_[0-9a-f]{32}$/.test(name)) {
    throw new Error('This fixture needs the database its own run owns: await ownedPostgresDatabase(), never TABLEWALK_TEST_PG itself.');
  }
  return url!;
}
export type JobEngineName = 'sqlite' | 'postgres';

export interface JobEngineFixture {
  readonly engine: JobEngineName;
  /** True when this call created the namespace. */
  provision(policy?: JobPolicyInput): Promise<boolean>;
  open(policy?: JobPolicyInput): Promise<JobStore>;
  /** One statement on a separate, non-store connection. */
  exec(sql: string): Promise<void>;
  scalar(sql: string): Promise<number>;
  /** A digest of the business table beside the namespace: its shape and rows. */
  business(): Promise<string>;
}
export interface JobEngine {
  readonly name: JobEngineName;
  readonly skip: false | string;
  fixture(t: TestContext, policy: JobPolicyInput, provision?: boolean): Promise<JobEngineFixture>;
}

/* Portable between the two engines on purpose: the same statements set up
   the business tables a job store must never read or rewrite. */
const BUSINESS = [
  'CREATE TABLE job_fixture_accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL)',
  "INSERT INTO job_fixture_accounts VALUES (1, 'north', 100), (2, 'south', 250)",
  'CREATE TABLE job_fixture_effects (id INTEGER PRIMARY KEY, sent INTEGER NOT NULL)',
  'INSERT INTO job_fixture_effects VALUES (1, 0)',
];

const sqlite: JobEngine = {
  name: 'sqlite',
  skip: false,
  async fixture(t, policy, provision = true) {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-job-store-')),
      path = join(directory, 'app.db');
    const db = new DatabaseSync(path);
    for (const sql of BUSINESS) db.exec(sql);
    if (provision) provisionSqliteJobStore(path, policy);
    const stores: JobStore[] = [];
    t.after(async () => {
      for (const store of stores) await store.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      engine: 'sqlite',
      provision: async (input = policy) => provisionSqliteJobStore(path, input).provisioned,
      open: async (input = policy) => {
        const store = openSqliteJobStore(path, input);
        stores.push(store);
        return store;
      },
      exec: async (sql) => {
        db.exec(sql);
      },
      scalar: async (sql) => Number(Object.values(db.prepare(sql).get()!)[0]),
      business: async () =>
        createHash('sha256')
          .update(
            JSON.stringify([
              db.prepare("SELECT sql FROM sqlite_schema WHERE name='job_fixture_accounts'").get(),
              db.prepare('SELECT * FROM job_fixture_accounts ORDER BY id').all(),
            ]),
          )
          .digest('hex'),
    };
  },
};

export interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
/** A plain connection. The URL is the caller's own run's, from
 * `ownedPostgresDatabase()`: passing nothing, or the shared server database,
 * is refused rather than quietly sharing a namespace with another run. */
export async function pgControl(url?: string): Promise<Control> {
  return connect(assertOwnedPostgresDatabase(url));
}
/** The unchecked connection, for this module's own administration only. */
async function connect(url: string): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: url });
  await created.connect();
  return created;
}
/** Drops the job namespace, whatever state a previous test left it in, and
 * the fixture's own tables, functions and schemas. */
export async function resetPostgresJobs(control: PgQuery): Promise<void> {
  await control.query('DROP SCHEMA IF EXISTS tablewalk_job_shadow CASCADE');
  await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
  const rows = (
    await control.query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE lower(substr(c.relname, 1, $2)) = $1 AND c.relkind IN ('r', 'S', 'v') AND NOT pg_catalog.pg_is_other_temp_schema(n.oid)`,
      [JOB_PREFIX, JOB_PREFIX.length],
    )
  ).rows as { schema: string; name: string; kind: string }[];
  for (const row of rows) {
    await control.query(
      `DROP ${row.kind === 'S' ? 'SEQUENCE' : row.kind === 'v' ? 'VIEW' : 'TABLE'} IF EXISTS "${row.schema}"."${row.name}" CASCADE`,
    );
  }
  await control.query('DROP TABLE IF EXISTS public.job_fixture_accounts, public.job_fixture_effects CASCADE');
  await control.query('DROP FUNCTION IF EXISTS public.tablewalk_job_fixture_noop() CASCADE');
}

/** The contract suites name a table once, by its pinned `"__mistri_job_x"`; PostgreSQL keeps it
 * in the runtime schema under its plain name. */
const physical = (sql: string) => sql.replace(/"(__mistri_[a-z_]+)"/g, (_, name: string) => runtimeTable('postgres', name));

const postgres: JobEngine = {
  name: 'postgres',
  skip: liveSkip('postgres', LIVE_PG),
  async fixture(t, policy, provision = true) {
    const url = await ownedPostgresDatabase();
    const control = await pgControl(url);
    await resetPostgresJobs(control);
    for (const sql of BUSINESS) await control.query(sql);
    const managers: PgConnectionManager[] = [],
      stores: JobStore[] = [];
    t.after(async () => {
      for (const store of stores) await store.close();
      for (const manager of managers) await manager.close().catch(() => {});
      await control.end();
    });
    if (provision) await migratePostgresJobStore(url, policy);
    const open = async (input = policy, options: PostgresJobStoreOptions = { clock: 'caller' }) => {
      const manager = new PgConnectionManager(url);
      managers.push(manager);
      const store = await openPostgresJobStore(manager, input, options);
      stores.push(store);
      return store;
    };
    return {
      engine: 'postgres',
      provision: async (input = policy) => (await migratePostgresJobStore(url, input)).migrated,
      open: (input) => open(input),
      exec: async (sql) => {
        await control.query(physical(sql));
      },
      scalar: async (sql) => Number(Object.values((await control.query(physical(sql))).rows[0])[0]),
      business: async () =>
        createHash('sha256')
          .update(
            JSON.stringify([
              (
                await control.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'job_fixture_accounts' ORDER BY ordinal_position`)
              ).rows,
              (await control.query('SELECT * FROM public.job_fixture_accounts ORDER BY id')).rows,
            ]),
          )
          .digest('hex'),
    };
  },
};

export const jobEngines: readonly JobEngine[] = [sqlite, postgres];
export { JOB_TABLES };
