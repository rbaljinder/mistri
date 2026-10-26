/**
 * Tenant jobs and event delivery, through a real enrollment and job host, on
 * SQLite and, when `TABLEWALK_TEST_PG` names a disposable server, PostgreSQL
 * (TABLEWALK_REQUIRE_LIVE=1 makes a missing server fail). Every PostgreSQL
 * test owns a database named by a UUID and drops it afterwards.
 *
 * A member's tenant command emits a fact; two jobs start on it, one per
 * realm: a tenant command run as the tenant's service (`service:tenant-clock`)
 * and a platform command run as the platform's (`service:lender-desk`). The
 * control connection reads what the database holds, not what the host says.
 *
 * 1. Each hop is at least once and the business effect once: a lost delivery
 *    acknowledgement redelivers and replays the job; a lost job outcome looks
 *    the receipt up. Receipts name the service in its realm's namespace.
 * 2. The event's tenant bounds both realms: another tenant's row is not there.
 * 3. A suspension before an attempt is not authorized: the tenant's stops the
 *    tenant command, the platform's stops both.
 * 4. A suspension during an attempt refuses it with nothing applied. On
 *    PostgreSQL, two clients race for the tenant row both ways round.
 * 5. Removing the grant stops the next attempt; revoking the emitting member
 *    stops nothing.
 * 6. The stores are attested, never created.
 * 7. Cycles, a job command with events or a lookup, a principal in the wrong
 *    realm and webhook effects stay refused.
 * 8. The service principal, delivery routes and journal provenance, as units.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  captureCommandJournalMember,
  captureCommandJournalPlatform,
  captureCommandJournalTenant,
  COMMAND_JOURNAL_TABLES as journal,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { EVENT_DELIVERY_TABLES as deliveryTables } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { eventDeliveryRouteFor } from '../packages/mistri/src/adapters/events/eventDeliverySource.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { configurePostgresPools, PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { tenantBusinessApp, type AppDef } from '../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { post } from '../packages/mistri/src/server/commands/commandEffects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';
import { jobCommandKey } from '../packages/mistri/src/server/jobs/jobCommands.js';
import { nextIdleWait, type JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import {
  capturedJobModule,
  defineJob,
  defineJobs,
  JobDeclarationError,
  type JobModule,
} from '../packages/mistri/src/server/jobs/jobModule.js';
import {
  inspectEventDeliveries,
  inspectEventDeliveryAttempts,
  inspectJobAttempts,
  inspectJobs,
  provisionStores,
  redriveJobs,
  tenantJobPolicies,
} from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { serviceCommandKind } from '../packages/mistri/src/server/tenant/tenantCommandKindService.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { assertTenantJobs, openTenantJobHost } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  captureServiceEvidence,
  composeServiceScope,
  serviceAnchor,
  serviceJournalOwner,
  type TenantServiceEvidence,
} from '../packages/mistri/src/server/tenant/tenantServiceModel.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';
import { namedCommands, parseTestApp } from './support/commandCatalog.js';
import { VALIDATE, validating } from './support/validation.js';

type Row = Record<string, unknown>;
type Request = { readonly account: string };
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const binding = { appId: 'tenant-jobs', source: { id: 'business', connection: 'jobs-business' }, storeId: 'tenant-jobs-store' };
const HOUR = 3_600_000;

/* ---------- the App, its commands and its jobs ---------- */

const manifest = () => ({
  id: binding.appId,
  name: 'Tenant jobs',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    task: {
      access: 'write',
      owner: 'tenant',
      actions: {
        advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } },
        flag: { label: 'Flag', command: { id: 'flag', version: 1, target: 'task', input: {} } },
        review: { label: 'Review', command: { id: 'review', version: 1, target: 'task', input: {}, realm: 'platform' } },
      },
    },
    review: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, commands: ['advance'] },
      // The two services' roles: a command each, no generic write, no operations.
      clock: { realm: 'tenant', read: true, commands: ['flag'] },
      desk: { realm: 'platform', read: true, commands: ['review'] },
    },
  },
  views: { tasks: { kind: 'list', from: 'task' }, dealers: { kind: 'list', from: 'dealer' } },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['tasks'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
  ],
  home: 'tasks',
});
const app = parseTestApp(manifest(), 'tenant-jobs.ts');
/** The App with a role's command grants replaced: what a revoked grant looks like. */
const regranted = (role: 'clock' | 'desk', commands: string[]): AppDef => ({
  ...app,
  auth: { ...app.auth!, roles: { ...app.auth!.roles!, [role]: { ...app.auth!.roles![role], commands } } },
});

const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { dealer: { kind: 'platform' }, task: { kind: 'tenant', column: 'tenant_id' }, review: { kind: 'platform' } },
  resolveMembershipRows: () => ({ task: true }),
  resolveRows: () => ({ task: true }),
  resolvePlatformRows: () => ({ dealer: true, task: true, review: true }),
  resultReferences: { advance: () => [], flag: () => [], review: () => [] },
});

type Advanced = { taskId: string; target: string; version: number };
const advanced = defineEvent('task.advanced', shape({ taskId: text(), target: text(), version: int() }));
const advanceOutput = {
  parse(value: unknown) {
    const data = value as Record<string, unknown>;
    if (!data || typeof data.taskId !== 'string' || typeof data.target !== 'string' || !Number.isSafeInteger(data.version))
      throw new Error('Bad output');
    return { taskId: data.taskId, target: data.target, version: data.version as number };
  },
};
const output = { parse: (value: unknown) => value as Record<string, unknown> };
/** Held inside the tenant job's command, where the writer holds its fence: the race's other client runs then. */
let gate: (() => Promise<void>) | undefined;
const commands = defineCommands({
  // A member's command: its fact names the task and the one its follow-up points at.
  advance: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output: advanceOutput,
    events: {
      advanced: defineEventProjection(advanced, (value: Advanced) => ({
        taskId: value.taskId,
        target: value.target,
        version: value.version,
      })),
    },
    async handle({ db, record }) {
      const { version } = await db.task.update(record, { version: Number(record.version) + 1 });
      return { taskId: String(record.id), target: String(record.follow_up ?? record.id), version: Number(version) };
    },
  }),
  // The tenant service's command.
  flag: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output,
    async handle({ db, record }) {
      await gate?.();
      await db.task.update(record, { flagged: Number(record.flagged) + 1, version: Number(record.version) + 1 });
      return { flagged: true };
    },
  }),
  // The platform service's: a tenant row's field, and a platform row.
  review: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'task',
    read: ['dealer'],
    write: ['review'],
    input: {},
    output,
    async handle({ db, record }) {
      const reviewed = Number(record.reviewed) + 1;
      await db.task.update(record, { reviewed });
      await db.review.insert({ id: `review-${String(record.id)}-${reviewed}`, task_id: record.id, note: 'Reviewed' });
      return { reviewed };
    },
  }),
});
const principals = { 'tenant-clock': { roles: ['clock'] }, 'lender-desk': { roles: ['desk'] } };
const store = { namespace: 'tenant-jobs', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } };
const jobsModule = defineJobs(
  {
    flagTask: defineJob({
      on: { event: advanced, command: 'advance' },
      runAs: 'tenant-clock',
      command: 'flag',
      schedule: (event: Advanced) => ({ key: { id: event.target } }),
    }),
    reviewTask: defineJob({
      on: { event: advanced, command: 'advance' },
      runAs: 'lender-desk',
      command: 'review',
      schedule: (event: Advanced) => ({ key: { id: event.target } }),
    }),
  },
  { principals, store },
);
const policies = tenantJobPolicies(binding, { commands, jobs: jobsModule });
const destination = (job: 'flagTask' | 'reviewTask') => policies.destinations.find((entry) => entry.job === job)!.policy;

/* ---------- the engines ---------- */

