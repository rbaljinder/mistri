/**
 * A tenant App's jobs run commands that record events and look up (field report #11), through a real
 * enrollment and job host, on SQLite and, when `TABLEWALK_TEST_PG` names a disposable server, PostgreSQL.
 *
 * A member's advance starts `flagTask`, whose command `flag` looks a global rate up and records a fact; that
 * fact starts `noteTask`, whose command `note` runs in turn. The control connection reads what the
 * database holds, not what the host says.
 *
 * 1. The service's event lands in its tenant's store, by `service:<principal>`, and reaches its subscriber.
 * 2. A lookup reads the target as the event's tenant sees it: another tenant's row is not there, and the job
 *    records nothing.
 * 3. A tenant suspended between the lookup and the write refuses the command, and no event is stored.
 * 4. Mail commands and flow steps are held to the same rule as jobs; a platform job's command still refuses.
 * 5. A cycle through service events is refused at load: the guard against a chain that never ends.
 * 6. The service event owner is issued only to a genuine jobs runtime and a tenant's place.
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
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { jobCommandKey } from '../packages/mistri/src/server/jobs/jobCommands.js';
import { type JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import {
  capturedJobModule,
  defineJob,
  defineJobs,
  JobDeclarationError,
  type JobModule,
} from '../packages/mistri/src/server/jobs/jobModule.js';
import { inspectJobs, provisionStores, tenantJobPolicies } from '../packages/mistri/src/server/maintenance.js';
import { registerTenantServiceEventBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { assertTenantJobs, openTenantJobHost } from '../packages/mistri/src/server/tenant/tenantJobs.js';
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
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
type Request = { readonly account: string };
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const binding = {
  appId: 'tenant-job-lookups',
  source: { id: 'business', connection: 'lookups-business' },
  storeId: 'tenant-job-lookups-store',
};
const HOUR = 3_600_000;

/* ---------- the App, its commands and its jobs ---------- */

const manifest = () => ({
  id: binding.appId,
  name: 'Tenant job events and lookups',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    rate: { owner: 'global' },
    task: {
      access: 'write',
      owner: 'tenant',
      actions: {
        advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } },
        flag: { label: 'Flag', command: { id: 'flag', version: 1, target: 'task', input: {} } },
        note: { label: 'Note', command: { id: 'note', version: 1, target: 'task', input: {} } },
        review: { label: 'Review', command: { id: 'review', version: 1, target: 'task', input: {}, realm: 'platform' } },
      },
    },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, commands: ['advance'] },
      clock: { realm: 'tenant', read: true, commands: ['flag', 'note'] },
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
const app = parseTestApp(manifest(), 'tenant-job-events-lookups.ts');

const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: {
    dealer: { kind: 'platform' },
    rate: { kind: 'global', access: 'read-only' },
    task: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => ({ task: true }),
  resolveRows: () => ({ task: true }),
  resolvePlatformRows: () => ({ dealer: true, task: true }),
  resultReferences: { advance: () => [], flag: () => [], note: () => [], review: () => [] },
});

type Fact = { taskId: string; target: string; version: number };
const fact = shape({ taskId: text(), target: text(), version: int() });
const advanced = defineEvent('task.advanced', fact);
const flagged = defineEvent('task.flagged', fact);
const project = (value: Fact) => ({ taskId: value.taskId, target: value.target, version: value.version });
const factOutput = {
  parse(value: unknown) {
    const data = value as Record<string, unknown>;
    if (!data || typeof data.taskId !== 'string' || typeof data.target !== 'string' || !Number.isSafeInteger(data.version))
      throw new Error('Bad output');
    return { taskId: data.taskId, target: data.target, version: data.version as number };
  },
};
const output = { parse: (value: unknown) => value as Record<string, unknown> };
/** Run inside the job command's lookup, before its transaction opens: where a suspension can land between them. */
let gate: (() => Promise<void>) | undefined;

