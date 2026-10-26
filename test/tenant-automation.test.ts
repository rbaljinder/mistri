/**
 * Jobs at times and durable workflows on a tenant App, through a real
 * enrollment and job host, on SQLite and, when `TABLEWALK_TEST_PG` names a
 * disposable server, PostgreSQL. Every PostgreSQL test owns a database named
 * by a UUID and drops it afterwards. The control connection reads what the
 * database holds, not what the host says.
 *
 * 1. A job at times per tenant runs once for each active tenant, each run in
 *    that tenant alone: a sweep that touches every row it can see touches
 *    only its own tenant's. A suspended tenant gets no run.
 * 2. A job at times on the platform runs once, in the platform realm, and
 *    sees no tenant's row at all.
 * 3. A workflow's instance is one tenant's: two tenants' instances of the
 *    same key live side by side, an event of tenant B wakes only B's, and a
 *    step runs as the principal in that instance's tenant.
 * 4. What stays refused, and why: a job at times with no realm, or with the
 *    other realm's command; a realm on an App without tenants; a workflow
 *    principal holding a platform role; a retry that does not name the
 *    instance's tenant.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES as journal, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import { openPostgresWorkflowStore } from '../packages/mistri/src/adapters/workflows/postgresWorkflowStore.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import type { WorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStoreContract.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import { jobDeployment } from '../packages/mistri/src/server/jobs/jobLoader.js';
import {
  capturedJobModule,
  defineJob,
  defineJobs,
  JobDeclarationError,
  type JobModule,
} from '../packages/mistri/src/server/jobs/jobModule.js';
import { inspectJobs, provisionStores, retryWorkflow, tenantJobPolicies } from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { assertTenantJobs, openTenantJobHost, tenantJobDeployment } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { retryAdmits, workflowPartition } from '../packages/mistri/src/server/workflows/workflowKeys.js';
import { defineWorkflow, defineWorkflows } from '../packages/mistri/src/server/workflows/workflowModule.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
type Request = { readonly account: string };
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const binding = {
  appId: 'tenant-automation',
  source: { id: 'business', connection: 'automation-business' },
  storeId: 'tenant-automation-store',
};
const HOUR = 3_600_000;

/* ---------- the App, its commands, its jobs and its workflow ---------- */

const manifest = () => ({
  id: binding.appId,
  name: 'Tenant automation',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    task: {
      access: 'write',
      owner: 'tenant',
      actions: {
        advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } },
        close: { label: 'Close', command: { id: 'close', version: 1, target: 'task', input: {} } },
        flag: { label: 'Flag', command: { id: 'flag', version: 1, target: 'task', input: {} } },
      },
    },
    review: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, commands: ['advance', 'close', 'open'] },
      clock: { realm: 'tenant', read: true, commands: ['flag', 'sweep'] },
      desk: { realm: 'platform', read: true, commands: ['audit'] },
    },
  },
  views: {
    tasks: { kind: 'list', from: 'task' },
    dealers: { kind: 'list', from: 'dealer' },
    // A signed-in form: its command names no record (targets: 'none') and creates one in the member's own tenant.
    'new-task': {
      kind: 'form',
      label: 'New task',
      command: { id: 'open', version: 1, input: { id: { type: 'text' }, ref: { type: 'text' } } },
    },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['tasks', 'new-task'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
  ],
  home: 'tasks',
});
const app = parseTestApp(manifest(), 'tenant-automation.ts');

const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { dealer: { kind: 'platform' }, task: { kind: 'tenant', column: 'tenant_id' }, review: { kind: 'platform' } },
  resolveMembershipRows: () => ({ task: true }),
  resolveRows: () => ({ task: true }),
  resolvePlatformRows: () => ({ dealer: true, task: true, review: true }),
  resultReferences: {
    advance: () => [],
    close: () => [],
    flag: () => [],
    sweep: () => [],
    audit: () => [],
    open: (value: unknown) => [{ table: 'task', key: { id: (value as { id: string }).id } }],
  },
});