const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE task (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL, follow_up TEXT,
      version INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE review (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES task(id), note TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.task (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL, follow_up text,
      version integer NOT NULL DEFAULT 0, flagged integer NOT NULL DEFAULT 0, reviewed integer NOT NULL DEFAULT 0);
    CREATE TABLE public.review (id text PRIMARY KEY, task_id text NOT NULL REFERENCES public.task(id), note text NOT NULL);`,
};
// n2's follow-up is another tenant's task: a fact that names it must reach nothing.
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO task (id, tenant_id, name, follow_up) VALUES ('n1', 'north', 'North one', NULL), ('n2', 'north', 'North two', 's1'),
      ('s1', 'south', 'South one', NULL);`;

interface Lab {
  readonly dialect: Dialect;
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string; listen?: string }>;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  /** The next store statement that matches fails, once, as a lost acknowledgement would. */
  failOnce(pattern: RegExp): { restore(): void; fired(): boolean };
  /** The tenant event store alone, as an App whose commands emit without jobs provisions it. */
  provisionEvents(): Promise<unknown>;
  /** What --jobs needs, as an operator provisions it: the public maintenance step. */
  provision(module?: JobModule, registry?: BusinessCommandRegistry): Promise<unknown>;
  /** The reserved tables and sequences, by name. */
  layout(): Promise<string[]>;
  /** PostgreSQL: a further plain client, for the race's other side. */
  session(): Promise<Control>;
  /** SQLite: the control handle. */
  sqlite(): DatabaseSync;
}
const lost = () => new Error('injected: the acknowledgement was lost');

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-jobs-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(SCHEMA.sqlite + ROWS);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  return {
    dialect: 'sqlite',
    target: { sqlite: path },
    source: { ...binding.source, existingPath: path },
    rows: async (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    async admin(run) {
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
    failOnce(pattern) {
      const prepare = DatabaseSync.prototype.prepare;
      let fired = false;
      DatabaseSync.prototype.prepare = function (sql) {
        if (!fired && pattern.test(sql)) {
          fired = true;
          throw lost();
        }
        return Reflect.apply(prepare, this, [sql]);
      };
      return {
        restore: () => {
          DatabaseSync.prototype.prepare = prepare;
        },
        fired: () => fired,
      };
    },
    provisionEvents: async () => provisionStores({ sqlite: path }, { app: { tenant: binding } }),
    provision: async (module = jobsModule, registry = commands) =>
      await provisionStores({ sqlite: path }, { app: { tenant: binding, commands: registry }, jobs: module }),
    layout: async () =>
      db
        .prepare(`SELECT name FROM sqlite_schema WHERE name LIKE '\\_\\_mistri\\_%' ESCAPE '\\' ORDER BY name`)
        .all()
        .map((row) => String(row.name)),
    session: () => Promise.reject(new Error('A SQLite lab has no further session.')),
    sqlite: () => db,
  };
}

async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('mistri_tenant_jobs');
  const control = await pgClient(url),
    sessions: Control[] = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((session) => session.end()));
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(SCHEMA.postgres + ROWS);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  return {
    dialect: 'postgres',
    target: { postgres: url },
    source: { ...binding.source, url },
    rows: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows.map((row) => ({ ...row })),
    async admin(run) {
      await control.query('BEGIN');
      const operations = new TransactionOperations();
      try {
        await run(createPostgresTenantAdministration(control, operations, binding));
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    },
    failOnce(pattern) {
      const withWriteClient = PgConnectionManager.prototype.withWriteClient;
      let fired = false;
      PgConnectionManager.prototype.withWriteClient = function <T>(
        run: (client: PgQuery) => Promise<T>,
        destroyAfter?: boolean,
      ): Promise<T> {
        return Reflect.apply(withWriteClient, this, [
          (client: PgQuery) => {
            const wrapped = Object.create(client) as PgQuery;
            Object.defineProperty(wrapped, 'query', {
              value: (text: string, params?: unknown[]) => {
                if (!fired && pattern.test(String(text))) {
                  fired = true;
                  return Promise.reject(lost());
                }
                return client.query(text, params);
              },
            });
            return run(wrapped);
          },
          destroyAfter,
        ]) as Promise<T>;
      };
      return {
        restore: () => {
          PgConnectionManager.prototype.withWriteClient = withWriteClient;
        },
        fired: () => fired,
      };
    },
    provisionEvents: () => provisionStores({ postgres: url }, { app: { tenant: binding } }),
    provision: (module = jobsModule, registry = commands) =>
      provisionStores({ postgres: url }, { app: { tenant: binding, commands: registry }, jobs: module }),
    layout: async () =>
      (
        await control.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'mistri' AND c.relkind IN ('r', 'S') ORDER BY c.relname`)
      ).rows.map((row) => String(row.relname)),
    async session() {
      const created = await pgClient(url);
      sessions.push(created);
      return created;
    },
    sqlite: () => {
      throw new Error('A PostgreSQL lab has no SQLite handle.');
    },
  };
}

/** Two tenants and the platform, active; Ada a member of both. Provisioned for jobs unless asked not to be. */
async function openLab(t: TestContext, dialect: Dialect, provision = true): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  if (provision) await lab.provision();
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    for (const tenantId of ['north', 'south'])
      await admin.putMembership({
        tenantId,
        accountId: 'ada',
        membershipId: `${tenantId}-ada`,
        status: 'active',
        roles: ['staff'],
        validUntil: Date.now() + HOUR,
        expectedVersion: null,
      });
  });
  return lab;
}

async function enroll(t: TestContext, lab: Lab, patch: { app?: AppDef; registry?: BusinessCommandRegistry; jobs?: JobModule | null } = {}) {
  const enrollment = await createTenantEnrollment<Request>({
    app: patch.app ?? app,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['staff', 'clock', 'desk'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: patch.registry ?? commands },
    ...(patch.jobs === null ? {} : { jobs: { module: patch.jobs ?? jobsModule } }),
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

/** The host's clock starts an hour back and only moves on. Maintenance keeps
 * the real clock, and a store refuses a clock that runs back past its own. */
const clockOf = () => ({ now: Date.now() - HOUR });
async function hostOf(t: TestContext, enrollment: TenantEnrollment<Request>, clock: { now: number }, options: { app?: () => AppDef } = {}) {
  const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000, ...options });
  assert.ok(host, 'an enrollment with jobs opens a host');
  t.after(() => host.stop());
  return host;
}
/** Tick, and move the host's clock on, until the store says so. */
async function until(host: JobHost, clock: { now: number }, done: () => Promise<boolean>) {
  for (let step = 0; step < 60; step++) {
    if (await done()) return;
    await host.tick();
    if (await done()) return;
    clock.now += 2_000;
  }
  assert.fail('the host never got there');
}

const count = async (lab: Lab, table: string, where = '') =>
  Number((await lab.rows(`SELECT CAST(count(*) AS INTEGER) AS n FROM "${table}"${where ? ` WHERE ${where}` : ''}`))[0].n);
const task = async (lab: Lab, id: string) =>
  (await lab.rows(`SELECT id, tenant_id, version, flagged, reviewed FROM task WHERE id = '${id}'`)).map((row) => ({
    ...row,
    version: Number(row.version),
    flagged: Number(row.flagged),
    reviewed: Number(row.reviewed),
  }))[0];
const receipts = (lab: Lab, command: string) =>
  lab.rows(`SELECT r.realm, r.tenant_id, r.actor_id, r.idempotency_key, r.request_id,
  a.owner_tenant_id, a.membership_id, a.membership_version, a.realm_version, a.roles_json
  FROM "${journal.receipt}" r JOIN ${auditRows(lab.dialect)} a ON a.receipt_id = r.id WHERE r.command_id = '${command}' ORDER BY r.completed_at, r.id`);
const version = async (lab: Lab, id: string) =>
  String((await lab.rows(`SELECT version FROM "__mistri_tenant_tenant" WHERE id = '${id}'`))[0].version);
/* The App's own jobs. The built-in retention job (server/retention.ts) runs on a wall-clock schedule, so whether the
   host's moving clock crosses its hour depends on when the test runs: it is left out of every count here. */
const jobs = async (lab: Lab) => (await inspectJobs(lab.target, policies.store)).rows.filter((row) => row.job !== 'mistri-retention');
const jobState = async (lab: Lab, id: string) => (await jobs(lab)).find((row) => row.id === id)!;
const settled = async (lab: Lab, total: number) => {
  const rows = await jobs(lab);
  return rows.length === total && rows.every((row) => ['succeeded', 'failed'].includes(row.state));
};
const jobOf = async (lab: Lab, job: 'flagTask' | 'reviewTask', eventId: string) => {
  const found = await lab.rows(`SELECT id, provenance_json FROM "${JOB_TABLES.job}" WHERE job = '${job}'`);
  const row = found.find((candidate) => JSON.parse(String(candidate.provenance_json)).causationId === eventId);
  assert.ok(row, `a ${job} job for the event`);
  return { id: String(row.id), provenance: JSON.parse(String(row.provenance_json)) as Row };
};

/** A member's advance, at the task's current version: its receipt's one event id. */
async function advance(lab: Lab, enrollment: TenantEnrollment<Request>, tenant: string, id: string, key: string): Promise<string> {
  const current = (await task(lab, id)).version;
  const result = await enrollment.deployment.execute({ account: 'ada' }, [tenant], {
    command: 'advance',
    commandVersion: 1,
    key: { id },
    expectedVersion: current,
    idempotencyKey: key,
    input: {},
  });
  assert.equal(result.replayed, false);
  const [event] = await lab.rows(`SELECT event_id FROM "${eventTables.event}" WHERE receipt_id = '${result.receiptId}'`);
  return String(event.event_id);
}
async function setStatus(lab: Lab, tenantId: string, status: 'suspended' | 'active') {
  const expectedVersion = await version(lab, tenantId);
  await lab.admin((admin) =>
    tenantId === '@platform' ? admin.putPlatform({ status, expectedVersion }) : admin.putTenant({ tenantId, status, expectedVersion }),
  );
}
/** Until PostgreSQL shows a session of this database waiting on a lock. */
async function waitForLock(lab: Lab) {
  for (let step = 0; step < 200; step++) {
    const [row] = await lab.rows(`SELECT CAST(count(*) AS INTEGER) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(row.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('nothing ever waited on the tenant row');
}

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant jobs on ${dialect}`, { skip }, () => {
    test('an idle host waits long, and a fact written in this process wakes it at once', async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      // Idle, this host would not look again for a minute: only the wake can make the test pass in time.
      const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000, maxIdleMs: 60_000 });
      assert.ok(host);
      t.after(() => host.stop());
      host.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await advance(lab, enrollment, 'north', 'n1', 'advance-wake-0001');
      const deadline = Date.now() + 10_000;
      while (!(await settled(lab, 2))) {
        assert.ok(Date.now() < deadline, 'the wake reached the idle host');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });

    /* Deaf to this process's own signal, the host hears only what a host in
     another process would: the NOTIFY the fact's commit delivers. Idle, it
     would not look again for a minute. */
    test(
      'a fact is heard at its commit, as a host in another process hears it',
      { skip: dialect === 'postgres' ? false : 'PostgreSQL only' },
      async (t) => {
        const lab = await openLab(t, dialect),
          enrollment = await enroll(t, lab),
          clock = clockOf();
        const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000, maxIdleMs: 60_000, wakeInProcess: false });
        assert.ok(host);
        t.after(() => host.stop());
        host.start();
        const listening = Date.now() + 10_000;
        while (
          !(
            await lab.rows(
              `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN mistri_command_events%'`,
            )
          ).length
        ) {
          assert.ok(Date.now() < listening, 'the host listens');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        await advance(lab, enrollment, 'north', 'n1', 'advance-notify-0001');
        const deadline = Date.now() + 10_000;
        while (!(await settled(lab, 2))) {
          assert.ok(Date.now() < deadline, 'the commit woke the idle host');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    );

    /* Behind a transaction-mode pooler the host cannot LISTEN on the source's URL; the connection's "listen" is
       where it does (tenantStartup.ts resolves it into the enrollment's source). */
    test(
      'behind a transaction pooler the host listens on the source\'s "listen" URL, and nowhere without one',
      { skip: dialect === 'postgres' ? false : 'PostgreSQL only' },
      async (t) => {
        configurePostgresPools({ pooler: 'transaction' });
        t.after(() => configurePostgresPools({}));
        const listeners = (lab: Lab) =>
          lab.rows(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN mistri_command_events%'`);
        const open = async (lab: Lab, source: Lab['source']) => {
          const enrollment = await enroll(t, { ...lab, source });
          const host = await openTenantJobHost(enrollment, {
            now: () => Date.now() - HOUR,
            idleMs: 60_000,
            maxIdleMs: 60_000,
            wakeInProcess: false,
          });
          assert.ok(host);
          t.after(() => host.stop());
          host.start();
          return host;
        };
        const without = await openLab(t, dialect);
        await open(without, without.source);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal((await listeners(without)).length, 0, 'no LISTEN behind the pooler without a "listen" URL');

        const direct = await openLab(t, dialect);
        await open(direct, { ...direct.source, listen: (direct.target as { postgres: string }).postgres });
        const deadline = Date.now() + 10_000;
        while (!(await listeners(direct)).length) {
          assert.ok(Date.now() < deadline, 'the host listens on the "listen" URL');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    );

    test('one tenant fact runs both jobs once each, in their own realms, however often a hop is repeated or its answer lost', async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const eventId = await advance(lab, enrollment, 'north', 'n1', 'advance-north-0001');

      // The flag destination's delivery is accepted by the job store; its acknowledgement is lost.
      const lostAcknowledgement = lab.failOnce(/(?:__mistri_|mistri\.")delivery_attempt" SET outcome/);
      const first = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000 });
      assert.ok(first);
      try {
        await first.tick();
      } finally {
        lostAcknowledgement.restore();
      }
      assert.ok(lostAcknowledgement.fired());
      assert.equal(await count(lab, JOB_TABLES.job, "job = 'flagTask'"), 1, 'the job store accepted before the acknowledgement was lost');
      assert.equal(first.readiness().find((check) => check.name === 'events.delivery')?.code, 'worker_halted');
      // One host per deployment: a second refuses while the first is open.
      await assert.rejects(openTenantJobHost(enrollment), TenantContextError);
      await first.stop();

      // Restarted past the delivery lease: the same fact is sent again and replays its job.
      clock.now += 31_000;
      const second = await hostOf(t, enrollment, clock);
      await until(second, clock, async () => (await jobs(lab)).length === 2 && (await jobs(lab)).every((row) => row.state === 'succeeded'));
      assert.equal(await count(lab, JOB_TABLES.job), 2, 'one job per destination, whatever was re-sent');
      assert.deepEqual(
        (await inspectEventDeliveries(lab.target, destination('flagTask'))).rows.map((row) => [row.eventId, row.state]),
        [[eventId, 'delivered']],
      );
      assert.deepEqual(
        (await inspectEventDeliveryAttempts(lab.target, destination('flagTask'), eventId)).map((row) => row.outcome),
        ['unknown', 'accepted'],
      );
      assert.deepEqual(
        (await inspectEventDeliveries(lab.target, destination('reviewTask'))).rows.map((row) => row.state),
        ['delivered'],
      );

      // Each job ran its command once, as its service, in its realm's namespace.
      const flagJob = await jobOf(lab, 'flagTask', eventId),
        reviewJob = await jobOf(lab, 'reviewTask', eventId);
      assert.equal(flagJob.provenance.tenantId, 'north', "the fact's tenant, copied from its verified envelope");
      assert.equal(flagJob.provenance.actorId, 'ada');
      assert.deepEqual(await receipts(lab, 'flag'), [
        {
          realm: 'tenant',
          tenant_id: 'north',
          actor_id: 'service:tenant-clock',
          idempotency_key: jobCommandKey('flagTask', 1, eventId),
          request_id: `job:${flagJob.id}:1`,
          owner_tenant_id: 'north',
          membership_id: 'service:tenant-clock',
          membership_version: '0',
          realm_version: await version(lab, 'north'),
          roles_json: '["clock"]',
        },
      ]);
      assert.deepEqual(await receipts(lab, 'review'), [
        {
          realm: 'platform',
          tenant_id: '',
          actor_id: 'service:lender-desk',
          idempotency_key: jobCommandKey('reviewTask', 1, eventId),
          request_id: `job:${reviewJob.id}:1`,
          owner_tenant_id: 'north',
          membership_id: 'service:lender-desk',
          membership_version: '0',
          realm_version: await version(lab, '@platform'),
          roles_json: '["desk"]',
        },
      ]);
      // Three commands on the one row, each a revision: the member's, the tenant service's, the platform service's.
      assert.deepEqual(await task(lab, 'n1'), { id: 'n1', tenant_id: 'north', version: 3, flagged: 1, reviewed: 1 });
      assert.deepEqual(await lab.rows('SELECT id, task_id FROM review'), [{ id: 'review-n1-1', task_id: 'n1' }]);
      // A service's receipt records no fact: the member's batch is the only one.
      assert.equal(await count(lab, journal.receipt, 'manifest_json IS NOT NULL'), 1);

      // A second fact; one job's command commits and its outcome is lost.
      const again = await advance(lab, enrollment, 'north', 'n1', 'advance-north-0002');
      const lostOutcome = lab.failOnce(/(?:__mistri_|mistri\.")job_attempt" SET outcome/);
      try {
        await until(second, clock, async () => lostOutcome.fired());
      } finally {
        lostOutcome.restore();
      }
      assert.equal(second.readiness().find((check) => check.name === 'jobs')?.code, 'worker_halted');
      await second.stop();
      // After the job lease the attempt is unknown; the next looks the receipt up instead of running again.
      clock.now += 21_000;
      const third = await hostOf(t, enrollment, clock);
      await until(third, clock, async () => (await jobs(lab)).length === 4 && (await jobs(lab)).every((row) => row.state === 'succeeded'));
      const lostJob = (await jobs(lab)).find((row) => row.attempts === 2)!;
      assert.deepEqual(
        (await inspectJobAttempts(lab.target, policies.store, lostJob.id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'lease_expired'],
          ['succeeded', 'succeeded'],
        ],
      );
      for (const [command, job] of [
        ['flag', 'flagTask'],
        ['review', 'reviewTask'],
      ] as const) {
        assert.deepEqual(
          (await receipts(lab, command)).map((row) => row.idempotency_key),
          [jobCommandKey(job, 1, eventId), jobCommandKey(job, 1, again)],
          `one ${command} receipt per fact`,
        );
      }
      assert.deepEqual(await task(lab, 'n1'), { id: 'n1', tenant_id: 'north', version: 6, flagged: 2, reviewed: 2 });
      // The platform's receipts sit beside the tenant batches; nothing halted on them.
      assert.deepEqual(
        third.readiness().map((check) => check.state),
        ['ready', 'ready'],
      );
    });

    test("the event's tenant bounds both realms: a key naming another tenant's row finds nothing, and nothing of it changes", async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const before = await task(lab, 's1');
      // n2's fact names s1, south's task, as both jobs' target.
      const eventId = await advance(lab, enrollment, 'north', 'n2', 'advance-north-cross-0001');
      const host = await hostOf(t, enrollment, clock);
      await until(host, clock, () => settled(lab, 2));
      assert.deepEqual(
        (await jobs(lab)).map((row) => [row.state, row.lastCode]),
        [
          ['failed', 'rejected'],
          ['failed', 'rejected'],
        ],
        "not in the tenant's scope: refused, never retried",
      );
      assert.deepEqual(await task(lab, 's1'), before);
      assert.deepEqual([...(await receipts(lab, 'flag')), ...(await receipts(lab, 'review'))], []);
      assert.equal(await count(lab, 'review'), 0);
      assert.equal((await jobOf(lab, 'flagTask', eventId)).provenance.tenantId, 'north');
      // South's own fact about its own task runs, in south's namespace.
      const south = await advance(lab, enrollment, 'south', 's1', 'advance-south-0001');
      await until(host, clock, () => settled(lab, 4));
      assert.deepEqual(
        (await receipts(lab, 'flag')).map((row) => [row.realm, row.tenant_id, row.idempotency_key]),
        [['tenant', 'south', jobCommandKey('flagTask', 1, south)]],
      );
      assert.deepEqual(
        (await receipts(lab, 'review')).map((row) => [row.realm, row.tenant_id, row.owner_tenant_id]),
        [['platform', '', 'south']],
      );
    });

    test("a suspension before an attempt is not authorized: the tenant's stops its command, the platform's both; redriven once active, it runs", async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const eventId = await advance(lab, enrollment, 'north', 'n1', 'advance-before-0001');
      await setStatus(lab, 'north', 'suspended');
      const host = await hostOf(t, enrollment, clock);
      await until(host, clock, () => settled(lab, 2));
      const flagJob = await jobOf(lab, 'flagTask', eventId),
        reviewJob = await jobOf(lab, 'reviewTask', eventId);
      assert.deepEqual([(await jobState(lab, flagJob.id)).state, (await jobState(lab, flagJob.id)).lastCode], ['failed', 'not_authorized']);
      // A platform command fences `@platform` alone: a suspended dealer's fact is still reviewed.
      assert.equal((await jobState(lab, reviewJob.id)).state, 'succeeded');
      assert.deepEqual(await receipts(lab, 'flag'), []);
      assert.equal((await task(lab, 'n1')).flagged, 0);

      // Active again and redriven: it runs, once.
      await setStatus(lab, 'north', 'active');
      await redriveJobs(lab.target, policies.store, { ids: [flagJob.id], operator: 'operator-jobs' });
      clock.now = Math.max(clock.now, Date.now()) + 1_000;
      await until(host, clock, async () => (await jobState(lab, flagJob.id)).state === 'succeeded');
      assert.equal((await task(lab, 'n1')).flagged, 1);

      // The platform suspended: neither realm runs.
      const later = await advance(lab, enrollment, 'north', 'n1', 'advance-before-0002');
      await setStatus(lab, '@platform', 'suspended');
      await until(host, clock, () => settled(lab, 4));
      for (const job of ['flagTask', 'reviewTask'] as const) {
        const refused = await jobState(lab, (await jobOf(lab, job, later)).id);
        assert.deepEqual([refused.state, refused.lastCode], ['failed', 'not_authorized']);
      }
      assert.equal((await receipts(lab, 'flag')).length, 1);
      assert.equal((await receipts(lab, 'review')).length, 1);
    });

    test('a suspension during an attempt refuses it with nothing applied, and the next attempt is not authorized', async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const eventId = await advance(lab, enrollment, 'north', 'n1', 'advance-during-0001');
      const host = await hostOf(t, enrollment, clock);
      if (dialect === 'sqlite') {
        // Between the attempt's admission and its fence: its reader holds the
        // snapshot it read the anchors from, and the suspension commits beside it (WAL).
        const db = lab.sqlite(),
          prepare = DatabaseSync.prototype.prepare;
        let fired = false;
        DatabaseSync.prototype.prepare = function (sql) {
          if (!fired && this !== db && sql.includes('"__mistri_tenant_tenant" WHERE id = ? COLLATE BINARY AND kind = ?')) {
            fired = true;
            Reflect.apply(prepare, db, [
              `UPDATE "__mistri_tenant_tenant" SET status = 'suspended', version = '2' WHERE id = 'north'`,
            ]).run();
          }
          return Reflect.apply(prepare, this, [sql]);
        };
        try {
          await host.tick();
        } finally {
          DatabaseSync.prototype.prepare = prepare;
        }
        assert.ok(fired);
      } else {
        // The suspension holds the tenant row first: the attempt's fence waits for it, then sees that it moved.
        const other = await lab.session();
        await other.query('BEGIN');
        const operations = new TransactionOperations();
        await createPostgresTenantAdministration(other, operations, binding).putTenant({
          tenantId: 'north',
          status: 'suspended',
          expectedVersion: '1',
        });
        const ticking = host.tick();
        await waitForLock(lab);
        await operations.finish();
        await other.query('COMMIT');
        await ticking;
      }
      const flagJob = await jobOf(lab, 'flagTask', eventId);
      const retried = await jobState(lab, flagJob.id);
      assert.deepEqual(
        [retried.state, retried.lastCode],
        ['retry', 'handler_error'],
        'refused by the fence: nothing applied, and it asks again',
      );
      assert.deepEqual(await receipts(lab, 'flag'), []);
      assert.equal((await task(lab, 'n1')).flagged, 0);
      await until(host, clock, async () => (await jobState(lab, flagJob.id)).state === 'failed');
      assert.equal((await jobState(lab, flagJob.id)).lastCode, 'not_authorized');
      assert.deepEqual(await receipts(lab, 'flag'), []);
    });

    test("the emitting member's revocation stops nothing; a revoked grant stops the next attempt until it is restored", async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const eventId = await advance(lab, enrollment, 'north', 'n1', 'advance-revoked-0001');
      await lab.admin((admin) =>
        admin.putMembership({
          tenantId: 'north',
          accountId: 'ada',
          membershipId: 'north-ada',
          status: 'revoked',
          roles: ['staff'],
          validUntil: Date.now() + HOUR,
          expectedVersion: '1',
        }),
      );
      // The App each attempt asks no longer grants the tenant service's command.
      let current = regranted('clock', []);
      const host = await hostOf(t, enrollment, clock, { app: () => current });
      await until(host, clock, () => settled(lab, 2));
      const flagJob = await jobOf(lab, 'flagTask', eventId);
      assert.deepEqual([(await jobState(lab, flagJob.id)).state, (await jobState(lab, flagJob.id)).lastCode], ['failed', 'not_authorized']);
      assert.equal(
        (await jobState(lab, (await jobOf(lab, 'reviewTask', eventId)).id)).state,
        'succeeded',
        'no membership: a revoked member stops no job',
      );
      assert.deepEqual(await receipts(lab, 'flag'), []);
      // Restored and redriven: it runs, though Ada is still revoked.
      current = app;
      await redriveJobs(lab.target, policies.store, { ids: [flagJob.id], operator: 'operator-jobs' });
      clock.now = Math.max(clock.now, Date.now()) + 1_000;
      await until(host, clock, async () => (await jobState(lab, flagJob.id)).state === 'succeeded');
      assert.deepEqual(
        (await receipts(lab, 'flag')).map((row) => row.actor_id),
        ['service:tenant-clock'],
      );
      // The enrolled App is the ceiling: without the grant there, the deployment itself refuses.
      await assert.rejects(enroll(t, lab, { app: regranted('desk', []) }), TenantContextError);
    });

    if (dialect === 'postgres')
      test('PostgreSQL: an attempt holding the tenant row commits first, and the suspension waits for it', async (t) => {
        const lab = await openLab(t, dialect),
          enrollment = await enroll(t, lab),
          clock = clockOf();
        const first = await advance(lab, enrollment, 'north', 'n1', 'advance-race-0001');
        const second = await advance(lab, enrollment, 'north', 'n1', 'advance-race-0002');
        const host = await hostOf(t, enrollment, clock);
        let entered!: () => void, release!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate = async () => {
          gate = undefined;
          entered();
          await held;
        };
        t.after(() => {
          gate = undefined;
          release();
        });
        // The first fact's tenant job: its writer takes the tenant row FOR SHARE, then waits in its command.
        const ticking = host.tick();
        await inside;
        const other = await lab.session();
        await other.query('BEGIN');
        const operations = new TransactionOperations();
        const suspending = createPostgresTenantAdministration(other, operations, binding).putTenant({
          tenantId: 'north',
          status: 'suspended',
          expectedVersion: '1',
        });
        void suspending.catch(() => {});
        // The suspension's FOR UPDATE waits for the attempt.
        await waitForLock(lab);
        assert.equal(await version(lab, 'north'), '1');
        release();
        await ticking;
        await suspending;
        await operations.finish();
        await other.query('COMMIT');
        // Which of the two facts' jobs the host reached first is its own ordering,
        // not this test's: the proof is that exactly one attempt committed, at the
        // version it fenced, and that its receipt is that fact's own job command.
        const committed = (await receipts(lab, 'flag')).map((row) => [row.idempotency_key, row.realm_version]);
        assert.equal(committed.length, 1, 'exactly one attempt committed');
        assert.equal(committed[0][1], '1', 'the attempt committed, at the version it fenced');
        const applied = [first, second].find((event) => committed[0][0] === jobCommandKey('flagTask', 1, event));
        assert.ok(applied, 'the receipt carries the flag job key of the fact it ran for');
        assert.equal((await task(lab, 'n1')).flagged, 1);
        assert.equal(await version(lab, 'north'), '2');
        // The other fact's tenant job is not authorized now; the platform's jobs still run.
        await until(host, clock, () => settled(lab, 4));
        const refused = await jobState(lab, (await jobOf(lab, 'flagTask', applied === first ? second : first)).id);
        assert.deepEqual([refused.state, refused.lastCode], ['failed', 'not_authorized']);
        assert.equal((await receipts(lab, 'review')).length, 2);
      });

    test('the stores are attested at enrollment and never created', async (t) => {
      const lab = await openLab(t, dialect, false);
      const bare = await lab.layout();
      await assert.rejects(enroll(t, lab), TenantContextError);
      assert.deepEqual(await lab.layout(), bare, 'nothing provisioned, nothing repaired');
      // The event store alone is not enough: the job store and destinations are attested too.
      await lab.provisionEvents();
      const events = await lab.layout();
      await assert.rejects(enroll(t, lab), TenantContextError);
      assert.deepEqual(await lab.layout(), events);
      assert.equal(
        events.some((name) => name.startsWith('__mistri_job_') || name.startsWith('__mistri_delivery_')),
        false,
      );
      // Provisioned once, as an operator does, it enrolls; provisioning again changes nothing.
      assert.deepEqual(await lab.provision(), {
        stores: { 'command-events': { provisioned: false }, jobs: { provisioned: true } },
        destinations: [
          { id: 'job:flagTask@1', added: true },
          { id: 'job:reviewTask@1', added: true },
        ],
      });
      assert.deepEqual(await lab.provision(), {
        stores: { 'command-events': { provisioned: false }, jobs: { provisioned: false } },
        destinations: [
          { id: 'job:flagTask@1', added: false },
          { id: 'job:reviewTask@1', added: false },
        ],
      });
      const host = await openTenantJobHost(await enroll(t, lab));
      assert.ok(host);
      await host.stop();
      // Enrolled without jobs, there is no host.
      assert.equal(await openTenantJobHost(await enroll(t, lab, { jobs: null })), undefined);
    });
  });