const flag = defineCommand({
  source: 'business',
  target: 'task',
  input: {},
  output: factOutput,
  sources: { business: ['rate'] },
  events: { flagged: defineEventProjection(flagged, project) },
  async lookup({ sources }) {
    await gate?.();
    const rate = await sources.business.rate.get('standard');
    return { points: Number(rate.points) };
  },
  async handle({ db, record, lookup }) {
    const { version } = await db.task.update(record, { flagged: lookup.points, version: Number(record.version) + 1 });
    return { taskId: String(record.id), target: String(record.id), version: Number(version) };
  },
});
const commands = defineCommands({
  advance: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output: factOutput,
    events: { advanced: defineEventProjection(advanced, project) },
    async handle({ db, record }) {
      const { version } = await db.task.update(record, { version: Number(record.version) + 1 });
      return { taskId: String(record.id), target: String(record.follow_up ?? record.id), version: Number(version) };
    },
  }),
  flag,
  note: defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    output,
    async handle({ db, record }) {
      await db.task.update(record, { note: 'seen', version: Number(record.version) + 1 });
      return { noted: true };
    },
  }),
  review: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'task',
    input: {},
    output,
    async handle({ db, record }) {
      await db.task.update(record, { version: Number(record.version) + 1 });
      return {};
    },
  }),
});
const principals = { 'tenant-clock': { roles: ['clock'] }, 'lender-desk': { roles: ['desk'] } };
const store = { namespace: 'tenant-job-lookups', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } };
const jobsModule = defineJobs(
  {
    flagTask: defineJob({
      on: { event: advanced, command: 'advance' },
      runAs: 'tenant-clock',
      command: 'flag',
      schedule: (event: Fact) => ({ key: { id: event.target } }),
    }),
    noteTask: defineJob({
      on: { event: flagged, command: 'flag' },
      runAs: 'tenant-clock',
      command: 'note',
      schedule: (event: Fact) => ({ key: { id: event.target } }),
    }),
  },
  { principals, store },
);
const policies = tenantJobPolicies(binding, { commands, jobs: jobsModule });

/* ---------- the engines ---------- */

const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE rate (id TEXT PRIMARY KEY NOT NULL, points INTEGER NOT NULL);
    CREATE TABLE task (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL, follow_up TEXT,
      version INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, note TEXT);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.rate (id text PRIMARY KEY, points integer NOT NULL);
    CREATE TABLE public.task (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL, follow_up text,
      version integer NOT NULL DEFAULT 0, flagged integer NOT NULL DEFAULT 0, note text);`,
};
// n2's follow-up is another tenant's task: a fact that names it must reach nothing.
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO rate VALUES ('standard', 7);
    INSERT INTO task (id, tenant_id, name, follow_up) VALUES ('n1', 'north', 'North one', NULL), ('n2', 'north', 'North two', 's1'),
      ('s1', 'south', 'South one', NULL);`;

interface Lab {
  readonly dialect: Dialect;
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  provision(): Promise<unknown>;
}

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-job-lookups-'));
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
    provision: async () => await provisionStores({ sqlite: path }, { app: { tenant: binding, commands }, jobs: jobsModule }),
  };
}

async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('mistri_job_lookups');
  const control = await pgClient(url);
  t.after(async () => {
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
        await run(createPostgresTenantAdministration(control as Control, operations, binding));
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    },
    provision: () => provisionStores({ postgres: url }, { app: { tenant: binding, commands }, jobs: jobsModule }),
  };
}

/** Two tenants and the platform, active; Ada a staff member of both. */
async function openLab(t: TestContext, dialect: Dialect): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  await lab.provision();
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