type Advanced = { taskId: string; ref: string };
type Closed = { ref: string };
const advanced = defineEvent('task.advanced', shape({ taskId: text(), ref: text() }));
const closed = defineEvent('task.closed', shape({ ref: text() }));
const output = { parse: (value: unknown) => value as Record<string, unknown> };
const advanceOutput = { parse: (value: unknown) => value as Advanced };
const closeOutput = { parse: (value: unknown) => value as Closed };
const commands = defineCommands({
  // A member's commands: each records a fact naming the task's ref, which two tenants may share.
  advance: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output: advanceOutput,
    events: { advanced: defineEventProjection(advanced, (value: Advanced) => ({ taskId: value.taskId, ref: value.ref })) },
    async handle({ db, record }) {
      await db.task.update(record, { version: Number(record.version) + 1 });
      return { taskId: String(record.id), ref: String(record.ref) };
    },
  }),
  close: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output: closeOutput,
    events: { closed: defineEventProjection(closed, (value: Closed) => ({ ref: value.ref })) },
    async handle({ db, record }) {
      await db.task.update(record, { version: Number(record.version) + 1 });
      return { ref: String(record.ref) };
    },
  }),
  // A signed-in form's: the task it creates is the member's tenant's, whatever the input says of an owner.
  open: defineCommand({
    source: 'business',
    target: 'task',
    targets: 'none',
    input: { id: { type: 'text' }, ref: { type: 'text' }, owner: { type: 'text', optional: true } },
    output,
    async handle({ db }, input) {
      const values = {
        id: String(input.id),
        ref: String(input.ref),
        version: 0,
        flagged: 0,
        ...(input.owner ? { tenant_id: String(input.owner) } : {}),
      };
      await db.task.insert(values);
      return { id: String(input.id) };
    },
  }),
  // The tenant service's: a workflow's step.
  flag: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output,
    async handle({ db, record }) {
      await db.task.update(record, { flagged: Number(record.flagged) + 1, version: Number(record.version) + 1 });
      return { flagged: true };
    },
  }),
  // The tenant service's sweep: every task it can see, flagged once more.
  sweep: defineCommand({
    source: 'business',
    target: 'task',
    targets: 'none',
    input: {},
    output,
    async handle({ db }) {
      const rows = await db.task.where();
      for (const row of rows) await db.task.update(row, { flagged: Number(row.flagged) + 1, version: Number(row.version) + 1 });
      return { seen: rows.map((row) => String(row.id)).sort() };
    },
  }),
  // The platform's own: how many tasks it sees, written down in a platform row.
  audit: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'review',
    targets: 'none',
    read: ['task'],
    input: {},
    output,
    async handle({ db }) {
      const seen = await db.task.count();
      const done = await db.review.count();
      await db.review.insert({ id: `audit-${done + 1}`, note: `saw ${seen}` });
      return { seen };
    },
  }),
});
const principals = { 'tenant-clock': { roles: ['clock'] }, 'lender-desk': { roles: ['desk'] } };
const store = { namespace: 'tenant-automation', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } };
const timed = defineJobs(
  {
    sweepTenants: defineJob({ every: '* * * * *', realm: 'tenant', runAs: 'tenant-clock', command: 'sweep' }),
    auditPlatform: defineJob({ every: '* * * * *', realm: 'platform', runAs: 'lender-desk', command: 'audit' }),
  },
  { principals, store },
);
const followUp = defineWorkflow({
  runAs: 'tenant-clock',
  listens: [closed],
  start: { event: advanced, key: (event: Advanced) => event.ref },
  async run(w, start: Advanced) {
    const done = await w.waitFor('closed', closed, { match: (event: Closed) => event.ref === start.ref, timeout: '1 day' });
    if (done) await w.run('flag', 'flag', { target: start.taskId });
    return { closed: done !== null };
  },
});
const flows = defineJobs({}, { principals, store, workflows: defineWorkflows({ followUp }) });

/* ---------- the engines ---------- */

