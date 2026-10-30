/**
 * The Better Auth store on PostgreSQL, against a real server.
 *
 * auth.test.ts proves sign-in on the file store; this file proves the same
 * App with `auth.store` set to a `postgres://` URL: the explicit migration
 * (idempotent, foreign layout refused, and exactly what the installed Better
 * Auth would plan), startup that attests and never migrates, the sign-up /
 * sign-in round trip, a session that survives a server restart, the admin
 * bootstrap from the environment, the ownership rule (a runtime schema or
 * store tables not solely the connecting role's are refused, not adopted), the separation
 * refusals — every spelling of the store's address, an alias only the
 * server can reveal, a role that can reach the schema — and the business
 * adapter's blindness to the store when pointed at the same database.
 *
 * Live and opt-in exactly like postgres.test.ts: `TABLEWALK_TEST_PG` names
 * a server control database that this file never resets. It creates two
 * UUID-owned databases and four UUID-owned roles, resets the complete runtime
 * schema only inside its own database, then drops only identity-checked
 * owned objects. `TABLEWALK_REQUIRE_LIVE=1` turns a missing server into a
 * failure. The connecting role needs CREATEDB and CREATEROLE.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { existsSync, readFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect as dial, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import {
  AuthStoreNotOwned,
  AuthStoreUnavailable,
  POSTGRES_AUTH_PREFIX,
  assertPostgresAuthStore,
  migratePostgresAuthStore,
  withPostgresAuthModels,
} from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { describePostgresRelations } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { RUNTIME_SCHEMA } from '../packages/engine/src/shared/runtimeTables.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgPool, PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openPostgresAuthStore } from '../packages/mistri/src/server/auth/authStore.js';
import {
  assertPostgresAuthStoreSeparation,
  captureAuthStoreExclusion,
  type PostgresSeparationConnection,
} from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { accountAuditPlugin } from '../packages/mistri/src/server/auth/accountAudit.js';
import { identityStorePlugin } from '../packages/mistri/src/server/auth/identityStore.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import { liveSkip } from './live.js';

const SERVER = process.env.TABLEWALK_TEST_PG;
let LIVE = SERVER;
const SEPARATION = 'Authentication storage must remain separate from the captured business database and its SQLite sidecars.';
/** A second database on the same server, created and dropped by this file. */
const fixtureId = randomUUID().replaceAll('-', '');
const DATABASE = `tw_auth_${fixtureId}`;
const ELSEWHERE = `tw_auth_other_${fixtureId}`;
const roles = {
  intruder: `tw_auth_intruder_${fixtureId}`,
  owner: `tw_auth_owner_${fixtureId}`,
  runtime: `tw_auth_runtime_${fixtureId}`,
  alias: `tw_auth_alias_${fixtureId}`,
};

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
interface PoolLike extends PgQuery {
  end(): Promise<void>;
}
async function pgModule() {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: Record<string, unknown> } & Record<string, unknown>;
  return (pg.default ?? pg) as { Client: new (c: unknown) => Control; Pool: new (c: unknown) => PoolLike };
}
async function client(url = LIVE): Promise<Control> {
  const created = new (await pgModule()).Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await created.connect();
  } catch (error) {
    try {
      await created.end();
    } catch {
      /* Preserve connect failure. */
    }
    throw error;
  }
  return created;
}
/** The URL with another database name: a different target on the same server. */
const otherDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
/** The URL signed in as another role. */
const as = (url: string, user: string, password: string) => {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
};