async function enroll(t: TestContext, lab: Lab) {
  const enrollment = await createTenantEnrollment<Request>({
    app,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['staff', 'clock', 'desk'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: commands },
    jobs: { module: jobsModule },
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

const clockOf = () => ({ now: Date.now() - HOUR });
async function hostOf(t: TestContext, enrollment: TenantEnrollment<Request>, clock: { now: number }) {
  const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000 });
  assert.ok(host, 'an enrollment with jobs opens a host');
  t.after(() => host.stop());
  return host;
}
async function until(host: JobHost, clock: { now: number }, done: () => Promise<boolean>) {
  for (let step = 0; step < 60; step++) {
    if (await done()) return;
    await host.tick();
    if (await done()) return;
    clock.now += 2_000;
  }
  assert.fail('the host never got there');
}

const jobs = async (lab: Lab) => (await inspectJobs(lab.target, policies.store)).rows.filter((row) => row.job !== 'mistri-retention');
const settled = async (lab: Lab, total: number) => {
  const rows = await jobs(lab);
  return rows.length === total && rows.every((row) => ['succeeded', 'failed'].includes(row.state));
};
const task = async (lab: Lab, id: string) =>
  (await lab.rows(`SELECT id, version, flagged, note FROM task WHERE id = '${id}'`)).map((row) => ({
    ...row,
    version: Number(row.version),
    flagged: Number(row.flagged),
  }))[0];
const version = async (lab: Lab, id: string) =>
  String((await lab.rows(`SELECT version FROM "__mistri_tenant_tenant" WHERE id = '${id}'`))[0].version);
/** The facts a command recorded, with who recorded them and in whose realm. */
const facts = (lab: Lab, command: string) =>
  lab.rows(`SELECT e.event_id, e.envelope_json, r.realm, r.tenant_id, r.actor_id, r.idempotency_key
    FROM "${eventTables.event}" e JOIN "${journal.receipt}" r ON r.id = e.receipt_id WHERE r.command_id = '${command}' ORDER BY e.event_id`);

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

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`a tenant job's events and lookups on ${dialect}`, { skip }, () => {
    test("a job's command looks up, records its fact as its service in the tenant's store, and the fact starts the next job", async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const eventId = await advance(lab, enrollment, 'north', 'n1', 'advance-north-0001');
      const host = await hostOf(t, enrollment, clock);
      await until(host, clock, () => settled(lab, 2));
      assert.deepEqual(
        (await jobs(lab)).map((row) => row.state),
        ['succeeded', 'succeeded'],
        'the flag, then the note its fact started',
      );
      // The lookup's rate (7) reached the handler; the chain's second hop ran on the fact the first recorded.
      assert.deepEqual(await task(lab, 'n1'), { id: 'n1', version: 3, flagged: 7, note: 'seen' });
      const recorded = await facts(lab, 'flag');
      assert.equal(recorded.length, 1);
      assert.deepEqual(
        [recorded[0].realm, recorded[0].tenant_id, recorded[0].actor_id, recorded[0].idempotency_key],
        ['tenant', 'north', 'service:tenant-clock', jobCommandKey('flagTask', 1, eventId)],
      );
      assert.equal(JSON.parse(String(recorded[0].envelope_json)).name ?? 'task.flagged', 'task.flagged');
      assert.match(String(recorded[0].envelope_json), /service:tenant-clock/, 'the fact names its service as the actor');
      assert.deepEqual(await facts(lab, 'note'), [], 'a command that declares no event records none');
    });

    test("a lookup reads the target as the event's tenant sees it: another tenant's row is not there, and nothing is recorded", async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      const before = await task(lab, 's1');
      // n2's fact names s1, south's task, as the flag's target.
      await advance(lab, enrollment, 'north', 'n2', 'advance-north-cross-0001');
      const host = await hostOf(t, enrollment, clock);
      await until(host, clock, () => settled(lab, 1));
      assert.deepEqual(
        (await jobs(lab)).map((row) => [row.state, row.lastCode]),
        [['failed', 'rejected']],
      );
      assert.deepEqual(await task(lab, 's1'), before);
      assert.deepEqual(await facts(lab, 'flag'), []);
      // South's own fact about its own task runs in south's namespace.
      await advance(lab, enrollment, 'south', 's1', 'advance-south-0001');
      await until(host, clock, () => settled(lab, 3));
      assert.deepEqual(
        (await facts(lab, 'flag')).map((row) => [row.tenant_id, row.actor_id]),
        [['south', 'service:tenant-clock']],
      );
    });

    test('a tenant suspended between the lookup and the write refuses the command: nothing applied, no fact stored', async (t) => {
      const lab = await openLab(t, dialect),
        enrollment = await enroll(t, lab),
        clock = clockOf();
      await advance(lab, enrollment, 'north', 'n1', 'advance-during-0001');
      const host = await hostOf(t, enrollment, clock);
      let suspended = false;
      gate = async () => {
        if (suspended) return;
        suspended = true;
        await setStatus(lab, 'north', 'suspended');
      };
      t.after(() => {
        gate = undefined;
      });
      await until(host, clock, () => settled(lab, 1));
      assert.ok(suspended, 'the suspension landed after the lookup began');
      assert.equal((await jobs(lab))[0].state, 'failed');
      assert.equal((await task(lab, 'n1')).flagged, 0);
      assert.deepEqual(await facts(lab, 'flag'), [], 'no fact for a command that did not commit');
      assert.equal(await jobs(lab).then((rows) => rows.filter((row) => row.job === 'noteTask').length), 0);
    });
  });

