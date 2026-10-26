/**
 * A resource's timers at an instant (`at`) on a tenant App, through a real
 * enrollment and job host, on SQLite and, when `TABLEWALK_TEST_PG` names a
 * disposable server, PostgreSQL. Every PostgreSQL test owns a database named
 * by a UUID and drops it afterwards. The control connection reads what the
 * database holds, not what the host says.
 *
 * The sweep reads due records across the active tenants (tenantDueTimers.ts)
 * and runs each in the tenant its row's owner names, as that tenant's service
 * principal, fenced on the tenant's row and `@platform`.
 *
 * 1. The same key in two tenants is two stays: each fires once, in its own
 *    tenant, and a later sweep fires neither again.
 * 2. A suspended tenant's due records do not fire; they fire once it is
 *    active again.
 * 3. A job that names another tenant than its row's — forged, or redriven —
 *    finds no row there, and changes nothing.
 * 4. A timer on a platform-owned record runs a platform command with no
 *    tenant, and reaches no tenant's row.
 * 5. One tenant with many due records does not starve another: a sweep takes
 *    at most DUE_TIMER_CAP of each tenant's, and later sweeps reach the rest.
 * 5a. A sandbox's dev clock reads its own records due ahead of
 *    real time; a live tenant's same record waits for real time.
 * 6. What startup refuses rather than ignores: a timer on a global table, a
 *    tenant command on a platform-owned machine, and a timer whose command is
 *    granted only to principals of the other realm.
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
import { openPostgresJobStore } from '../packages/mistri/src/adapters/jobs/postgresJobStore.js';
import type { JobEnqueueInput } from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import type { JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import { capturedJobModule, defineJob, defineJobs, JobDeclarationError } from '../packages/mistri/src/server/jobs/jobModule.js';
import { provisionStores, tenantJobPolicies } from '../packages/mistri/src/server/maintenance.js';
import { SANDBOX_TABLES } from '../packages/mistri/src/server/tenant/tenantSandboxStore.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { DUE_TIMER_CAP } from '../packages/mistri/src/server/tenant/tenantDueTimers.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { assertTenantJobs, openTenantJobHost, withTenantMachineTimers } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { captureTenantOwnership, type ResourceOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
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
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
type Request = { readonly account: string };
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const binding = {
  appId: 'tenant-timers',
  source: { id: 'business', connection: 'timers-business' },
  storeId: 'tenant-timers-store',
};
const PAST = '2020-01-01 09:00:00',
  FUTURE = '2999-01-01 09:00:00';

/* ---------- the App: a ticket's service clock, and a lender's review ---------- */

// The App names its commands; their contracts are the commands module's (parseTestApp lifts them).
const contracts = {
  resolve: { target: 'ticket' },
  warn: { target: 'ticket' },
  breach: { target: 'ticket' },
  audit: { target: 'review', realm: 'platform' },
  tally: { target: 'review', targets: 'none', realm: 'platform' },
};
const manifest = (roles: Record<string, unknown> = {}) => ({
  id: binding.appId,
  name: 'Tenant timers',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    // A ticket's warning and breach fall due at instants it keeps, while it is open, as an SLA clock's do.
    ticket: {
      access: 'write',
      owner: 'tenant',
      machine: {
        column: 'status',
        states: {
          open: { on: { resolve: 'resolved', breach: 'breached' } },
          resolved: { final: true },
          breached: { final: true },
        },
      },
      at: { warn_at: { command: 'warn', when: "status = 'open'" }, due_at: { command: 'breach', when: "status = 'open'" } },
    },
    // The lender's own record, due at its own instant: no tenant's.
    review: {
      access: 'write',
      owner: 'platform',
      machine: { column: 'status', states: { pending: { on: { audit: 'audited' } }, audited: { final: true } } },
      at: { due_at: { command: 'audit', when: "status = 'pending'" } },
    },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, commands: ['resolve'] },
      clock: { realm: 'tenant', read: true, commands: ['warn', 'breach'] },
      desk: { realm: 'platform', read: true, commands: ['audit', 'tally'] },
      ...roles,
    },
  },
  views: { tickets: { kind: 'list', from: 'ticket' }, reviews: { kind: 'list', from: 'review' } },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['tickets'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['reviews'] },
  ],
  home: 'tickets',
});
const app = parseTestApp(manifest(), 'tenant-timers.ts', contracts);