/* ---------- what stays refused ---------- */

describe("what a tenant App's jobs refuse", () => {
  const job = (patch: Record<string, unknown>) =>
    defineJob({
      on: { event: advanced, command: 'advance' },
      runAs: 'tenant-clock',
      command: 'flag',
      schedule: (event: Advanced) => ({ key: { id: event.target } }),
      ...patch,
    });
  const refusedWith = async (t: TestContext, message: RegExp, module: JobModule, registry: BusinessCommandRegistry = commands) => {
    const matches = (error: unknown) => error instanceof JobDeclarationError && message.test(error.message);
    assert.throws(() => tenantJobPolicies(binding, { commands: registry, jobs: module }), matches);
    const lab = await sqliteLab(t),
      before = await lab.layout();
    await assert.rejects(
      provisionStores({ sqlite: lab.source.existingPath! }, { app: { tenant: binding, commands: registry }, jobs: module }),
      matches,
    );
    assert.deepEqual(await lab.layout(), before, 'a refused provisioning changes nothing');
  };

  test('a subscription cycle, and a job command that records events or looks up', async (t) => {
    await refusedWith(t, /cycle/, defineJobs({ loop: job({ command: 'advance' }) }, { principals }));
    const { version: _flagVersion, ...flag } = commands.flag;
    const chained = defineCommands({
      ...commands,
      flag: defineCommand({
        ...flag,
        events: { advanced: defineEventProjection(advanced, () => ({ taskId: 'n1', target: 'n1', version: 1 })) },
      }),
    });
    await refusedWith(t, /declares events/, defineJobs({ flagTask: job({}) }, { principals }), chained);
    const looking = defineCommands({
      ...commands,
      flag: defineCommand({ ...flag, sources: { business: ['dealer'] }, lookup: async () => ({}) }),
    });
    await refusedWith(t, /looks up/, defineJobs({ flagTask: job({}) }, { principals }), looking);
  });

  test('an App that keeps a platform-only source still binds its jobs, through the App its own source sees', async (t) => {
    /* The jobs runtime re-derives its catalog from the App it is handed, and a
       platform-only source's tables are deliberately absent from the App's own
       catalog — so handing it the whole App refused every tenant App that
       paired one with --jobs. Enrollment hands it tenantBusinessApp(app), the
       same projection the declarations use. */
    const raw = manifest();
    // With a second source declared, exactly one says which source's resources stay bare.
    (raw.sources as Record<string, Record<string, unknown>>).business.default = true;
    (raw.sources as Record<string, unknown>).applicants = { connection: 'applicants-db', realm: 'platform' };
    // A resource of another source is named for it; the parser reads the binding from the name.
    (raw.resources as Record<string, unknown>)['applicants.applicant'] = { owner: 'platform' };
    const outside = parseTestApp(raw, 'tenant-jobs.ts');
    const ownership = await ownedFor(t);
    assert.throws(() => assertTenantJobs(capture(jobsModule), outside, commands, ownership, binding.source.connection));
    assertTenantJobs(capture(jobsModule), tenantBusinessApp(outside), commands, ownership, binding.source.connection);
  });

  test("a principal outside its command's realm, and unprovisioned webhook effects, refuse the deployment", async (t) => {
    // A platform role granted the tenant command still may not run it: never a union of the realms.
    const crossed = defineJobs({ flagTask: job({ runAs: 'lender-desk' }) }, { principals });
    const ownership = await ownedFor(t);
    assert.throws(
      () => assertTenantJobs(capture(crossed), regranted('desk', ['review', 'flag']), commands, ownership, binding.source.connection),
      (error: unknown) => error instanceof JobDeclarationError && /must be a tenant-realm role/.test(error.message),
    );
    assert.throws(
      () => assertTenantJobs(capture(jobsModule), regranted('clock', []), commands, ownership, binding.source.connection),
      (error: unknown) => error instanceof JobDeclarationError && /is not granted command "flag"/.test(error.message),
    );
    assertTenantJobs(capture(jobsModule), app, commands, ownership, binding.source.connection);
    const lab = await openLab(t, 'sqlite');
    await assert.rejects(enroll(t, lab, { app: regranted('desk', ['review', 'flag']), jobs: crossed }), TenantContextError);
    // An effect's destination is provisioned with the server stopped: one this lab never provisioned refuses, jobs or not.
    const { version: _version, ...advance } = commands.advance;
    const effects = defineCommands({
      ...commands,
      advance: defineCommand({ ...advance, effects: { notify: post<Advanced>('dealer-hooks', (value) => ({ taskId: value.taskId })) } }),
    });
    await assert.rejects(enroll(t, lab, { registry: effects }), TenantContextError);
    await assert.rejects(enroll(t, lab, { registry: effects, jobs: null }), TenantContextError);
  });
});
/* ---------- the command line ---------- */