/* ---------- declarations ---------- */

describe("what a tenant job's command may declare, and what a platform job's may not", () => {
  const events = { flagged: defineEventProjection(flagged, project) };
  const refusedWith = (message: RegExp, module: JobModule, registry: BusinessCommandRegistry) =>
    assert.throws(
      () => tenantJobPolicies(binding, { commands: registry, jobs: module }),
      (error: unknown) => error instanceof JobDeclarationError && message.test(error.message),
    );
  const { version: _flagVersion, ...review } = commands.review;
  const platformJobs = (extra: Record<string, unknown>) => ({
    registry: defineCommands({ ...commands, review: defineCommand({ ...review, ...extra }) }),
    module: defineJobs(
      {
        reviewTask: defineJob({
          on: { event: advanced, command: 'advance' },
          runAs: 'lender-desk',
          command: 'review',
          schedule: (event: Fact) => ({ key: { id: event.target } }),
        }),
      },
      { principals, store },
    ),
  });

  test('a tenant command with events and a lookup is accepted as a job and a cycle through its fact is not', () => {
    assert.doesNotThrow(() => tenantJobPolicies(binding, { commands, jobs: jobsModule }));
    const loop = defineJobs(
      {
        flagTask: defineJob({
          on: { event: flagged, command: 'flag' },
          runAs: 'tenant-clock',
          command: 'flag',
          schedule: (event: Fact) => ({ key: { id: event.target } }),
        }),
      },
      { principals, store },
    );
    refusedWith(/cycle/, loop, commands);
  });

  test('a platform job runs outside any tenant, so a command that looks up is refused in words', () => {
    // A platform command that declares events never gets this far: defineCommand refuses it ("neither public nor event-emitting").
    assert.throws(() => platformJobs({ events }), /neither public nor event-emitting/);
    const withLookup = platformJobs({ sources: { business: ['rate'] }, lookup: async () => ({}) });
    refusedWith(/platform jobs run outside any tenant; events and lookups need one/, withLookup.module, withLookup.registry);
  });

  test('assertTenantJobs accepts a tenant job whose command has events and a lookup (the platform case is refused at deployment, above)', async (t) => {
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
    assert.doesNotThrow(() => assertTenantJobs(capturedJobModule(jobsModule), app, commands, owned, binding.source.connection));
  });
});

describe('the service event owner', () => {
  const lookalike = Object.freeze({ app, module: jobsModule, bind: () => undefined, deliver: () => undefined });
  const bound = Object.freeze({ scoped: true as const, authorize: () => undefined as never });
  test('is issued to no structural lookalike of the jobs runtime', () => {
    assert.throws(() => registerTenantServiceEventBinding(lookalike, { place: 'tenant' }, bound), TenantContextError);
  });
  // The runtime is vouched for before the place is looked at, so a lookalike fails on either; the
  // genuine runtime's refusal of a platform place is the service binding's own (bindService registers tenant place only).
  test('is issued to no platform place', () => {
    assert.throws(() => registerTenantServiceEventBinding(lookalike, { place: 'platform' }, bound));
  });
});