const ownership: Record<string, ResourceOwnership> = {
  dealer: { kind: 'platform' },
  ticket: { kind: 'tenant', column: 'tenant_id' },
  review: { kind: 'platform' },
};
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership,
  resolveMembershipRows: () => ({ ticket: true }),
  resolveRows: () => ({ ticket: true }),
  resolvePlatformRows: () => ({ dealer: true, ticket: true, review: true }),
  resultReferences: { resolve: () => [], warn: () => [], breach: () => [], audit: () => [], tally: () => [] },
});

const output = { parse: (value: unknown) => value as Record<string, unknown> };
const commands = defineCommands({
  resolve: defineCommand({
    source: 'business',
    target: 'ticket',
    input: {},
    output,
    async handle({ db, record }) {
      await db.ticket.update(record, { status: 'resolved' });
      return {};
    },
  }),
  // The warning moves nothing: the ticket stays open, and stays due.
  warn: defineCommand({
    source: 'business',
    target: 'ticket',
    input: {},
    output,
    async handle({ db, record }) {
      await db.ticket.update(record, { warned: Number(record.warned) + 1 });
      return { warned: true };
    },
  }),
  breach: defineCommand({
    source: 'business',
    target: 'ticket',
    input: {},
    output,
    async handle({ db, record }) {
      await db.ticket.update(record, { status: 'breached' });
      return {};
    },
  }),
  // The lender's: how many tickets it can see from here, written on the review it audits.
  audit: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'review',
    read: ['ticket'],
    input: {},
    output,
    async handle({ db, record }) {
      const seen = await db.ticket.count();
      await db.review.update(record, { status: 'audited', note: `saw ${seen}` });
      return { seen };
    },
  }),
  tally: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'review',
    targets: 'none',
    input: {},
    output,
    async handle() {
      return {};
    },
  }),
});
const principals = { 'sla-clock': { roles: ['clock'] }, 'lender-desk': { roles: ['desk'] } };
const store = { namespace: 'tenant-timers', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } };
// One job of its own, as every module declares; the App's timers join it.
const timers = defineJobs(
  { yearly: defineJob({ every: '0 0 1 1 *', realm: 'platform', runAs: 'lender-desk', command: 'tally' }) },
  { principals, store },
);
const wrapped = withTenantMachineTimers(timers, app, commands);
const WARN = 'at-ticket-warn_at',
  AUDIT = 'at-review-due_at';

/* ---------- the engines ---------- */

const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE ticket (tenant_id TEXT NOT NULL REFERENCES dealer(id), number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', warn_at TIMESTAMP, due_at TIMESTAMP, warned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, number));
    CREATE INDEX ticket_status ON ticket (tenant_id, status, warn_at);
    CREATE TABLE review (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'pending', due_at TIMESTAMP, note TEXT);`,
  // A zone-less warning and a zoned due time: each cutoff is read on its own column's clock.
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.ticket (tenant_id text NOT NULL REFERENCES public.dealer(id), number integer NOT NULL,
      status text NOT NULL DEFAULT 'open', warn_at timestamp, due_at timestamptz, warned integer NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, number));
    CREATE INDEX ticket_status ON public.ticket (tenant_id, status, warn_at);
    CREATE TABLE public.review (id text PRIMARY KEY, status text NOT NULL DEFAULT 'pending', due_at timestamptz, note text);`,
};
const DEALERS = `INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto'), ('west', 'West Cars');`;

interface Lab {
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  enqueue(request: JobEnqueueInput, now: number): Promise<{ id: string }>;
}

async function sqliteLab(t: TestContext, seed: string): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-timers-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(SCHEMA.sqlite + DEALERS + seed);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  // Provisioning is told the App, and wraps the module as startup does.
  await provisionStores({ sqlite: path }, { app: { tenant: binding, commands, definition: app }, jobs: timers });
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
    async enqueue(request, now) {
      const jobs = openSqliteJobStore(path, tenantJobPolicies(binding, { commands, jobs: timers, app }).store);
      try {
        return await jobs.enqueue(request, now);
      } finally {
        await jobs.close();
      }
    },
  };
}

async function postgresLab(t: TestContext, seed: string): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_timers');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(SCHEMA.postgres + DEALERS + seed);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  await provisionStores({ postgres: url }, { app: { tenant: binding, commands, definition: app }, jobs: timers });
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
    async enqueue(request, now) {
      const manager = new PgConnectionManager(url);
      try {
        const jobs = await openPostgresJobStore(manager, tenantJobPolicies(binding, { commands, jobs: timers, app }).store, {
          clock: 'caller',
        });
        try {
          return await jobs.enqueue(request, now);
        } finally {
          await jobs.close();
        }
      } finally {
        await manager.close();
      }
    },
  };
}