describe('tenant mistri check with --jobs', () => {
  const src = (path: string) => JSON.stringify(pathToFileURL(resolve('packages/mistri/src', path)).href);
  /** One server-only module the CLI's --commands and --jobs files re-export, and this test provisions from. */
  const definitions = (grant: string) => `
import { defineCommand, defineCommands } from ${src('server/commands/businessCommands.ts')};
import { defineEvent, defineEventProjection } from ${src('server/commands/businessEvents.ts')};
import { defineJob, defineJobs } from ${src('server/jobs/jobModule.ts')};
import { shape, text, int } from ${src('server/commands/commandShapes.ts')};
const advanced = defineEvent('task.advanced', shape({ taskId: text(), target: text(), version: int() }));
const output = { parse: value => value };
export const commands = defineCommands({
  advance: defineCommand({ source: 'business', target: 'task', input: {}, output,
    events: { advanced: defineEventProjection(advanced, value => ({ taskId: value.taskId, target: value.target, version: value.version })) },
    async handle({ db, record }) { const { version } = await db.task.update(record, { version: record.version + 1 });
      return { taskId: record.id, target: record.id, version }; } }),
  flag: defineCommand({ source: 'business', target: 'task', input: {}, output,
    async handle({ db, record }) { await db.task.update(record, { flagged: record.flagged + 1 }); return {}; } }),
  review: defineCommand({ realm: 'platform', source: 'business', target: 'task', read: ['dealer'],
    write: ['review'], input: {}, output, async handle({ db, record }) { await db.task.update(record, { reviewed: record.reviewed + 1 }); return {}; } }),
});
export const jobs = defineJobs({
  flagTask: defineJob({ on: { event: advanced, command: 'advance' }, runAs: 'tenant-clock',
    command: 'flag', schedule: event => ({ key: { id: event.target } }) }),
  reviewTask: defineJob({ on: { event: advanced, command: 'advance' }, runAs: 'lender-desk',
    command: 'review', schedule: event => ({ key: { id: event.target } }) }),
}, { principals: { 'tenant-clock': { roles: [${JSON.stringify(grant)}] }, 'lender-desk': { roles: ['desk'] } }, store: { namespace: 'tenant-jobs' } });
`;
  async function fixture(t: TestContext, options: { provision: boolean; grant?: string }) {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-jobs-cli-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const appDir = join(directory, 'app'),
      data = join(directory, 'data.db'),
      files = (name: string) => join(directory, name);
    mkdirSync(appDir);
    const db = new DatabaseSync(data);
    try {
      db.exec(SCHEMA.sqlite + ROWS);
    } finally {
      db.close();
    }
    provisionSqliteTenantStore(data, binding);
    migrateSqliteCommandJournal(data);
    const raw = manifest();
    // The whole manifest, both realms: authoring judges each declaration in the
    // realm it names, so the lender's view of the platform's table checks too.
    // `idle`: a role the tenant service can hold that grants its command nothing, for the refusal.
    writeFileSync(
      join(appDir, 'app.json'),
      JSON.stringify(
        namedCommands({
          ...raw,
          auth: {
            ...raw.auth,
            store: files('auth.db'),
            signUp: 'open',
            roles: { ...raw.auth.roles, idle: { realm: 'tenant', read: true } },
          },
        }).app,
      ),
    );
    writeFileSync(files('config.json'), JSON.stringify({ connections: [{ name: binding.source.connection, url: data, writable: true }] }));
    writeFileSync(
      files('policy.mjs'),
      `export default { kind: 'tenant', appId: ${JSON.stringify(binding.appId)}, storeId: ${JSON.stringify(binding.storeId)},
      ownership: { dealer: { kind: 'platform' }, task: { kind: 'tenant', column: 'tenant_id' }, review: { kind: 'platform' } },
      resolveMembershipRows: () => ({ task: true }), resolveRows: () => ({ task: true }),
      resolvePlatformRows: () => ({ dealer: true, task: true, review: true }),
      resultReferences: { advance: () => [], flag: () => [], review: () => [] } };`,
    );
    writeFileSync(files('definitions.mjs'), definitions(options.grant ?? 'clock'));
    writeFileSync(files('commands.mjs'), `export { commands as default } from './definitions.mjs';`);
    writeFileSync(files('jobs.mjs'), `export { jobs as default } from './definitions.mjs';`);
    if (options.provision) {
      const loaded = (await import(pathToFileURL(files('definitions.mjs')).href)) as { commands: BusinessCommandRegistry; jobs: JobModule };
      await provisionStores({ sqlite: data }, { app: { tenant: binding, commands: loaded.commands }, jobs: loaded.jobs });
    }
    const layout = () => {
      const read = new DatabaseSync(data, { readOnly: true });
      try {
        return read
          .prepare(`SELECT name FROM sqlite_schema WHERE name LIKE '\\_\\_mistri\\_%' ESCAPE '\\' ORDER BY name`)
          .all()
          .map((row) => String(row.name));
      } finally {
        read.close();
      }
    };
    const cli = () =>
      new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
        execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('packages/mistri/src/server/index.ts'),
            '--config',
            files('config.json'),
            '--app',
            appDir,
            '--policy',
            files('policy.mjs'),
            '--commands',
            files('commands.mjs'),
            '--jobs',
            files('jobs.mjs'),
          ],
          {
            env: validating([VALIDATE], {
              ...process.env,
              DATABASE_URL: '',
              MISTRI_OPEN: '0',
              MISTRI_PUBLIC_URL: '',
              XDG_CONFIG_HOME: join(directory, 'xdg'),
              BETTER_AUTH_SECRET: 'synthetic-tenant-jobs-cli-secret-at-least-thirty-two-characters',
            }).env,
            timeout: 30_000,
            killSignal: 'SIGKILL',
          },
          (error, stdout, stderr) => {
            if (error?.killed) return reject(new Error(`the tenant CLI timed out: ${stdout}\n${stderr}`));
            done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
          },
        );
      });
    return { cli, layout, auth: files('auth.db') };
  }

  test('a tenant App checks with --jobs beside --policy and prints its automation', async (t) => {
    const f = await fixture(t, { provision: true }),
      result = await f.cli();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'Tenant jobs: ok\n' +
        'jobs: flagTask@1 on task.advanced@1 (advance@1) → flag@1 as tenant-clock\n' +
        'jobs: reviewTask@1 on task.advanced@1 (advance@1) → review@1 as lender-desk\n',
    );
  });

  test('unprovisioned stores refuse the check and are not created; a principal its App does not grant is named', async (t) => {
    const bare = await fixture(t, { provision: false }),
      before = bare.layout();
    const missing = await bare.cli();
    assert.equal(missing.code, 1);
    // The stage names the declarations too, since enrollment captures them before it opens a store.
    assert.match(missing.stderr, /Tenant startup error: Tenant startup could not validate .*the existing tenant store/);
    assert.deepEqual(bare.layout(), before);
    const ungranted = await fixture(t, { provision: true, grant: 'idle' }),
      refused = await ungranted.cli();
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Jobs: principal "tenant-clock" \(roles idle\) is not granted command "flag" in App "tenant-jobs"\./);
    assert.doesNotMatch(refused.stdout, /: ok/);
  });
});