const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE task (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), ref TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE review (id TEXT PRIMARY KEY NOT NULL, note TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.task (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), ref text NOT NULL,
      version integer NOT NULL DEFAULT 0, flagged integer NOT NULL DEFAULT 0);
    CREATE TABLE public.review (id text PRIMARY KEY, note text NOT NULL);`,
};
// Two tenants' tasks share the ref 'Shared': the same workflow key, in each tenant.
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto'), ('west', 'West Cars');
    INSERT INTO task (id, tenant_id, ref) VALUES ('n1', 'north', 'Shared'), ('n2', 'north', 'North only'), ('s1', 'south', 'Shared'),
      ('w1', 'west', 'West only');`;

interface Lab {
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  provision(module: JobModule, registry?: BusinessCommandRegistry): Promise<unknown>;
  workflows(): Promise<WorkflowStore>;
}

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-automation-'));
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
    provision: async (module, registry = commands) =>
      provisionStores({ sqlite: path }, { app: { tenant: binding, commands: registry }, jobs: module }),
    async workflows() {
      const opened = openSqliteWorkflowStore(path);
      t.after(() => opened.close());
      return opened;
    },
  };
}

async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_automation');
  const control = await pgClient(url),
    managers: PgConnectionManager[] = [];
  t.after(async () => {
    await Promise.allSettled(managers.map((manager) => manager.close()));
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(SCHEMA.postgres + ROWS);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  return {
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
    provision: (module, registry = commands) =>
      provisionStores({ postgres: url }, { app: { tenant: binding, commands: registry }, jobs: module }),
    async workflows() {
      const manager = new PgConnectionManager(url);
      managers.push(manager);
      const opened = await openPostgresWorkflowStore(manager, store.namespace);
      t.after(() => opened.close());
      return opened;
    },
  };
}

/** Three tenants and the platform, active; Ada a member of each. */
async function openLab(t: TestContext, dialect: Dialect, module: JobModule): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  await lab.provision(module);
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south', 'west']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    for (const tenantId of ['north', 'south', 'west'])
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

async function enroll(t: TestContext, lab: Lab, module: JobModule) {
  const enrollment = await createTenantEnrollment<Request>({
    app,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['staff', 'clock', 'desk'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: commands },
    jobs: { module },
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

/* The host's clock: on a minute's first second, an hour back, so one slot is due and the next is a minute off. */
/* A second before a minute: a fresh store's first slot is the next one (jobHost.ts), which the first ticks reach. */
const clockOf = () => ({ now: Math.floor((Date.now() - HOUR) / 60_000) * 60_000 - 1_000 });
async function hostOf(t: TestContext, enrollment: TenantEnrollment<Request>, clock: { now: number }) {
  const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000 });
  assert.ok(host, 'an enrollment with jobs opens a host');
  t.after(() => host.stop());
  return host;
}
/** Tick, moving the host's clock on a little, until the store says so. Never past the minute: one slot. */
async function until(host: JobHost, clock: { now: number }, done: () => Promise<boolean>, step = 500) {
  for (let i = 0; i < 80; i++) {
    if (await done()) return;
    await host.tick();
    if (await done()) return;
    clock.now += step;
  }
  assert.fail('the host never got there');
}

const tasks = async (lab: Lab) =>
  Object.fromEntries((await lab.rows('SELECT id, flagged FROM task ORDER BY id')).map((row) => [row.id, Number(row.flagged)]));
const receipts = (lab: Lab, command: string) =>
  lab.rows(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}" WHERE command_id = '${command}'
  ORDER BY tenant_id`);
const jobsOf = async (lab: Lab) => (await inspectJobs(lab.target, tenantJobPolicies(binding, { commands, jobs: timed }).store)).rows;
async function setStatus(lab: Lab, tenantId: string, status: 'suspended' | 'active') {
  const [row] = await lab.rows(`SELECT version FROM "__mistri_tenant_tenant" WHERE id = '${tenantId}'`);
  await lab.admin((admin) => admin.putTenant({ tenantId, status, expectedVersion: String(row.version) }));
}
async function execute(lab: Lab, enrollment: TenantEnrollment<Request>, tenant: string, command: 'advance' | 'close', id: string) {
  const [row] = await lab.rows(`SELECT version FROM task WHERE id = '${id}'`);
  await enrollment.deployment.execute({ account: 'ada' }, [tenant], {
    command,
    commandVersion: 1,
    key: { id },
    expectedVersion: Number(row.version),
    idempotencyKey: `${command}-${tenant}-${id}-${Number(row.version)}`,
    input: {},
  });
}

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant automation on ${dialect}`, { skip }, () => {
    test("a job at times per tenant runs once for each active tenant, each in its own tenant; the platform's runs once and sees none", async (t) => {
      const lab = await openLab(t, dialect, timed);
      await setStatus(lab, 'west', 'suspended');
      const enrollment = await enroll(t, lab, timed),
        clock = clockOf(),
        host = await hostOf(t, enrollment, clock);
      await until(host, clock, async () => {
        const rows = await jobsOf(lab);
        return rows.length === 3 && rows.every((row) => row.state === 'succeeded');
      });
      // One run each for north and south, none for the suspended west, and one on the platform.
      const runs = (await lab.rows(`SELECT job, provenance_json FROM "${JOB_TABLES.job}"`))
        .map((row) => [String(row.job), JSON.parse(String(row.provenance_json)).tenantId ?? null] as const)
        .sort();
      assert.deepEqual(runs, [
        ['auditPlatform', null],
        ['sweepTenants', 'north'],
        ['sweepTenants', 'south'],
      ]);
      // Each sweep saw and touched its own tenant's rows alone: north's two, south's one, west's none.
      assert.deepEqual(await tasks(lab), { n1: 1, n2: 1, s1: 1, w1: 0 });
      assert.deepEqual(await receipts(lab, 'sweep'), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'service:tenant-clock' },
        { realm: 'tenant', tenant_id: 'south', actor_id: 'service:tenant-clock' },
      ]);
      // The platform's own run reached no tenant's row: it counted no task.
      assert.deepEqual(await receipts(lab, 'audit'), [{ realm: 'platform', tenant_id: '', actor_id: 'service:lender-desk' }]);
      assert.deepEqual(await lab.rows('SELECT id, note FROM review'), [{ id: 'audit-1', note: 'saw 0' }]);

      // The same minute again is the same slot: nothing more runs.
      await host.tick();
      clock.now += 1_000;
      await host.tick();
      assert.equal((await jobsOf(lab)).length, 3);
    });

    test("a workflow instance is one tenant's: the same key lives in two tenants, and one tenant's event never wakes the other's", async (t) => {
      const lab = await openLab(t, dialect, flows);
      const enrollment = await enroll(t, lab, flows),
        clock = clockOf(),
        host = await hostOf(t, enrollment, clock);
      const workflows = await lab.workflows();
      const states = async () => Object.fromEntries((await workflows.inspect()).map((row) => [row.workflow, row.state]));
      await execute(lab, enrollment, 'north', 'advance', 'n1');
      await execute(lab, enrollment, 'south', 'advance', 's1');
      const north = workflowPartition('followUp', 'north'),
        south = workflowPartition('followUp', 'south');
      await until(host, clock, async () => {
        const now = await states();
        return now[north] === 'waiting' && now[south] === 'waiting';
      });
      assert.deepEqual(
        (await workflows.inspect()).map((row) => row.key),
        ['Shared', 'Shared'],
        'one live instance of the key in each tenant',
      );

      // South's fact names the shared ref: south's instance wakes and flags south's task; north's still waits.
      await execute(lab, enrollment, 'south', 'close', 's1');
      await until(host, clock, async () => (await states())[south] === 'completed');
      assert.equal((await states())[north], 'waiting', "tenant B's event did not wake tenant A's instance of the same key");
      assert.deepEqual(await tasks(lab), { n1: 0, n2: 0, s1: 1, w1: 0 });

      /* A wake-up for north's instance that carries south — which only a forged
       job row could — finds no instance in south's partition: north's stays
       as it was, and never reads south's 'closed' fact for the shared ref. */
      if ('sqlite' in lab.target) {
        const jobs = openSqliteJobStore(lab.target.sqlite, tenantJobPolicies(binding, { commands, jobs: flows }).store);
        t.after(() => jobs.close());
        const target = (await workflows.inspect()).find((row) => row.workflow === north)!;
        const forged = await jobs.enqueue(
          {
            job: 'wf-followUp',
            version: 1,
            idempotencyKey: 'forged-cross-tenant-wake',
            input: { instance: target.id },
            provenance: {
              appId: binding.appId,
              actorId: 'service:tenant-clock',
              tenantId: 'south',
              correlationId: target.id,
              causationId: target.id,
            },
          },
          clock.now,
        );
        await until(host, clock, async () => (await jobsOf(lab)).some((row) => row.id === forged.id && row.state === 'succeeded'));
        const after = (await workflows.inspect()).find((row) => row.workflow === north)!;
        assert.deepEqual(after, target, "a wake-up in tenant B never begins tenant A's instance: not its state, its wait or its clock");
        assert.deepEqual(await tasks(lab), { n1: 0, n2: 0, s1: 1, w1: 0 });
      }

      await execute(lab, enrollment, 'north', 'close', 'n1');
      await until(host, clock, async () => (await states())[north] === 'completed');
      assert.deepEqual(await tasks(lab), { n1: 1, n2: 0, s1: 1, w1: 0 });
      // Each step ran as the workflow's principal, in its instance's tenant.
      assert.deepEqual(await receipts(lab, 'flag'), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'service:tenant-clock' },
        { realm: 'tenant', tenant_id: 'south', actor_id: 'service:tenant-clock' },
      ]);
    });

    test("a signed-in form's command creates its row in the member's own tenant, and names no owner of its own", async (t) => {
      const lab = await openLab(t, dialect, timed);
      const enrollment = await enroll(t, lab, timed);
      const open = (tenant: string, input: Record<string, unknown>, key = `open-${tenant}-${String(input.id)}-key`) =>
        enrollment.deployment.execute({ account: 'ada' }, [tenant], {
          command: 'open',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: key,
          input,
        });
      await open('north', { id: 'n3', ref: 'Fresh' });
      await open('south', { id: 's3', ref: 'Fresh' });
      assert.deepEqual(await lab.rows(`SELECT id, tenant_id FROM task WHERE ref = 'Fresh' ORDER BY id`), [
        { id: 'n3', tenant_id: 'north' },
        { id: 's3', tenant_id: 'south' },
      ]);
      assert.deepEqual(await receipts(lab, 'open'), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'ada' },
        { realm: 'tenant', tenant_id: 'south', actor_id: 'ada' },
      ]);
      // The owner is the platform's to say: a handler that writes one is refused, and nothing lands in south.
      await assert.rejects(open('north', { id: 'n4', ref: 'Forged', owner: 'south' }));
      // A key is not an empty one: the command is still refused one that names a record.
      await assert.rejects(
        enrollment.deployment.execute({ account: 'ada' }, ['north'], {
          command: 'open',
          commandVersion: 1,
          key: { id: 's1' },
          expectedVersion: 0,
          idempotencyKey: 'open-north-keyed-request',
          input: { id: 'n5', ref: 'Keyed' },
        }),
      );
      assert.deepEqual(await lab.rows(`SELECT id FROM task WHERE ref IN ('Forged', 'Keyed')`), []);
    });

    test("a retry names the instance's tenant, or is refused unchanged", async (t) => {
      const lab = await openLab(t, dialect, flows);
      const enrollment = await enroll(t, lab, flows),
        clock = clockOf(),
        host = await hostOf(t, enrollment, clock);
      const workflows = await lab.workflows();
      await execute(lab, enrollment, 'north', 'advance', 'n1');
      await until(host, clock, async () => (await workflows.inspect())[0]?.state === 'waiting');
      const [instance] = await workflows.inspect();
      const policies = tenantJobPolicies(binding, { commands, jobs: flows });
      // The tenant check is retryAdmits', asked before anything changes: another tenant, or none, is refused.
      for (const tenantId of ['south', undefined])
        await assert.rejects(
          retryWorkflow(lab.target, policies.store, {
            id: instance.id,
            operator: 'ops',
            appId: binding.appId,
            ...(tenantId ? { tenantId } : {}),
          }),
          /not_retryable/,
        );
      assert.equal((await workflows.inspect())[0]!.updatedAt, instance.updatedAt, 'a refused retry changes nothing');
      // Its own tenant wakes the waiting instance where it is.
      assert.equal(
        (await retryWorkflow(lab.target, policies.store, { id: instance.id, operator: 'ops', appId: binding.appId, tenantId: 'north' }))
          .state,
        'waiting',
      );
      assert.equal(retryAdmits(undefined)(instance.workflow), false, "no tenant named: a tenant's instance is not retried");
      assert.equal(retryAdmits('south')(instance.workflow), false, 'another tenant named: refused');
      assert.equal(retryAdmits('north')(instance.workflow), true);
      assert.equal(retryAdmits(undefined)('followUp'), true, "an ordinary App's instance needs no tenant");
      assert.equal(retryAdmits('north')('followUp'), false);
    });
  });