/** Three tenants and the platform, active, over the seeded rows. */
async function openLab(t: TestContext, dialect: Dialect, seed: string): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t, seed) : postgresLab(t, seed));
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south', 'west']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  return lab;
}

async function enroll(t: TestContext, lab: Lab, enrolled = app) {
  // The module as defineJobs made it: enrollment wraps the App's timers itself, so none is dropped unrun.
  const enrollment = await createTenantEnrollment<Request>({
    app: enrolled,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['staff', 'clock', 'desk'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: commands },
    jobs: { module: timers },
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

async function hostOf(t: TestContext, enrollment: TenantEnrollment<Request>, clock: { now: number }) {
  const host = await openTenantJobHost(enrollment, { now: () => clock.now, idleMs: 60_000 });
  assert.ok(host, 'an enrollment whose App declares timers opens a host');
  t.after(() => host.stop());
  return host;
}
/** Tick, moving the host's clock on a little, until the database says so. Never as far as the next sweep. */
async function until(host: JobHost, clock: { now: number }, done: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await done()) return;
    await host.tick();
    if (await done()) return;
    clock.now += 200;
  }
  assert.fail('the host never got there');
}
/** The next minute's sweep, and every job it enqueues run. */
async function nextSweep(host: JobHost, clock: { now: number }, lab: Lab) {
  clock.now += 60_000;
  await host.tick();
  await until(host, clock, async () => (await jobs(lab)).every((row) => row.state === 'succeeded' || row.state === 'failed'));
}

const jobs = async (lab: Lab) =>
  (await lab.rows(`SELECT job, state, last_code, input_json, provenance_json FROM "${JOB_TABLES.job}" WHERE job LIKE 'at-%'`)).map(
    (row) => ({
      job: String(row.job),
      state: String(row.state),
      code: row.last_code === null ? null : String(row.last_code),
      key: JSON.parse(String(row.input_json)).key as Record<string, string | number>,
      tenantId: (JSON.parse(String(row.provenance_json)).tenantId ?? null) as string | null,
    }),
  );
const tickets = async (lab: Lab) =>
  Object.fromEntries(
    (await lab.rows('SELECT tenant_id, number, status, warned FROM ticket ORDER BY tenant_id, number')).map((row) => [
      `${String(row.tenant_id)}/${Number(row.number)}`,
      `${String(row.status)}:${Number(row.warned)}`,
    ]),
  );
const receipts = (lab: Lab, command: string) =>
  lab.rows(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}" WHERE command_id = '${command}' ORDER BY tenant_id`);
async function setStatus(lab: Lab, tenantId: string, status: 'suspended' | 'active') {
  const [row] = await lab.rows(`SELECT version FROM "__mistri_tenant_tenant" WHERE id = '${tenantId}'`);
  await lab.admin((admin) => admin.putTenant({ tenantId, status, expectedVersion: String(row.version) }));
}
const ticket = (tenant: string, number: number, warn: string, due = FUTURE) => `('${tenant}', ${number}, '${warn}', '${due}')`;
const seedTickets = (...values: string[]) => `INSERT INTO ticket (tenant_id, number, warn_at, due_at) VALUES ${values.join(', ')};`;

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant machine timers on ${dialect}`, { skip }, () => {
    test('the same key in two tenants fires once in each, as that tenant’s service, and a later sweep fires neither again', async (t) => {
      // North's ticket 1 and south's ticket 1 fall due at the same instant; north's ticket 2 is not due yet.
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, PAST), ticket('south', 1, PAST), ticket('north', 2, FUTURE)));
      const enrollment = await enroll(t, lab),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      await until(host, clock, async () => (await receipts(lab, 'warn')).length === 2);
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:1', 'north/2': 'open:0', 'south/1': 'open:1' });
      assert.deepEqual(await receipts(lab, 'warn'), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'service:sla-clock' },
        { realm: 'tenant', tenant_id: 'south', actor_id: 'service:sla-clock' },
      ]);
      // Each run carries the tenant its row's owner names, read by the server.
      assert.deepEqual((await jobs(lab)).map((row) => [row.job, row.tenantId, row.key]).sort(), [
        [WARN, 'north', { tenant_id: 'north', number: 1 }],
        [WARN, 'south', { tenant_id: 'south', number: 1 }],
      ]);
      // The warning left both open and due: the next sweeps find them again, and run neither twice.
      await nextSweep(host, clock, lab);
      await nextSweep(host, clock, lab);
      assert.equal((await jobs(lab)).length, 2);
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:1', 'north/2': 'open:0', 'south/1': 'open:1' });
    });

    test('an instant a minute past falls due now, not after midnight', async (t) => {
      // A timestamp is not a day: its cutoff is the minute, so a mark today is due within the sweep.
      const clock = { now: Date.now() };
      const minuteAgo = new Date(clock.now - 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, minuteAgo)));
      const host = await hostOf(t, await enroll(t, lab), clock);
      await until(host, clock, async () => (await receipts(lab, 'warn')).length === 1);
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:1' });
      // Fired, its instant stays passed and the record still matches: later sweeps run it no more (G127).
      await nextSweep(host, clock, lab);
      await nextSweep(host, clock, lab);
      assert.equal((await receipts(lab, 'warn')).length, 1);
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:1' });
    });

    test('a timer runs only while its when holds, and a new instant arms it again (G127)', async (t) => {
      const clock = { now: Date.now() };
      const minuteAgo = new Date(clock.now - 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, minuteAgo), ticket('north', 2, minuteAgo)));
      await lab.rows("UPDATE ticket SET status = 'resolved' WHERE number = 2");
      const host = await hostOf(t, await enroll(t, lab), clock);
      await until(host, clock, async () => (await receipts(lab, 'warn')).length === 1);
      await nextSweep(host, clock, lab);
      assert.deepEqual(
        await tickets(lab),
        { 'north/1': 'open:1', 'north/2': 'resolved:0' },
        'a resolved ticket is not open, so not warned',
      );
      const later = new Date(clock.now - 30_000).toISOString().replace('T', ' ').slice(0, 19);
      await lab.rows(`UPDATE ticket SET warn_at = '${later}' WHERE number = 1`);
      await nextSweep(host, clock, lab);
      await nextSweep(host, clock, lab);
      assert.equal((await receipts(lab, 'warn')).length, 2, 'the new instant ran once');
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:2', 'north/2': 'resolved:0' });
    });

    test('a suspended tenant’s due records do not fire, and fire once it is active again', async (t) => {
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, PAST, PAST), ticket('west', 1, PAST, PAST)));
      await setStatus(lab, 'west', 'suspended');
      const enrollment = await enroll(t, lab),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      await until(host, clock, async () => (await tickets(lab))['north/1'] === 'breached:1');
      await nextSweep(host, clock, lab);
      assert.deepEqual(await tickets(lab), { 'north/1': 'breached:1', 'west/1': 'open:0' });
      assert.ok(
        (await jobs(lab)).every((row) => row.tenantId === 'north'),
        'no run was enqueued for the suspended tenant',
      );

      await setStatus(lab, 'west', 'active');
      await nextSweep(host, clock, lab);
      await until(host, clock, async () => (await tickets(lab))['west/1'] === 'breached:1');
      assert.deepEqual(await receipts(lab, 'breach'), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'service:sla-clock' },
        { realm: 'tenant', tenant_id: 'west', actor_id: 'service:sla-clock' },
      ]);
    });

    test('a job naming another tenant than its row’s finds no row there, and changes nothing', async (t) => {
      // North's ticket is in its state at its stay; a job that says south is not its tenant's.
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, FUTURE)));
      const enrollment = await enroll(t, lab),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      const [stay] = await lab.rows(`SELECT warn_at FROM ticket WHERE tenant_id = 'north' AND number = 1`);
      const forged = await lab.enqueue(
        {
          job: WARN,
          version: 1,
          idempotencyKey: 'forged-other-tenant',
          input: { key: { tenant_id: 'north', number: 1 }, input: {}, since: String(stay.warn_at) },
          provenance: {
            appId: binding.appId,
            actorId: 'service:sla-clock',
            tenantId: 'south',
            correlationId: 'forged-other-tenant',
            causationId: 'forged-other-tenant',
          },
        },
        clock.now,
      );
      await until(host, clock, async () => (await jobs(lab)).some((row) => row.state === 'failed'));
      // Admitted in south, where it is south's service; the command looked for north's row there, and found none.
      assert.deepEqual(
        (await jobs(lab)).map((row) => [row.state, row.code, row.tenantId]),
        [['failed', 'rejected', 'south']],
      );
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:0' });
      assert.deepEqual(await receipts(lab, 'warn'), []);
      assert.ok(forged.id);
      // A platform-owned record's timer carries no tenant: one that names a tenant is not admitted at all.
      await lab.rows(`INSERT INTO review (id, due_at) VALUES ('r1', '${PAST}')`);
      await lab.enqueue(
        {
          job: AUDIT,
          version: 1,
          idempotencyKey: 'forged-platform-tenant',
          input: { key: { id: 'r1' }, input: {}, since: String((await lab.rows(`SELECT due_at FROM review`))[0].due_at) },
          provenance: {
            appId: binding.appId,
            actorId: 'service:lender-desk',
            tenantId: 'north',
            correlationId: 'forged-platform-tenant',
            causationId: 'forged-platform-tenant',
          },
        },
        clock.now,
      );
      await until(host, clock, async () => (await jobs(lab)).filter((row) => row.job === AUDIT).some((row) => row.code !== null));
      assert.deepEqual(
        (await jobs(lab)).filter((row) => row.job === AUDIT).map((row) => row.code),
        ['not_authorized'],
      );
      assert.deepEqual(await receipts(lab, 'audit'), []);
      assert.deepEqual(await lab.rows('SELECT status, note FROM review'), [{ status: 'pending', note: null }]);
    });

    test('a timer on a platform-owned record runs a platform command with no tenant, and reaches no tenant’s row', async (t) => {
      const lab = await openLab(
        t,
        dialect,
        seedTickets(ticket('north', 1, FUTURE), ticket('south', 1, FUTURE)) +
          `INSERT INTO review (id, due_at) VALUES ('r1', '${PAST}'), ('r2', '${FUTURE}');`,
      );
      const enrollment = await enroll(t, lab),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      await until(host, clock, async () => (await receipts(lab, 'audit')).length === 1);
      // Two tickets exist; the platform's own command, with no tenant, counted none.
      assert.deepEqual(await lab.rows('SELECT id, status, note FROM review ORDER BY id'), [
        { id: 'r1', status: 'audited', note: 'saw 0' },
        { id: 'r2', status: 'pending', note: null },
      ]);
      assert.deepEqual(await receipts(lab, 'audit'), [{ realm: 'platform', tenant_id: '', actor_id: 'service:lender-desk' }]);
      assert.deepEqual(
        (await jobs(lab)).map((row) => [row.job, row.tenantId]),
        [[AUDIT, null]],
      );
    });

    test('one tenant with many due records does not starve another: a sweep takes a capped share of each', async (t) => {
      const many = Array.from({ length: DUE_TIMER_CAP * 3 }, (_, index) => ticket('north', index + 1, PAST));
      const lab = await openLab(t, dialect, seedTickets(...many, ticket('south', 1, PAST)));
      const enrollment = await enroll(t, lab),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      // One cycle: one sweep, and at most one run.
      await host.tick();
      const first = await jobs(lab);
      assert.equal(first.filter((row) => row.tenantId === 'north').length, DUE_TIMER_CAP, "north's share of the first sweep is capped");
      assert.deepEqual(
        first.filter((row) => row.tenantId === 'south').map((row) => row.key),
        [{ tenant_id: 'south', number: 1 }],
        "south's one due record is in the first sweep, beside north's sixty",
      );
      // Later sweeps reach the rest of north's, a capped share at a time, and never run one twice.
      for (let sweep = 0; sweep < 3; sweep++) {
        clock.now += 60_000;
        await host.tick();
      }
      const all = await jobs(lab);
      assert.equal(all.length, DUE_TIMER_CAP * 3 + 1);
      assert.equal(new Set(all.map((row) => JSON.stringify(row.key))).size, all.length);
    });

    test('a sandbox’s dev clock brings only its own records due; a live tenant keeps real time', async (t) => {
      // Due in three days, in both: south is a sandbox read a week ahead, north is live.
      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
      const lab = await openLab(t, dialect, seedTickets(ticket('north', 1, soon), ticket('south', 1, soon)));
      await provisionStores(lab.target, { only: ['tenant-sandboxes'] });
      await lab.rows(
        `INSERT INTO "${SANDBOX_TABLES.tenant}" (app, tenant_id, source_tenant_id, samples, created_at, clock_skew_ms, clock_rate, clock_set_at)
         VALUES ('${binding.appId}', 'south', 'north', 1, '2026-01-01T00:00:00.000Z', ${7 * 86_400_000}, 1, ${Date.now()})`,
      );
      const marked = manifest();
      (marked.resources.ticket as Record<string, unknown>).clone = 'sample';
      const enrollment = await enroll(t, lab, parseTestApp(marked, 'tenant-timers-sandbox.ts', contracts)),
        clock = { now: Date.now() },
        host = await hostOf(t, enrollment, clock);
      await until(host, clock, async () => (await tickets(lab))['south/1'] === 'open:1');
      await nextSweep(host, clock, lab);
      assert.deepEqual(await tickets(lab), { 'north/1': 'open:0', 'south/1': 'open:1' });
      assert.deepEqual(
        (await jobs(lab)).map((row) => row.tenantId),
        ['south'],
      );
    });
  });

describe('what a tenant App’s timers refuse at startup, rather than leave unrun', () => {
  async function owned(t: TestContext, kinds: Partial<Record<string, ResourceOwnership>>) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    /* The ticket without its key into the dealer, and a memo that stays tenant-owned: a policy that owns the
       ticket otherwise is one the ownership check admits, so what refuses is the timer's rule alone. */
    db.exec(
      SCHEMA.sqlite.replace('PRAGMA journal_mode=WAL;', '').replace('REFERENCES dealer(id)', '') +
        'CREATE TABLE memo (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL);',
    );
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
      ownership: { ...ownership, memo: { kind: 'tenant', column: 'tenant_id' }, ...kinds } as Record<string, ResourceOwnership>,
    });
  }
  const refused = (pattern: RegExp) => (error: unknown) => error instanceof JobDeclarationError && pattern.test(error.message);

  test('the timers run as jobs of the module, each as a principal of its command’s realm', async (t) => {
    assert.deepEqual([...wrapped.jobs.values()].map((job) => [job.id, job.command.id, job.runAs]).sort(), [
      [AUDIT, 'audit', 'lender-desk'],
      ['at-ticket-due_at', 'breach', 'sla-clock'],
      [WARN, 'warn', 'sla-clock'],
      ['yearly', 'tally', 'lender-desk'],
    ]);
    assertTenantJobs(wrapped, app, commands, await owned(t, {}), binding.source.connection);
    // Provisioning wraps the module as startup does: the stores it derives are the ones startup attests.
    assert.deepEqual(tenantJobPolicies(binding, { commands, jobs: timers, app }), tenantJobPolicies(binding, { commands, jobs: timers }));
  });

  test('a timer on a global table', async (t) => {
    const global = await owned(t, { ticket: { kind: 'global', access: 'read-only' } });
    assert.throws(
      () => assertTenantJobs(wrapped, app, commands, global, binding.source.connection),
      refused(/"ticket" runs "(warn|breach)" at (warn_at|due_at) when status = 'open', and "ticket" is a global table/),
    );
  });

  test('a tenant command on a platform-owned machine', async (t) => {
    const platform = await owned(t, { ticket: { kind: 'platform' } });
    assert.throws(
      () => assertTenantJobs(wrapped, app, commands, platform, binding.source.connection),
      refused(
        /runs "(warn|breach)" .* a tenant command, and "ticket" is platform-owned: its rows are in no tenant, so a timer on them runs a platform command/,
      ),
    );
  });

  test('a timer whose command only a principal of the other realm is granted', () => {
    // The lender's desk is granted the tenant's warning, and no tenant-realm principal is.
    const crossed = parseTestApp(
      manifest({
        clock: { realm: 'tenant', read: true, commands: ['breach'] },
        desk: { realm: 'platform', read: true, commands: ['audit', 'warn'] },
      }),
      'tenant-timers-crossed.ts',
      contracts,
    );
    assert.throws(
      () => withTenantMachineTimers(timers, crossed, commands),
      refused(
        /"ticket" runs "warn" at warn_at when status = 'open', a tenant command, and every principal granted it \("lender-desk"\) holds a role of the other realm: a tenant command's timer runs as a principal whose every role is a tenant-realm role/,
      ),
    );
    // No principal at all is granted it: refused as on an App without tenants.
    const ungranted = parseTestApp(
      manifest({ clock: { realm: 'tenant', read: true, commands: ['breach'] } }),
      'tenant-timers-ungranted.ts',
      contracts,
    );
    assert.throws(() => withTenantMachineTimers(timers, ungranted, commands), /no principal of the jobs module is granted it/);
    assert.throws(
      () =>
        capturedJobModule(
          withTenantMachineTimers(
            defineJobs(
              { yearly: defineJob({ every: '0 0 1 1 *', realm: 'platform', runAs: 'lender-desk', command: 'tally' }) },
              { principals: { 'lender-desk': { roles: ['desk'] } }, store },
            ),
            app,
            commands,
          ),
        ),
      /no principal of the jobs module is granted it/,
    );
  });
});