/** The captured module, as enrollment holds it. */
const capture = (module: JobModule) => capturedJobModule(module);
/** The fixture's attested ownership, read from a SQLite copy of its schema. */
async function ownedFor(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA.sqlite.replace('PRAGMA journal_mode=WAL;', ''));
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  return captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    schema,
    physicalSchema: structuredClone(schema),
    resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
    profile: 'dealer',
    ownership: policy.ownership,
  });
}

/* ---------- the service principal, routes and provenance, as units ---------- */

describe('the service principal', () => {
  const evidence = (patch: Partial<Record<keyof TenantServiceEvidence, unknown>> = {}): TenantServiceEvidence =>
    ({
      realm: 'service',
      appId: binding.appId,
      source: binding.source,
      deployment: 'generation-1',
      principal: 'tenant-clock',
      place: 'tenant',
      tenantId: 'north',
      tenantVersion: '3',
      platformVersion: '2',
      roles: ['clock'],
      verifiedAt: 1_000,
      validUntil: 2_000,
      ...patch,
    }) as TenantServiceEvidence;
  const platform = evidence({ principal: 'lender-desk', place: 'platform', tenantVersion: null, roles: ['desk'] });
  function owned(t: TestContext) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
      CREATE TABLE model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
      CREATE TABLE task (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
      CREATE TABLE review (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES task(id));`);
    db.exec('BEGIN IMMEDIATE');
    const schema = readSqliteScopeCatalog(db).schema;
    db.exec('COMMIT');
    return captureTenantOwnership({
      appId: binding.appId,
      source: binding.source,
      schema,
      physicalSchema: structuredClone(schema),
      resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
      profile: 'dealer',
      ownership: {
        dealer: { kind: 'platform' },
        model: { kind: 'global', access: 'read-only' },
        task: { kind: 'tenant', column: 'tenant_id' },
        review: { kind: 'platform' },
      },
    });
  }
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  test("its evidence is one tenant's event and the anchors its command fences, exactly", (t) => {
    const ownership = owned(t);
    assert.equal(captureServiceEvidence(evidence(), ownership).tenantId, 'north');
    assert.equal(captureServiceEvidence(platform, ownership).tenantVersion, null);
    for (const patch of [
      { tenantId: '@platform' },
      { tenantId: 'North' },
      { tenantVersion: null },
      { place: 'platform' },
      { place: 'support' },
      { realm: 'tenant' },
      { principal: 'Clock' },
      { principal: 'service:clock' },
      { roles: [] },
      { validUntil: 1_000 },
      { tenantVersion: '0' },
      { platformVersion: null },
      { appId: 'other' },
      { source: { id: 'business', connection: 'other' } },
    ]) {
      assert.throws(() => captureServiceEvidence(evidence(patch), ownership), TenantContextError, JSON.stringify(patch));
    }
    const { roles: _roles, ...missing } = evidence();
    assert.throws(() => captureServiceEvidence(missing, ownership), TenantContextError);
    assert.throws(() => captureServiceEvidence({ ...evidence(), accountId: 'ada' }, ownership), TenantContextError);
  });

  test("its scope is its command's footprint within the event's tenant, and the platform's rows only in the platform realm", (t) => {
    const ownership = owned(t),
      footprint = { dealer: true, model: true, task: true, review: true };
    const north = { groups: [[{ column: 'tenant_id', op: '=', value: 'north' }]], binary: ['tenant_id'] };
    assert.deepEqual(plain(composeServiceScope(ownership, evidence(), footprint)), {
      dealer: false,
      model: true,
      task: north,
      review: false,
    });
    assert.deepEqual(plain(composeServiceScope(ownership, platform, footprint)), { dealer: true, model: true, task: north, review: true });
    // Only the footprint's `true` entries; a filter there is not a grant.
    assert.deepEqual(
      plain(composeServiceScope(ownership, platform, { task: true, review: { groups: [[{ column: 'id', op: '=', value: 'r1' }]] } })),
      { dealer: false, model: false, task: north, review: false },
    );
    assert.throws(() => composeServiceScope(ownership, evidence({ tenantId: '@platform' }), footprint), TenantContextError);
  });

  test("it fences the event's tenant and the platform, or the platform alone, and its receipts name it in its realm", () => {
    assert.deepEqual(serviceAnchor(evidence()), {
      tenantId: 'north',
      tenantVersion: '3',
      platformVersion: '2',
      verifiedAt: 1_000,
      validUntil: 2_000,
    });
    assert.deepEqual(serviceAnchor(platform), {
      tenantId: '@platform',
      tenantVersion: '2',
      platformVersion: '2',
      verifiedAt: 1_000,
      validUntil: 2_000,
    });
    const tenant = captureCommandJournalMember(serviceJournalOwner(binding, evidence()));
    assert.deepEqual(
      { ...tenant, roles: [...tenant.roles] },
      {
        appId: binding.appId,
        storeId: binding.storeId,
        sourceId: 'business',
        actorId: 'service:tenant-clock',
        membershipId: 'service:tenant-clock',
        membershipVersion: '0',
        roles: ['clock'],
        deployment: 'generation-1',
        tenantId: 'north',
        tenantVersion: '3',
      },
    );
    const lender = captureCommandJournalMember(serviceJournalOwner(binding, platform));
    assert.deepEqual(
      { ...lender, roles: [...lender.roles] },
      {
        realm: 'platform',
        appId: binding.appId,
        storeId: binding.storeId,
        sourceId: 'business',
        actorId: 'service:lender-desk',
        membershipId: 'service:lender-desk',
        membershipVersion: '0',
        roles: ['desk'],
        deployment: 'generation-1',
        platformVersion: '2',
      },
    );
    // A platform command's audit rows name the event's tenant or the platform, and no other tenant.
    const place = serviceCommandKind.place(platform),
      stamp = (owner: string) => (audit: unknown) => ({ ...(audit as object), owner });
    const row = { target: 'task', keyJson: '{"id":"n1"}', changesJson: '{}' };
    for (const owner of ['north', '']) assert.equal((place.audit(row, stamp(owner) as never) as { owner: string }).owner, owner);
    assert.throws(() => place.audit(row, stamp('south') as never), TenantContextError);
    assert.throws(
      () =>
        place.audit([row, row], ((audits: object[]) => audits.map((entry, i) => ({ ...entry, owner: i ? 'south' : 'north' }))) as never),
      TenantContextError,
    );
    assert.equal(serviceCommandKind.place(evidence()).tenantId, 'north');
    assert.equal(place.tenantId, 'north', "a platform service is still bounded by the event's tenant");
    assert.throws(() => serviceCommandKind.place(evidence({ place: 'support' })), TenantContextError);
  });
});

describe('tenant delivery routes and service provenance', () => {
  const manifest1 = [{ name: 'task.advanced', version: 1 }];
  const limits = { maxAttempts: 3, leaseMs: 1_000, timeoutMs: 20, backoffMs: 10, maxBackoffMs: 20, maxRetained: 64, scanBatch: 8 };
  const source = { appId: binding.appId, storeId: binding.storeId, sourceId: binding.source.id };
  const policyOf = (routes: unknown[]): EventDeliveryPolicy => ({
    source,
    serviceId: 'svc',
    destinationId: 'dest',
    routes: routes as EventDeliveryPolicy['routes'],
    limits,
  });

  test("every tenant's route takes each tenant's receipt of its command, never an App-scope one, and never beside a named tenant's", () => {
    const every = captureEventDeliveryPolicy(
      policyOf([{ scope: 'tenants', commandId: 'advance', commandVersion: 1, manifest: manifest1 }]),
    );
    const owner = (tenantId: string) => ({ scope: 'tenant' as const, ...source, tenantId, actorId: 'ada' });
    assert.equal(eventDeliveryRouteFor(every, owner('north'), 'advance', 1)?.scope, 'tenants');
    assert.equal(eventDeliveryRouteFor(every, owner('south'), 'advance', 1)?.scope, 'tenants');
    assert.equal(eventDeliveryRouteFor(every, owner('north'), 'advance', 2), undefined);
    assert.equal(eventDeliveryRouteFor(every, { scope: 'app', ...source, actorId: 'ada' }, 'advance', 1), undefined);
    const named = captureEventDeliveryPolicy(
      policyOf([{ scope: 'tenant', tenantId: 'north', commandId: 'advance', commandVersion: 1, manifest: manifest1 }]),
    );
    assert.equal(eventDeliveryRouteFor(named, owner('south'), 'advance', 1), undefined, "a named tenant's route is as it was");
    for (const routes of [
      [
        { scope: 'tenants', commandId: 'advance', commandVersion: 1, manifest: manifest1 },
        { scope: 'tenant', tenantId: 'north', commandId: 'advance', commandVersion: 1, manifest: manifest1 },
      ],
      [{ scope: 'tenants', tenantId: 'north', commandId: 'advance', commandVersion: 1, manifest: manifest1 }],
      [
        { scope: 'tenants', commandId: 'advance', commandVersion: 1, manifest: manifest1 },
        { scope: 'tenants', commandId: 'advance', commandVersion: 1, manifest: manifest1 },
      ],
      [{ scope: 'all', commandId: 'advance', commandVersion: 1, manifest: manifest1 }],
    ])
      assert.throws(() => captureEventDeliveryPolicy(policyOf(routes)), Error, JSON.stringify(routes));
    // Another command version's named tenant is another route, taking other receipts.
    captureEventDeliveryPolicy(
      policyOf([
        { scope: 'tenants', commandId: 'advance', commandVersion: 1, manifest: manifest1 },
        { scope: 'tenant', tenantId: 'north', commandId: 'advance', commandVersion: 2, manifest: manifest1 },
      ]),
    );
  });

  test("the journal takes a service principal in the membership's place, at revision 0, with its roles, and nothing like it", () => {
    const tenant = {
      appId: binding.appId,
      storeId: binding.storeId,
      sourceId: binding.source.id,
      tenantId: 'north',
      actorId: 'service:tenant-clock',
      membershipId: 'service:tenant-clock',
      membershipVersion: '0',
      tenantVersion: '3',
      roles: ['clock'],
      deployment: 'generation-1',
    };
    assert.equal(captureCommandJournalTenant(tenant).membershipVersion, '0');
    const { tenantId: _tenant, tenantVersion: _version, ...rest } = tenant;
    const platform = {
      ...rest,
      realm: 'platform' as const,
      actorId: 'service:lender-desk',
      membershipId: 'service:lender-desk',
      platformVersion: '2',
      roles: ['desk'],
    };
    assert.equal(captureCommandJournalPlatform(platform).actorId, 'service:lender-desk');
    for (const patch of [
      { roles: [] },
      { membershipId: 'service:other' },
      { actorId: 'ada', membershipId: 'ada' },
      { actorId: 'service:Upper', membershipId: 'service:Upper' },
      { actorId: 'service:', membershipId: 'service:' },
      { tenantVersion: '0' },
      { membershipVersion: '00' },
      { membershipVersion: '' },
    ]) {
      assert.throws(() => captureCommandJournalTenant({ ...tenant, ...patch }), Error, JSON.stringify(patch));
    }
    assert.throws(() => captureCommandJournalPlatform({ ...platform, platformVersion: '0' }));
    // A member's revision is never 0, whatever its actor is called.
    assert.throws(() => captureCommandJournalTenant({ ...tenant, actorId: 'ada', membershipId: 'north-ada' }));
  });

  test("SQLite discovery passes over the platform realm's receipts, which carry no events", async (t) => {
    const lab = await openLab(t, 'sqlite'),
      enrollment = await enroll(t, lab),
      clock = clockOf();
    await advance(lab, enrollment, 'north', 'n1', 'advance-discovery-0001');
    const host = await hostOf(t, enrollment, clock);
    // The platform service's receipt commits before the next discovery runs.
    await until(host, clock, async () => (await jobs(lab)).length === 2 && (await jobs(lab)).every((row) => row.state === 'succeeded'));
    await advance(lab, enrollment, 'south', 's1', 'advance-discovery-0002');
    await until(host, clock, async () => (await jobs(lab)).length === 4 && (await jobs(lab)).every((row) => row.state === 'succeeded'));
    const tenantReceipts = await count(lab, journal.receipt, "realm = 'tenant'");
    assert.equal(await count(lab, journal.receipt, "realm = 'platform'"), 2);
    assert.equal(await count(lab, deliveryTables.receipt), 2 * tenantReceipts, 'every tenant receipt, per destination, and no other');
    assert.equal(
      Number(
        (
          await lab.rows(`SELECT CAST(count(*) AS INTEGER) AS n FROM "${deliveryTables.receipt}" d
      JOIN "${journal.receipt}" r ON r.id = d.receipt_id WHERE r.realm = 'platform'`)
        )[0].n,
      ),
      0,
    );
    assert.deepEqual(
      host.readiness().map((check) => check.code),
      ['ok', 'ok'],
    );
  });
});

test('an idle host doubles its wait from the first to the ceiling, and waits none after work', () => {
  const waits: number[] = [];
  let last: number | undefined;
  for (let i = 0; i < 8; i++) waits.push((last = nextIdleWait(last, false, 1_000, 30_000)));
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  assert.equal(nextIdleWait(30_000, true, 1_000, 30_000), 0);
  assert.equal(nextIdleWait(0, false, 1_000, 30_000), 1_000, 'after work, the first idle wait is the shortest again');
  assert.equal(nextIdleWait(undefined, false, 60_000, 30_000), 60_000, 'a first wait above the ceiling is the ceiling');
});