describe("what a tenant App's automation refuses", () => {
  const owner = { appId: binding.appId, storeId: binding.storeId, source: binding.source };
  test('a job at times says its realm, and runs a command of that realm', () => {
    const module = (job: { every: string; realm?: 'tenant' | 'platform'; runAs: string; command: string }) =>
      capturedJobModule(defineJobs({ job: defineJob(job) }, { principals, store }));
    assert.throws(
      () => tenantJobDeployment(module({ every: '@daily', runAs: 'tenant-clock', command: 'sweep' }), { binding: owner, commands }),
      /says no realm\. On a tenant App a job at times runs once per active tenant/,
    );
    assert.throws(
      () =>
        tenantJobDeployment(module({ every: '@daily', realm: 'platform', runAs: 'tenant-clock', command: 'sweep' }), {
          binding: owner,
          commands,
        }),
      /says realm: 'platform', and runs tenant command "sweep"/,
    );
    assert.throws(
      () =>
        tenantJobDeployment(module({ every: '@daily', realm: 'tenant', runAs: 'lender-desk', command: 'audit' }), {
          binding: owner,
          commands,
        }),
      /says realm: 'tenant', and runs platform command "audit"/,
    );
    assert.throws(
      () => defineJob({ every: '@daily', realm: 'everyone', runAs: 'tenant-clock', command: 'sweep' } as never),
      JobDeclarationError,
    );
    // An App without tenants has no realm to choose.
    assert.throws(
      () =>
        jobDeployment(module({ every: '@daily', realm: 'tenant', runAs: 'tenant-clock', command: 'sweep' }), { appId: 'plain', commands }),
      /only a tenant App's job at times declares/,
    );
    assert.ok(tenantJobDeployment(capturedJobModule(timed), { binding: owner, commands }));
    assert.ok(tenantJobDeployment(capturedJobModule(flows), { binding: owner, commands }));
  });

  test("a workflow's principal holds tenant roles alone", async (t) => {
    const desk = defineJobs(
      {},
      {
        principals,
        store,
        workflows: defineWorkflows({
          deskFlow: defineWorkflow({
            runAs: 'lender-desk',
            start: { event: advanced, key: (event: Advanced) => event.ref },
            async run() {
              return null;
            },
          }),
        }),
      },
    );
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(SCHEMA.sqlite.replace('PRAGMA journal_mode=WAL;', ''));
    db.exec('BEGIN IMMEDIATE');
    const schema = readSqliteScopeCatalog(db).schema;
    db.exec('COMMIT');
    const owned = captureTenantOwnership({
      appId: binding.appId,
      source: binding.source,
      schema,
      physicalSchema: structuredClone(schema),
      resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
      profile: 'dealer',
      ownership: policy.ownership,
    });
    assert.throws(
      () => assertTenantJobs(capturedJobModule(desk), app, commands, owned, binding.source.connection),
      (error: unknown) =>
        error instanceof JobDeclarationError &&
        /runs workflow "deskFlow", whose instances are each one tenant's, so every role it holds must be a tenant-realm role/.test(
          error.message,
        ),
    );
    assertTenantJobs(capturedJobModule(flows), app, commands, owned, binding.source.connection);
  });
});