describe('the authentication store on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  let administration: Control | undefined;
  const databases = new Map<string, { oid: string; owner: string }>();
  const ownedRoles = new Map<string, string>();
  const databaseFacts = async (name: string) => {
    const { rows } = await administration!.query(
      'SELECT oid::text AS oid, datdba::text AS owner FROM pg_catalog.pg_database WHERE datname=$1',
      [name],
    );
    assert.equal(rows.length, 1, `Owned database identity unavailable: ${name}`);
    return rows[0] as { oid: string; owner: string };
  };
  const createDatabase = async (name: string) => {
    // Names are generated internally; never adopt an existing database or
    // infer ownership after a failed CREATE acknowledgement.
    try {
      await administration!.query(`CREATE DATABASE "${name}"`);
    } catch {
      throw new Error(`CREATE acknowledgement unavailable; possible orphan database ${name}; no automatic DROP`);
    }
    try {
      databases.set(name, await databaseFacts(name));
    } catch {
      throw new Error(`Owned database identity capture failed: ${name}; manual recovery required`);
    }
  };
  const createRole = async (name: string, options: string) => {
    try {
      await administration!.query(`CREATE ROLE "${name}" ${options}`);
    } catch {
      throw new Error(`CREATE acknowledgement unavailable; possible orphan role ${name}; no automatic DROP`);
    }
    try {
      const { rows } = await administration!.query('SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=$1', [name]);
      assert.equal(rows.length, 1);
      ownedRoles.set(name, String(rows[0].oid));
    } catch {
      throw new Error(`Owned role identity capture failed: ${name}; manual recovery required`);
    }
  };
  let tmp: string;
  let business: string;
  const previous = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD', 'TABLEWALK_TEST_AUTH_STORE'].map(
    (name) => [name, process.env[name]] as const,
  );

  before(async () => {
    administration = await client(SERVER);
    await createDatabase(DATABASE);
    await createDatabase(ELSEWHERE);
    LIVE = otherDatabase(SERVER!, DATABASE);
    control = await client(LIVE);
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-pg-auth-'));
    business = join(tmp, 'app.db');
    makeDemoDatabase(business);
    seedDemoDatabase(business, { scale: 3 });
    process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
    delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
    delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
    await createRole(roles.intruder, 'NOLOGIN');
    await createRole(roles.owner, 'NOLOGIN');
    await createRole(roles.runtime, `LOGIN PASSWORD 'runtime-password-1' IN ROLE "${roles.owner}"`);
    await createRole(roles.alias, "LOGIN PASSWORD 'alias-password-1'");
    if (process.env.TABLEWALK_TEST_AUTH_FIXTURE_EVIDENCE === '1') {
      console.info('AUTH_FIXTURE_IDENTITY ' + JSON.stringify({ databases: [...databases], roles: [...ownedRoles] }));
    }
  });
  after(async () => {
    const failures: unknown[] = [];
    let clientsClosed = true;
    try {
      const directory = process.env.TABLEWALK_TEST_AUTH_FIXTURE_HOLD_DIR;
      if (directory) {
        const index = process.env.TABLEWALK_TEST_AUTH_FIXTURE_INDEX,
          nonce = process.env.TABLEWALK_TEST_AUTH_FIXTURE_BARRIER;
        assert.ok(index === '1' || index === '2');
        assert.match(nonce ?? '', /^[a-f0-9-]{36}$/);
        const identity = databases.get(DATABASE);
        assert.ok(identity);
        assert.deepEqual(await databaseFacts(DATABASE), identity);
        assert.deepEqual((await control.query('SELECT current_database() AS name')).rows, [{ name: DATABASE }]);
        // After all full-schema tests: this marker belongs only to this newly
        // created database. It is not an isolation substitute for auth schema.
        await control.query('CREATE TABLE public.__tw_auth_fixture_marker(id TEXT PRIMARY KEY)');
        await control.query('INSERT INTO public.__tw_auth_fixture_marker VALUES($1)', [fixtureId]);
        writeFileSync(
          join(directory, `${index}.pending`),
          JSON.stringify({ fixtureId, database: DATABASE, identity, databases: [...databases], roles: [...ownedRoles] }),
          { flag: 'wx', mode: 0o600 },
        );
        renameSync(join(directory, `${index}.pending`), join(directory, `${index}.ready`));
        const release = join(directory, `${index}.release`),
          deadline = Date.now() + 180000;
        while (!existsSync(release)) {
          if (Date.now() >= deadline) throw new Error(`Owned fixture barrier deadline: ${DATABASE}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(readFileSync(release, 'utf8'), nonce);
        assert.deepEqual(await databaseFacts(DATABASE), identity);
        assert.deepEqual((await control.query('SELECT id FROM public.__tw_auth_fixture_marker')).rows, [{ id: fixtureId }]);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await control?.end();
    } catch (error) {
      failures.push(error);
      clientsClosed = false;
    }
    try {
      if (clientsClosed && administration) {
        for (const [name, identity] of databases) {
          try {
            assert.deepEqual(await databaseFacts(name), identity, `Owned database changed: ${name}`);
            // AuthRuntime.close() is synchronous but native pool.end() drains
            // asynchronously. Wait for actual owned-database borrowers to go,
            // never terminate them or assume close() was an awaited barrier.
            const deadline = Date.now() + 10000;
            for (;;) {
              assert.deepEqual(await databaseFacts(name), identity, `Owned database changed: ${name}`);
              const { rows } = await administration.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datid=$1::oid', [identity.oid]);
              if (!rows.length) break;
              if (Date.now() >= deadline) throw new Error(`Owned database still has borrowers: ${name}`);
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.deepEqual(await databaseFacts(name), identity, `Owned database changed: ${name}`);
            // No FORCE or backend termination: outstanding borrowers are a
            // cleanup failure, never authority to destroy someone else's work.
            await administration.query(`DROP DATABASE "${name}"`);
            databases.delete(name);
          } catch (error) {
            failures.push(error);
          }
        }
        // Database-local grants/ownership disappear with the databases.
        // Preserve all role evidence if any database could not be removed.
        // Reverse creation order removes runtime membership before its owner.
        const roleCleanup: [string, string][] = databases.size ? [] : [...ownedRoles].reverse();
        for (const [name, oid] of roleCleanup) {
          try {
            const { rows }: { rows: unknown[] } = await administration.query(
              'SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=$1',
              [name],
            );
            assert.deepEqual(rows, [{ oid }], `Owned role changed: ${name}`);
            await administration.query(`DROP ROLE "${name}"`);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } finally {
      try {
        await administration?.end();
      } catch (error) {
        failures.push(error);
      }
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    if (failures.length) throw new AggregateError(failures, `Owned auth fixture cleanup failed: ${DATABASE}, ${ELSEWHERE}`);
  });
  const reset = async (migrate = true) => {
    assert.deepEqual(await databaseFacts(DATABASE), databases.get(DATABASE), 'Owned reset target changed');
    assert.deepEqual((await control.query('SELECT current_database() AS name')).rows, [{ name: DATABASE }]);
    await control.query(`DROP SCHEMA IF EXISTS "${RUNTIME_SCHEMA}" CASCADE`);
    if (migrate) assert.deepEqual(await migratePostgresAuthStore(LIVE!), { version: 1, migrated: true });
  };

  /* The App: a SQLite business database, sessions on PostgreSQL. */
  const app = async (store: string, name = 'secured'): Promise<LoadedApp> => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Secured',
        auth: {
          providers: ['email'],
          signUp: 'open',
          store,
          roles: { user: { read: true, write: ['work_order'] }, admin: { read: true, write: true } },
        },
        // The ceilings the roles grant within: the user writes work orders, the admin customers too.
        resources: { work_order: { access: 'write' }, customer: { access: 'write' } },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    return loadApp(dir);
  };
  interface Served {
    server: Server;
    origin: string;
    host: AppHost;
    stop(): Promise<void>;
  }
  const serve = async (loaded: LoadedApp): Promise<Served> => {
    const registry = new Registry();
    registry.add({ name: 'rw', url: business, writable: true, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    const host: AppHost = { app: loaded, pages: [] };
    const server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const stop = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.auth?.close();
      await registry.closeAll();
    };
    try {
      host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], excludeConnections: registry.configs() });
    } catch (error) {
      await stop();
      throw error;
    }
    return { server, origin, host, stop };
  };
  const call = async (origin: string, path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { ...init, headers });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      status: res.status,
      json,
      text,
      cookie: res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    };
  };
  /* The attestation reads under a pinned search_path and so wants a transaction. */
  const attest = async () => {
    await control.query('BEGIN');
    try {
      await assertPostgresAuthStore(control);
    } finally {
      await control.query('ROLLBACK');
    }
  };
  const storedRole = async (accountId: unknown) => {
    assert.equal(typeof accountId, 'string');
    return (await control.query(`SELECT role FROM ${RUNTIME_SCHEMA}.auth_user WHERE id = $1`, [accountId])).rows[0]?.role;
  };
  const LABEL = `postgresql auth store (the auth_ tables in schema ${RUNTIME_SCHEMA})`;

  describe('migration', () => {
    test('creates the layout once, is idempotent, and plans nothing for the installed Better Auth', async () => {
      await reset(false);
      assert.deepEqual(await migratePostgresAuthStore(LIVE!), { version: 1, migrated: true });
      assert.deepEqual(await migratePostgresAuthStore(LIVE!), { version: 1, migrated: false });
      await attest();
      await assert.rejects(assertPostgresAuthStore(control), AuthStoreUnavailable, 'outside a transaction it refuses rather than guessing');
      const names = (await describePostgresRelations(control, POSTGRES_AUTH_PREFIX)).map((relation) => relation.name);
      assert.deepEqual(names, [
        'auth_account',
        'auth_account_audit',
        'auth_idp_session',
        'auth_meta',
        'auth_scim_connection_binding',
        'auth_scim_group',
        'auth_scim_group_member',
        'auth_scim_identity_tombstone',
        'auth_scim_projection_grant',
        'auth_scim_subject',
        'auth_scim_user',
        'auth_session',
        'auth_user',
        'auth_verification',
      ]);
      // Better Auth's own planner sees the layout it would have produced and
      // has nothing to create or add, under the PostgreSQL names the runtime
      // gives its models. It plans in the first schema on the path, so it is
      // given the runtime schema alone; the runtime's path names pg_catalog
      // first, and its unqualified names still land here.
      const { Pool } = await pgModule();
      const pool = new Pool({ connectionString: LIVE, options: `-c search_path=${RUNTIME_SCHEMA}`, max: 1 });
      try {
        const { admin } = await import('better-auth/plugins');
        const { getMigrations } = await import('better-auth/db/migration');
        const planned = await getMigrations(
          withPostgresAuthModels({
            database: pool,
            emailAndPassword: { enabled: true },
            plugins: [admin({ defaultRole: 'user' }), accountAuditPlugin(), identityStorePlugin()],
            secret: process.env.BETTER_AUTH_SECRET,
            baseURL: 'http://127.0.0.1:1',
            telemetry: { enabled: false },
          }) as never,
        );
        assert.deepEqual([planned.toBeCreated, planned.toBeAdded], [[], []]);
      } finally {
        await pool.end();
      }
      const runtime = await openPostgresAuthStore(LIVE!);
      try {
        const store = runtime.database as PgPool;
        const path = String((await store.query('SHOW search_path')).rows[0].search_path).replace(/\s/g, '');
        assert.equal(path, `pg_catalog,${RUNTIME_SCHEMA},pg_temp`);
        assert.deepEqual((await store.query('SELECT count(*)::int AS n FROM auth_user')).rows, [{ n: 0 }]);
      } finally {
        runtime.close();
      }
    });

    test('a store written by a newer build says so, and says to upgrade', async () => {
      await reset();
      await control.query(`ALTER TABLE ${RUNTIME_SCHEMA}.auth_meta DROP CONSTRAINT auth_meta_version_check`);
      await control.query(`UPDATE ${RUNTIME_SCHEMA}.auth_meta SET version = 5`);
      await control.query(`ALTER TABLE ${RUNTIME_SCHEMA}.auth_meta ADD CONSTRAINT auth_meta_version_check CHECK (version = 5)`);
      await assert.rejects(
        attest(),
        (error: unknown) =>
          error instanceof AuthStoreUnavailable &&
          error.message.startsWith('The PostgreSQL authentication store is at layout version 5, newer than the version 1') &&
          /upgrade to open it/.test(error.message),
      );
    });
    test('the trail is part of the layout: an extra, a missing rule or a dropped table refuses', async () => {
      for (const change of [
        `CREATE TABLE ${RUNTIME_SCHEMA}.auth_audit_extra (id text)`,
        `DROP RULE auth_account_audit_no_delete ON ${RUNTIME_SCHEMA}.auth_account_audit`,
        `DROP TABLE ${RUNTIME_SCHEMA}.auth_account_audit`,
        `ALTER TABLE ${RUNTIME_SCHEMA}.auth_account_audit ADD COLUMN "password" text`,
      ]) {
        await reset();
        await control.query(change);
        await assert.rejects(attest(), AuthStoreUnavailable, change);
        await assert.rejects(migratePostgresAuthStore(LIVE!), AuthStoreUnavailable, change);
      }
    });

    test('refuses a foreign layout under the store names, unchanged', async () => {
      await reset();
      await control.query(`ALTER TABLE ${RUNTIME_SCHEMA}.auth_user ADD COLUMN extra text`);
      await assert.rejects(migratePostgresAuthStore(LIVE!), AuthStoreUnavailable);
      await assert.rejects(attest(), AuthStoreUnavailable);
      const columns = (await describePostgresRelations(control, POSTGRES_AUTH_PREFIX))
        .find((r) => r.name === 'auth_user')!
        .columns.map((c) => c.name);
      assert.ok(columns.includes('extra'), 'the foreign column is left as it was');
      await reset(false);
      await control.query(`CREATE SCHEMA "${RUNTIME_SCHEMA}"`);
      await control.query(`CREATE TABLE ${RUNTIME_SCHEMA}.auth_stray (id integer PRIMARY KEY)`);
      await assert.rejects(migratePostgresAuthStore(LIVE!), AuthStoreUnavailable);
      assert.deepEqual(
        (await describePostgresRelations(control, POSTGRES_AUTH_PREFIX)).map((r) => r.name),
        ['auth_stray'],
        'nothing was added beside it',
      );
      // Another store's table in the runtime schema is not the sign-in store's: the layout is made beside it.
      await reset(false);
      await control.query(`CREATE SCHEMA ${RUNTIME_SCHEMA}`);
      await control.query(`CREATE TABLE ${RUNTIME_SCHEMA}.job_other (id integer PRIMARY KEY)`);
      assert.deepEqual(await migratePostgresAuthStore(LIVE!), { version: 1, migrated: true });
      await attest();
      await assert.rejects(
        migratePostgresAuthStore('/var/lib/auth.db'),
        (error: unknown) => error instanceof Refusal && /postgres:\/\/ URL/.test(error.message),
      );
    });

    test('startup attests and never migrates: an unmigrated database is refused with the maintenance step named', async () => {
      await reset(false);
      const loaded = await app(LIVE!);
      await assert.rejects(createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: [] }), (error: unknown) => {
        assert.ok(error instanceof AuthStoreUnavailable);
        assert.match(error.message, /migratePostgresAuthStore/);
        assert.doesNotMatch(error.message, /postgres:\/\/[^ ]*@/);
        return true;
      });
      const schemas = await control.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [RUNTIME_SCHEMA]);
      assert.equal(schemas.rows.length, 0, 'startup created nothing');
    });
  });

  describe('ownership', () => {
    const S = RUNTIME_SCHEMA;
    const I = `"${roles.intruder}"`;

    test('a schema another role prepared is refused by the migration, not adopted', async () => {
      await reset(false);
      await control.query(`CREATE SCHEMA ${S} AUTHORIZATION ${I}`);
      await assert.rejects(
        migratePostgresAuthStore(LIVE!),
        (error: unknown) => error instanceof AuthStoreNotOwned && /owned by another role/.test(error.message),
      );
      const left = await control.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [RUNTIME_SCHEMA]);
      assert.deepEqual(left.rows, [{ owner: roles.intruder }]);
      assert.deepEqual(await describePostgresRelations(control, POSTGRES_AUTH_PREFIX), [], 'nothing was created in it');
    });

    test('a foreign CREATE grant, a planted function, type or operator, a foreign owner or grant: refused by attestation and migration', async () => {
      const plants: [string, string, RegExp][] = [
        ['a CREATE grant to another role', `GRANT CREATE ON SCHEMA ${S} TO ${I}`, /another role may create objects in it/],
        ['a CREATE grant to PUBLIC', `GRANT CREATE ON SCHEMA ${S} TO PUBLIC`, /another role may create objects in it/],
        ['a USAGE grant to another role', `GRANT USAGE ON SCHEMA ${S} TO ${I}`, /another role may use it/],
        ['a planted function', `CREATE FUNCTION ${S}.lower(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`, /functions, operators, types/],
        ['a planted domain', `CREATE DOMAIN ${S}.email AS text`, /functions, operators, types/],
        [
          'a planted operator',
          `CREATE OPERATOR ${S}.=== (LEFTARG = text, RIGHTARG = text, FUNCTION = texteq)`,
          /functions, operators, types/,
        ],
        ['the schema given away', `ALTER SCHEMA ${S} OWNER TO ${I}`, /it is owned by another role/],
        ['a table given away', `ALTER TABLE ${S}.auth_session OWNER TO ${I}`, /a relation in it is owned by another role/],
        ['a table privilege granted', `GRANT SELECT ON ${S}.auth_session TO ${I}`, /another role holds privileges on its tables/],
        ['a column privilege granted', `GRANT SELECT (token) ON ${S}.auth_session TO ${I}`, /another role holds privileges on its tables/],
      ];
      for (const [name, plant, reason] of plants) {
        await reset();
        await control.query(plant);
        const refused = (error: unknown) => error instanceof AuthStoreNotOwned && reason.test(error.message);
        await assert.rejects(attest(), refused, `attestation: ${name}`);
        await assert.rejects(migratePostgresAuthStore(LIVE!), refused, `migration: ${name}`);
      }
      // Before any table exists too: nothing is created beside a planted function.
      await reset(false);
      await control.query(`CREATE SCHEMA ${S}`);
      await control.query(`CREATE FUNCTION ${S}.lower(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
      await assert.rejects(migratePostgresAuthStore(LIVE!), AuthStoreNotOwned);
      assert.deepEqual(await describePostgresRelations(control, POSTGRES_AUTH_PREFIX), []);
    });

    test('a role inheriting the owning role attests, migrates and signs people up; a superuser counts only itself', async () => {
      await reset();
      const O = `"${roles.owner}"`;
      await control.query(`ALTER SCHEMA ${S} OWNER TO ${O}`);
      // Every table the layout holds, read off the catalog, so a later version's tables (SCIM, idpSession) are handed over too.
      const tables = await control.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1', [RUNTIME_SCHEMA]);
      for (const { tablename } of tables.rows) await control.query(`ALTER TABLE ${S}."${tablename}" OWNER TO ${O}`);
      await assert.rejects(attest(), AuthStoreNotOwned, 'a superuser is a member of every role, so only its own ownership counts');
      const runtime = as(LIVE!, roles.runtime, 'runtime-password-1');
      assert.deepEqual(await migratePostgresAuthStore(runtime), { version: 1, migrated: false });
      (await openPostgresAuthStore(runtime)).close();
      const served = await serve(await app(runtime, 'runtime-role'));
      try {
        assert.equal(served.host.auth!.store, LABEL);
        const up = await call(served.origin, '/api/auth/sign-up/email', {
          method: 'POST',
          body: JSON.stringify({ name: 'Run', email: 'run@example.org', password: 'run-password-1' }),
        });
        assert.equal(up.status, 200, up.text);
        assert.equal((await call(served.origin, '/api/whoami', { cookie: up.cookie })).json.who, 'run@example.org');
      } finally {
        await served.stop();
      }
    });
  });

  describe('sign-in', () => {
    test('signs up and in, stores the role, and the session outlives a server restart', async () => {
      await reset();
      const first = await serve(await app(LIVE!));
      let cookie: string;
      try {
        const { host, origin } = first;
        assert.equal(host.auth!.store, LABEL, 'the startup label is fixed: no host, user, or expanded ${NAME}');
        assert.equal((await call(origin, '/api/schema')).status, 401);
        const up = await call(origin, '/api/auth/sign-up/email', {
          method: 'POST',
          body: JSON.stringify({ name: 'Ada', email: 'ada@example.org', password: 'ada-password-1' }),
        });
        assert.equal(up.status, 200, up.text);
        assert.match(up.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/, 'a session cookie came back, named for the App');
        cookie = up.cookie;
        const me = await call(origin, '/api/whoami', { cookie });
        assert.equal(me.json.who, 'ada@example.org');
        assert.equal(await storedRole(me.json.accountId), 'user');
        assert.equal((await call(origin, '/api/schema', { cookie })).status, 200);
        const wrote = await call(origin, '/api/update', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ table: 'work_order', key: { id: 1 }, values: { status: 'open' } }),
        });
        assert.equal(wrote.status, 200, wrote.text);
        const listed = await call(origin, '/api/revert', { method: 'POST', cookie, body: '{}' });
        assert.equal(listed.status, 404, listed.text);
        const instance = await host.auth!.sessionInstance!({ headers: { cookie } } as IncomingMessage);
        assert.ok(instance && instance.identity.who === 'ada@example.org' && instance.expiresAt > Date.now());
        assert.equal(Number((await control.query(`SELECT count(*) AS n FROM ${RUNTIME_SCHEMA}.auth_session`)).rows[0].n), 1);
      } finally {
        await first.stop();
      }

      /* Same store, new process as far as Better Auth is concerned. */
      const second = await serve(await app(LIVE!));
      try {
        const { origin } = second;
        const me = await call(origin, '/api/whoami', { cookie });
        assert.equal(me.json.who, 'ada@example.org', 'the session is in the store, not the process');
        assert.equal((await call(origin, '/api/schema', { cookie })).status, 200);
        const signedIn = await call(origin, '/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({ email: 'ada@example.org', password: 'ada-password-1' }),
        });
        assert.equal(signedIn.status, 200, signedIn.text);
        assert.equal((await call(origin, '/api/auth/sign-out', { method: 'POST', cookie, body: '{}' })).status, 200);
        assert.equal((await call(origin, '/api/schema', { cookie })).status, 401);
        assert.equal((await call(origin, '/api/whoami', { cookie: signedIn.cookie })).json.who, 'ada@example.org');
      } finally {
        await second.stop();
      }
    });

    /* Better Auth answers a store that failed beneath its session lookup with a bare 500 of its own; the gate read any
       failure as a refusal, so a pool that would not lend a connection answered a signed-in person's read 403. It is
       the server being busy: 503 with Retry-After, which a client retries. A refusal stays one. */
    test('a session lookup the store does not answer is busy (503), never a refusal', async (t) => {
      await reset();
      const kept = process.env.MISTRI_AUTH_SESSION_CACHE;
      // Nothing kept, so every request asks the store.
      process.env.MISTRI_AUTH_SESSION_CACHE = '0';
      let served: Served;
      try {
        served = await serve(await app(LIVE!));
      } finally {
        if (kept === undefined) delete process.env.MISTRI_AUTH_SESSION_CACHE;
        else process.env.MISTRI_AUTH_SESSION_CACHE = kept;
      }
      t.after(() => served.stop());
      const { origin } = served;
      const up = await call(origin, '/api/auth/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.org', password: 'ada-password-1' }),
      });
      assert.equal(up.status, 200, up.text);
      const { Pool } = await pgModule();
      const connect = (Pool.prototype as unknown as { connect: (...args: unknown[]) => unknown }).connect;
      let refused = 0;
      const checkout = t.mock.method(
        Pool.prototype as unknown as { connect: (...args: unknown[]) => unknown },
        'connect',
        function (this: { options?: { connectionString?: string } }, ...args: unknown[]) {
          // Better Auth's adapter checks out with the promise form, on the auth store's own pool.
          if (!args.length && this.options?.connectionString === LIVE) {
            refused++;
            return Promise.reject(new Error('timeout exceeded when trying to connect'));
          }
          return Reflect.apply(connect, this, args);
        },
      );
      const busy = await fetch(`${origin}/api/schema`, { headers: { origin, cookie: up.cookie } });
      const text = await busy.text();
      checkout.mock.restore();
      assert.ok(refused > 0, 'the lookup reached the store');
      assert.equal(busy.status, 503, text);
      assert.equal(JSON.parse(text).code, 'server_busy');
      assert.equal(busy.headers.get('retry-after'), '1');
      assert.doesNotMatch(text, /timeout/i);
      assert.equal((await call(origin, '/api/schema', { cookie: up.cookie })).status, 200);
      // Signed out is still signed out.
      assert.equal((await call(origin, '/api/schema')).status, 401);
    });

    test('the admin from the environment is created on PostgreSQL, once, and signs in with the admin scope', async () => {
      await reset();
      process.env.MISTRI_AUTH_ADMIN_EMAIL = 'admin@example.org';
      process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'admin-password-1';
      try {
        for (const start of [1, 2]) {
          const served = await serve(await app(LIVE!));
          try {
            const admin = await call(served.origin, '/api/auth/sign-in/email', {
              method: 'POST',
              body: JSON.stringify({ email: 'admin@example.org', password: 'admin-password-1' }),
            });
            assert.equal(admin.status, 200, `start ${start}: ${admin.text}`);
            const me = await call(served.origin, '/api/whoami', { cookie: admin.cookie });
            assert.equal(await storedRole(me.json.accountId), 'admin');
            const wrote = await call(served.origin, '/api/update', {
              method: 'POST',
              cookie: admin.cookie,
              body: JSON.stringify({ table: 'customer', key: { id: 1 }, values: { name: 'Admin edited' } }),
            });
            assert.equal(wrote.status, 200, wrote.text);
          } finally {
            await served.stop();
          }
        }
        const admins = await control.query(`SELECT count(*) AS n FROM ${RUNTIME_SCHEMA}.auth_user WHERE email = 'admin@example.org'`);
        assert.equal(Number(admins.rows[0].n), 1, 'the second start found the account rather than failing');
      } finally {
        delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
        delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      }
    });

    test("account administration writes its trail on PostgreSQL in the change's transaction, append-only and without secrets", async () => {
      await reset();
      process.env.MISTRI_AUTH_ADMIN_EMAIL = 'admin@example.org';
      process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'admin-password-1';
      const audit = `${RUNTIME_SCHEMA}.auth_account_audit`;
      try {
        const served = await serve(await app(LIVE!));
        try {
          const admin = (
            await call(served.origin, '/api/auth/sign-in/email', {
              method: 'POST',
              body: JSON.stringify({ email: 'admin@example.org', password: 'admin-password-1' }),
            })
          ).cookie;
          const change = (body: Record<string, unknown>) =>
            call(served.origin, '/api/accounts', {
              method: 'POST',
              cookie: admin,
              body: JSON.stringify({ app: served.host.app.app.id, ...body }),
            });
          const made = await change({
            operation: 'create',
            email: 'pg@example.org',
            name: 'Pg',
            roles: ['user'],
            password: 'pg-password-1',
          });
          assert.equal(made.status, 200, made.text);
          const id = (made.json.account as { id: string }).id;
          assert.equal((await change({ operation: 'setRoles', accountId: id, roles: ['user', 'admin'] })).status, 200);
          assert.equal((await change({ operation: 'setPassword', accountId: id, password: 'pg-password-2' })).status, 200);
          const rows = (await control.query(`SELECT * FROM ${audit} ORDER BY "createdAt"`)).rows;
          assert.deepEqual(
            rows.map((row) => [row.action, row.actorEmail, row.principal, row.targetId]),
            [
              ['create', 'admin@example.org', 'session', id],
              ['setRoles', 'admin@example.org', 'session', id],
              ['setPassword', 'admin@example.org', 'session', id],
            ],
          );
          assert.ok(rows.every((row) => row.createdAt instanceof Date));
          assert.deepEqual(
            [JSON.parse(String(rows[1].before)), JSON.parse(String(rows[1].after))],
            [{ roles: ['user'] }, { roles: ['user', 'admin'] }],
          );
          const page = await call(served.origin, `/api/accounts?app=${served.host.app.app.id}&trail=1&account=${encodeURIComponent(id)}`, {
            cookie: admin,
          });
          assert.equal(page.status, 200, page.text);
          assert.deepEqual(
            (page.json.entries as Array<{ action: string }>).map((entry) => entry.action),
            ['setPassword', 'setRoles', 'create'],
          );

          // No row holds what signs anyone in.
          const secrets = [
            process.env.BETTER_AUTH_SECRET!,
            'admin-password-1',
            'pg-password-1',
            'pg-password-2',
            ...(await control.query(`SELECT token FROM ${RUNTIME_SCHEMA}.auth_session`)).rows.map((row) => String(row.token)),
            ...(await control.query(`SELECT password FROM ${RUNTIME_SCHEMA}.auth_account WHERE password IS NOT NULL`)).rows.map((row) =>
              String(row.password),
            ),
          ];
          const text = JSON.stringify(rows);
          for (const secret of secrets) assert.equal(text.includes(secret), false);

          // The rules: an update or a delete of a row changes nothing, whoever asks.
          await control.query(`UPDATE ${audit} SET action = 'x'`);
          await control.query(`DELETE FROM ${audit}`);
          assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${audit} WHERE action <> 'x'`)).rows[0].n, 3);

          // From here the row cannot be written: the change it would record is rolled back with it.
          await control.query(`ALTER TABLE ${audit} ADD CONSTRAINT audit_refused CHECK (false) NOT VALID`);
          try {
            const refused = await change({ operation: 'setRoles', accountId: id, roles: ['user'] });
            assert.equal(refused.status, 503, refused.text);
            assert.equal(await storedRole(id), 'user,admin');
            assert.equal((await change({ operation: 'deactivate', accountId: id })).status, 503);
            assert.equal((await control.query(`SELECT banned FROM ${RUNTIME_SCHEMA}.auth_user WHERE id = $1`, [id])).rows[0].banned, false);
            assert.equal(
              (await change({ operation: 'create', email: 'no@example.org', name: 'No', roles: ['user'], password: 'no-password-1' }))
                .status,
              503,
            );
            assert.equal(
              (await control.query(`SELECT count(*)::int AS n FROM ${RUNTIME_SCHEMA}.auth_user WHERE email = 'no@example.org'`)).rows[0].n,
              0,
            );
          } finally {
            await control.query(`ALTER TABLE ${audit} DROP CONSTRAINT audit_refused`);
          }
          assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${audit}`)).rows[0].n, 3);
          assert.equal((await change({ operation: 'setRoles', accountId: id, roles: ['user'] })).status, 200);
          assert.equal(await storedRole(id), 'user');
        } finally {
          await served.stop();
        }
      } finally {
        delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
        delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      }
    });

    test('the manifest may name the URL, or its password, by ${VAR}', async () => {
      await reset();
      process.env.TABLEWALK_TEST_AUTH_STORE = LIVE;
      try {
        const served = await serve(await app('${TABLEWALK_TEST_AUTH_STORE}', 'by-reference'));
        try {
          assert.equal(served.host.auth!.store, LABEL);
          const up = await call(served.origin, '/api/auth/sign-up/email', {
            method: 'POST',
            body: JSON.stringify({ name: 'Ref', email: 'ref@example.org', password: 'ref-password-1' }),
          });
          assert.equal(up.status, 200, up.text);
        } finally {
          await served.stop();
        }
      } finally {
        delete process.env.TABLEWALK_TEST_AUTH_STORE;
      }
    });
  });

  describe('separation', () => {
    const opts = { baseURL: 'http://127.0.0.1:1', trustedOrigins: [] as string[] };
    for (const present of [false, true])
      for (const owner of ['binding', 'runtime'] as const) {
        test(`current roles refuse ${present ? 'valid' : 'missing'} awaited SQL result after ${owner} retirement`, async (t) => {
          await reset();
          const runtime = await createAppAuth(await app(LIVE!), opts);
          const binding = captureAppAuthRuntime(runtime);
          const lookup = binding.lookupEligibleAccountRolesCurrent;
          await control.query(`INSERT INTO ${RUNTIME_SCHEMA}.auth_user (id, name, email, "emailVerified", role)
          VALUES ('roles-user', 'Roles', 'roles@example.org', false, 'reader')`);
          const { Pool } = await pgModule();
          const query = Pool.prototype.query;
          let reads = 0;
          let observedRows: number | undefined;
          const instrument = t.mock.method(Pool.prototype, 'query', async function (this: PoolLike, ...args: unknown[]) {
            const result = (await Reflect.apply(query, this, args)) as Awaited<ReturnType<typeof query>>;
            if (typeof args[0] === 'string' && args[0].startsWith('SELECT id, role, banned,')) {
              reads++;
              observedRows = result.rows.length;
              // Retire after the real query resolved, before the binding resumes.
              ({ binding, runtime })[owner].close();
            }
            return result;
          } as typeof query);
          try {
            await assert.rejects(lookup(present ? 'roles-user' : 'missing'), { message: 'The tenant context could not be verified.' });
            assert.equal(reads, 1);
            assert.equal(observedRows, present ? 1 : 0);
          } finally {
            instrument.mock.restore();
            runtime.close();
          }
        });
      }
    test('current native roles share one eligible account observation and remain private', async () => {
      await reset();
      const runtime = await createAppAuth(await app(LIVE!), opts);
      const binding = captureAppAuthRuntime(runtime);
      try {
        await control.query(`INSERT INTO ${RUNTIME_SCHEMA}.auth_user (id, name, email, "emailVerified", role)
          VALUES ('roles-user', 'Roles', 'roles@example.org', false, ' reviewer , admin,reviewer,,')`);
        const observe = () => binding.lookupEligibleAccountRolesCurrent('roles-user');
        const captured = await observe();
        assert.equal(Object.getPrototypeOf(captured), null);
        assert.deepEqual({ ...captured }, { accountId: 'roles-user', roles: ['admin', 'reviewer'] });
        assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured!.roles));
        assert.equal('lookupEligibleAccountRolesCurrent' in runtime, false);
        assert.equal('lookupEligibleAccountRolesCurrent' in { ...binding }, false);
        await control.query(`UPDATE ${RUNTIME_SCHEMA}.auth_user SET role = NULL WHERE id = 'roles-user'`);
        assert.deepEqual({ ...(await observe()) }, { accountId: 'roles-user', roles: [] });
        assert.deepEqual(captured!.roles, ['admin', 'reviewer']);
        await control.query(`UPDATE ${RUNTIME_SCHEMA}.auth_user SET banned = true, "banExpires" = NULL WHERE id = 'roles-user'`);
        assert.equal(await observe(), null);
        await control.query(`UPDATE ${RUNTIME_SCHEMA}.auth_user SET "banExpires" = '2000-01-01T00:00:00Z' WHERE id = 'roles-user'`);
        assert.deepEqual({ ...(await observe()) }, { accountId: 'roles-user', roles: [] });
        assert.equal(await binding.lookupEligibleAccountRolesCurrent('missing'), null);
        await assert.rejects(binding.lookupEligibleAccountRolesCurrent('\ud800'));
        runtime.close();
        await assert.rejects(observe());
      } finally {
        runtime.close();
      }
    });
    /** Starts the App's auth beside these connections; resolves when that was allowed. */
    const start = async (connections: PostgresSeparationConnection[]) => {
      const runtime = await createAppAuth(await app(LIVE!), { ...opts, excludeConnections: connections });
      runtime.close();
    };

    test("the store may not be a configured business database, and a tenant deployment's business file cannot alias it", async () => {
      await reset();
      const loaded = await app(LIVE!);
      let runtime: AppAuthRuntime | undefined;
      try {
        await assert.rejects(
          createAppAuth(loaded, { ...opts, excludeConnections: [{ url: business }, { url: LIVE! }] }).then((r) => {
            runtime = r;
          }),
          { message: SEPARATION },
        );
        // The same server, another database: a different target, allowed.
        runtime = await createAppAuth(loaded, {
          ...opts,
          excludeConnections: [{ url: business }, { url: otherDatabase(LIVE!, ELSEWHERE) }],
        });
        runtime.close();
        runtime = undefined;
        // A captured SQLite business file cannot alias a postgres:// store: the
        // store opens, with a tenant binding that reads it asynchronously.
        runtime = await createAppAuth(loaded, { ...opts, excludeStore: captureAuthStoreExclusion(business) });
        const binding = captureAppAuthRuntime(runtime);
        assert.equal(binding.synchronous, false);
        assert.throws(() => binding.lookupAccount('nobody'));
        assert.equal(await binding.lookupAccountCurrent('nobody'), null);
      } finally {
        runtime?.close();
      }
    });

    test("every spelling of the store's own address is refused before anything is opened", async () => {
      await reset();
      const live = new URL(LIVE!);
      const auth = `${live.username}:${live.password}`;
      const port = live.port || '5432';
      const database = live.pathname.slice(1);
      const spellings = [
        `postgres://${auth}@localhost:${port}/${database}`,
        `postgres://${auth}@localhost.:${port}/${database}`,
        `postgres://${auth}@[::1]:${port}/${database}`,
        `postgresql://${auth}@127.1:${port}/${database}`,
        `postgres://${auth}@decoy.invalid:${port}/${database}?host=${live.hostname}`,
        `postgres://${auth}@${live.hostname}:1/${database}?port=${port}`,
        `postgres://${auth}@localhost/${database}?host=/tmp&port=${port}`,
      ];
      for (const url of spellings) {
        await assert.rejects(start([{ url }]), { message: SEPARATION }, url.replace(auth, 'user:password'));
      }
    });

    test('the servers are asked, so an alias no URL can show is refused: a port forward, another role, other options', async () => {
      await reset();
      const live = new URL(LIVE!);
      const sockets = new Set<Socket>();
      const forward = createServer((inbound) => {
        const upstream = dial(Number(live.port || 5432), live.hostname);
        for (const socket of [inbound, upstream]) {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        }
        inbound.on('error', () => upstream.destroy());
        upstream.on('error', () => inbound.destroy());
        inbound.pipe(upstream).pipe(inbound);
      });
      await new Promise<void>((resolve) => forward.listen(0, '127.0.0.1', resolve));
      const through = (url: string) => {
        const parsed = new URL(url);
        parsed.port = String((forward.address() as AddressInfo).port);
        return parsed.toString();
      };
      try {
        const viaForward = through(LIVE!);
        const aliases = [
          viaForward,
          through(as(LIVE!, roles.alias, 'alias-password-1')),
          `${viaForward}${viaForward.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c search_path=public')}`,
        ];
        for (const url of aliases) {
          assert.doesNotThrow(() => assertPostgresAuthStoreSeparation(LIVE!, [{ url }]), 'the URL comparison cannot tell');
          await assert.rejects(start([{ url }]), { message: SEPARATION });
        }
        // Named as the registry names it, a connection is dialled the way the registry dials it.
        await assert.rejects(start([{ name: 'forwarded', url: viaForward, source: 'config' }]), { message: SEPARATION });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => forward.close(() => resolve()));
      }
    });

    test("a connection whose role can use a runtime schema holding sign-in tables on the store's server is refused, whatever its database", async () => {
      await reset();
      const elsewhere = otherDatabase(LIVE!, ELSEWHERE);
      const there = await client(elsewhere);
      try {
        await there.query(`CREATE SCHEMA IF NOT EXISTS "${RUNTIME_SCHEMA}"`);
        // That database's own runtime tables are its App's, not a reach into a sign-in store.
        await there.query(`CREATE TABLE ${RUNTIME_SCHEMA}.job_queue (id integer)`);
        await start([{ url: elsewhere }]);
        await there.query(`CREATE TABLE ${RUNTIME_SCHEMA}.auth_user (id text)`);
        const reach =
          /connection "a configured connection" can use a "mistri" schema holding auth_… tables on the authentication store's PostgreSQL server/;
        await assert.rejects(start([{ url: elsewhere }]), reach);
        const alias = as(elsewhere, roles.alias, 'alias-password-1');
        await start([{ url: alias }]); // a role without USAGE on it cannot read it: allowed
        await there.query(`GRANT USAGE ON SCHEMA "${RUNTIME_SCHEMA}" TO "${roles.alias}"`);
        await assert.rejects(start([{ url: alias }]), reach);
      } finally {
        await there.query(`DROP SCHEMA IF EXISTS "${RUNTIME_SCHEMA}" CASCADE`);
        await there.end();
      }
    });

    test('a PostgreSQL connection that cannot be reached is a refusal, said without its password', async () => {
      await reset();
      await assert.rejects(
        start([{ name: 'offline', url: 'postgres://app:offline-secret@127.0.0.1:1/app', source: 'config' }]),
        (error: unknown) => {
          assert.match((error as Error).message, /Could not confirm that connection "offline" is separate from the authentication store/);
          assert.doesNotMatch((error as Error).message, /offline-secret/);
          return true;
        },
      );
    });

    test('a business adapter on the same database never lists the store and refuses generic writes into it', async () => {
      await reset();
      await control.query(
        `INSERT INTO ${RUNTIME_SCHEMA}.auth_user (id, name, email, "emailVerified") VALUES ('u1', 'Hidden', 'hidden@example.org', false)`,
      );
      await control.query(`CREATE TABLE IF NOT EXISTS public.auth_store_business (id integer PRIMARY KEY, note text)`);
      try {
        for (const schemas of [[], [RUNTIME_SCHEMA], ['public', RUNTIME_SCHEMA]]) {
          const adapter = new PostgresAdapter(LIVE!, 'business', schemas);
          try {
            const catalog = await adapter.introspect();
            assert.equal(
              catalog.tables.some((table) => table.schema === RUNTIME_SCHEMA),
              false,
              `schemas ${JSON.stringify(schemas)}`,
            );
            if (schemas.length === 1) assert.deepEqual(catalog.tables, [], 'naming only the store lists nothing');
            else
              assert.ok(
                catalog.tables.some((table) => table.name === 'auth_store_business'),
                'the business tables are still there',
              );
          } finally {
            await adapter.close();
          }
        }
        const adapter = new PostgresAdapter(LIVE!, 'business');
        try {
          const reserved = (error: unknown) => error instanceof Refusal && error.message === 'Reserved resources are runtime-only.';
          await assert.rejects(
            adapter.insert({
              table: `${RUNTIME_SCHEMA}.auth_user`,
              values: { id: 'u2', name: 'x', email: 'x@example.org', emailVerified: false },
            }),
            reserved,
          );
          await assert.rejects(
            adapter.update({ table: `${RUNTIME_SCHEMA}.auth_user`, key: { id: 'u1' }, values: { role: 'admin' } }),
            reserved,
          );
          await assert.rejects(adapter.remove({ table: `${RUNTIME_SCHEMA}.auth_user`, key: { id: 'u1' } }), reserved);
          await assert.rejects(
            adapter.query({ table: `${RUNTIME_SCHEMA}.auth_user`, limit: 1, offset: 0 }),
            'the hidden table is not readable by name either',
          );
        } finally {
          await adapter.close();
        }
        const rows = await control.query(`SELECT id, role FROM ${RUNTIME_SCHEMA}.auth_user ORDER BY id`);
        assert.deepEqual(rows.rows, [{ id: 'u1', role: null }]);
      } finally {
        await control.query('DROP TABLE IF EXISTS public.auth_store_business');
      }
    });
  });
});
