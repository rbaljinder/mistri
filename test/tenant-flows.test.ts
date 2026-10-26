/**
 * Row-driven flows on a tenant App, through a real enrollment, job host and
 * tenant HTTP server, on SQLite and, when `TABLEWALK_TEST_PG` names a
 * disposable server, PostgreSQL (each test owns a database named by a UUID).
 * The control connection reads what the database holds.
 *
 * 1. A run is one tenant's: north's flow runs on north's ticket, under north's
 *    service, and never on south's ticket, which its condition would match; a
 *    fact south records naming north's ticket never resumes north's run.
 * 2. The flows section's route reads a record's runs in the member's own
 *    tenant, refuses a record of another tenant, and a manual start runs the
 *    flow in the starter's tenant alone.
 * 3. A flow or step row is judged on the tenant write path (the 422 shape).
 * 4. What stays refused: a flows table not tenant-owned.
 * 5. A notify step tells the record's own tenant's inbox, and no other (G95).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES as journal, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { historyKey } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { tenantInbox } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { openPostgresWorkflowStore } from '../packages/mistri/src/adapters/workflows/postgresWorkflowStore.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import type { WorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStoreContract.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import { defineJobs, type JobModule } from '../packages/mistri/src/server/jobs/jobModule.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { openTenantJobHost } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { flowRunner } from '../packages/mistri/src/server/workflows/flowRunner.js';
import { workflowPartition } from '../packages/mistri/src/server/workflows/workflowKeys.js';
import { defineWorkflows } from '../packages/mistri/src/server/workflows/workflowModule.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const HOUR = 3_600_000;
const binding = { appId: 'tenant-flows', source: { id: 'business', connection: 'flows-business' }, storeId: 'tenant-flows-store' };

/* ---------- the App: tickets whose flows are rows, each tenant's own ---------- */

const manifest = (flowOwner: 'tenant' | 'global' = 'tenant') => ({
  id: binding.appId,
  name: 'Tenant flows',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    ticket: {
      access: 'write',
      owner: 'tenant',
      flows: {
        from: 'ticket_flow',
        steps: 'ticket_flow_step',
        set: ['stage'],
        events: { 'ticket.answered': 'ticket' },
        kinds: { ask: { command: 'askTeam', input: ['team'], waitFor: 'ticket.answered' } },
      },
      notify: [{ on: { flow: 'requester' }, to: 'watcher', title: '{title}: {message}' }],
    },
    ticket_flow: flowOwner === 'tenant' ? { access: 'write', owner: 'tenant' } : { owner: 'global' },
    ticket_flow_step: { access: 'write', owner: 'tenant' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      member: {
        realm: 'tenant',
        read: true,
        write: flowOwner === 'tenant' ? ['ticket_flow', 'ticket_flow_step'] : ['ticket_flow_step'],
        commands: ['openTicket', 'answerTicket', 'announce'],
        operations: ['workflows'],
      },
      automation: { realm: 'tenant', read: true, commands: ['askTeam'] },
    },
  },
  views: { tickets: { kind: 'list', from: 'ticket' } },
  home: 'tickets',
});
const app = parseTestApp(manifest(), 'tenant-flows.ts');
const pages = parsePagesConfig(
  { pages: [{ id: 'ticket', label: 'Ticket', base: 'ticket', sections: [{ kind: 'fields', show: ['title'] }, { kind: 'flows' }] }] },
  'tenant flows fixture',
);

const tenantRows = (flowOwner: string): Record<string, boolean> =>
  flowOwner === 'tenant' ? { ticket: true, ticket_flow: true, ticket_flow_step: true } : { ticket: true, ticket_flow_step: true };

const policyOf = (flowOwner: 'tenant' | 'global' = 'tenant') =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: {
      dealer: { kind: 'platform' },
      ticket: { kind: 'tenant', column: 'tenant_id' },
      ticket_flow: flowOwner === 'tenant' ? { kind: 'tenant', column: 'tenant_id' } : { kind: 'global', access: 'read-only' },
      ticket_flow_step: { kind: 'tenant', column: 'tenant_id' },
    },
    resolveMembershipRows: () => tenantRows(flowOwner),
    resolveRows: () => tenantRows(flowOwner),
    resolvePlatformRows: () => ({ dealer: true, ticket: true, ticket_flow: true, ticket_flow_step: true }),
    resultReferences: {
      openTicket: (value: unknown) => [{ table: 'ticket', key: { id: (value as { id: string }).id } }],
      askTeam: () => [],
      answerTicket: () => [],
      announce: () => [],
    },
  });
const policy = policyOf();

type Answered = { ticket: string };
const ticketAnswered = defineEvent('ticket.answered', shape({ ticket: text() }));
const output = { parse: (value: unknown) => value as Record<string, unknown> };
const answeredOutput = { parse: (value: unknown) => value as Answered };
const answered = { answered: defineEventProjection(ticketAnswered, (value: Answered) => ({ ticket: value.ticket })) };
const commands = defineCommands({
  openTicket: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    input: { id: { type: 'text' }, title: { type: 'text' }, priority: { type: 'text' } },
    output,
    async handle({ db }, input) {
      await db.ticket.insert({
        id: String(input.id),
        title: String(input.title),
        priority: String(input.priority),
        watcher: 'desk@example.invalid',
        stage: 'new',
        version: 0,
      });
      return { id: String(input.id) };
    },
  }),
  // A flow's step kind: the step's `team` column is its input.
  askTeam: defineCommand({
    source: 'business',
    target: 'ticket',
    input: { team: { type: 'text' } },
    output,
    async handle({ db, record }, input) {
      await db.ticket.update(record, { asked: String(input.team), version: Number(record.version) + 1 });
      return { asked: true };
    },
  }),
  answerTicket: defineCommand({
    source: 'business',
    target: 'ticket',
    input: { answer: { type: 'text' } },
    output: answeredOutput,
    events: answered,
    async handle({ db, record }, input) {
      await db.ticket.update(record, { answer: String(input.answer), version: Number(record.version) + 1 });
      return { ticket: String(record.id) };
    },
  }),
  // A fact naming any ticket at all: a member of south names north's.
  announce: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    input: { ticket: { type: 'text' } },
    output: answeredOutput,
    events: answered,
    async handle(_context, input) {
      return { ticket: String(input.ticket) };
    },
  }),
});
const store = { namespace: 'tenant-flows', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } };
const jobs = defineJobs(
  {},
  {
    principals: { automation: { roles: ['automation'] } },
    store,
    workflows: defineWorkflows({ tickets: flowRunner('ticket', { runAs: 'automation', listens: [ticketAnswered] }) }),
  },
);

/* ---------- the engines ---------- */

const TABLES = (types: { text: string; int: string }) => `
    CREATE TABLE dealer (id ${types.text} PRIMARY KEY NOT NULL, name ${types.text} NOT NULL);
    CREATE TABLE ticket (id ${types.text} PRIMARY KEY NOT NULL, tenant_id ${types.text} NOT NULL REFERENCES dealer(id),
      title ${types.text} NOT NULL, priority ${types.text} NOT NULL, stage ${types.text}, asked ${types.text}, answer ${types.text},
      watcher ${types.text}, version ${types.int} NOT NULL DEFAULT 0);
    CREATE TABLE ticket_flow (id ${types.text} PRIMARY KEY NOT NULL, tenant_id ${types.text} NOT NULL,
      name ${types.text} NOT NULL, start ${types.text} NOT NULL, condition ${types.text}, changes ${types.text},
      active ${types.int} NOT NULL DEFAULT 1, version ${types.int} NOT NULL DEFAULT 0);
    CREATE TABLE ticket_flow_step (id ${types.text} PRIMARY KEY NOT NULL, tenant_id ${types.text} NOT NULL REFERENCES dealer(id),
      flow_id ${types.text} NOT NULL, position ${types.int} NOT NULL, kind ${types.text} NOT NULL, title ${types.text},
      duration ${types.text}, field ${types.text}, value ${types.text}, condition ${types.text}, "goto" ${types.int},
      event ${types.text}, team ${types.text}, audience ${types.text}, message ${types.text}, version ${types.int} NOT NULL DEFAULT 0);`;
/* North's flow escalates a high-priority ticket: it would match south's high-priority ticket too, were it ever to see it.
   South's own flow starts on an urgent one only, and south has a flow to start by hand. */
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO ticket_flow (id, tenant_id, name, start, condition) VALUES
      ('nf', 'north', 'Escalate', 'created', 'priority = high'),
      ('sf', 'south', 'Urgent only', 'created', 'priority = urgent'),
      ('sm', 'south', 'Escalate by hand', 'manual', NULL);
    INSERT INTO ticket_flow_step (id, tenant_id, flow_id, position, kind, title, field, value, team, condition) VALUES
      ('n1', 'north', 'nf', 1, 'set', 'Triage', 'stage', 'triage', NULL, NULL),
      ('n2', 'north', 'nf', 2, 'ask', 'Ask ops', NULL, NULL, 'ops', NULL),
      ('n3', 'north', 'nf', 3, 'branch', 'Answered yes?', NULL, NULL, NULL, 'answer = yes'),
      ('n4', 'north', 'nf', 4, 'set', 'Close', 'stage', 'closed', NULL, NULL),
      ('s1', 'south', 'sf', 1, 'set', 'Mark urgent', 'stage', 'urgent', NULL, NULL),
      ('m1', 'south', 'sm', 1, 'set', 'Escalate', 'stage', 'escalated', NULL, NULL);
    INSERT INTO ticket_flow_step (id, tenant_id, flow_id, position, kind, title, audience, message) VALUES
      ('m2', 'south', 'sm', 2, 'notify', 'Tell the desk', 'requester', 'escalated by hand');`;

interface Lab {
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  workflows(): Promise<WorkflowStore>;
}

async function sqliteLab(t: TestContext, module: JobModule): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-flows-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;${TABLES({ text: 'TEXT', int: 'INTEGER' })}${ROWS}`);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  provisionSqliteRecordHistory(path);
  provisionSqliteInbox(path);
  await provisionStores({ sqlite: path }, { app: { tenant: binding, commands }, jobs: module });
  return {
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
    async workflows() {
      const opened = openSqliteWorkflowStore(path);
      t.after(() => opened.close());
      return opened;
    },
  };
}

async function postgresLab(t: TestContext, module: JobModule): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_flows');
  const control = await pgClient(url),
    managers: PgConnectionManager[] = [];
  t.after(async () => {
    await Promise.allSettled(managers.map((manager) => manager.close()));
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(TABLES({ text: 'text', int: 'integer' }) + ROWS);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  await provisionPostgresRecordHistory(url);
  await provisionPostgresInbox(url);
  await provisionStores({ postgres: url }, { app: { tenant: binding, commands }, jobs: module });
  return {
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
    async workflows() {
      const manager = new PgConnectionManager(url);
      managers.push(manager);
      const opened = await openPostgresWorkflowStore(manager, store.namespace);
      t.after(() => opened.close());
      return opened;
    },
  };
}

/** Two tenants and the platform, active; Ada a member of each. */
async function openLab(t: TestContext, dialect: Dialect, module: JobModule = jobs): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t, module) : postgresLab(t, module));
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    for (const tenantId of ['north', 'south'])
      await admin.putMembership({
        tenantId,
        accountId: 'ada',
        membershipId: `${tenantId}-ada`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + HOUR,
        expectedVersion: null,
      });
  });
  return lab;
}

type Request = IncomingMessage | { readonly account: string };
async function enroll(t: TestContext, lab: Lab, options: { app?: typeof app; policy?: typeof policy } = {}) {
  const enrollment = await createTenantEnrollment<Request>({
    app: options.app ?? app,
    pages,
    policy: options.policy ?? policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['member', 'automation'],
    maxLifetimeMs: 60_000,
    verifySession: () => ({ id: 'ada', who: 'ada@example.test' }),
    commands: { registry: commands },
    jobs: { module: jobs },
  }).catch((error: unknown) => {
    // The one opaque refusal, with the reason enrollment recorded for the operator.
    throw Object.assign(new Error(refusalReasons(error).join(' / ') || String(error)), { refusal: error });
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

async function hostOf(t: TestContext, enrollment: TenantEnrollment<Request>) {
  const host = await openTenantJobHost(enrollment, { idleMs: 60_000 });
  assert.ok(host, 'an enrollment with a flows runner opens a host');
  t.after(() => host.stop());
  return host;
}
async function until(host: JobHost, done: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await done()) return;
    await host.tick();
  }
  assert.fail(`${what} never happened`);
}

async function execute(lab: Lab, enrollment: TenantEnrollment<Request>, tenant: string, command: string, key: Row, input: Row) {
  const [row] = key.id === undefined ? [{ version: 0 }] : await lab.rows(`SELECT version FROM ticket WHERE id = '${String(key.id)}'`);
  await enrollment.deployment.execute({ account: 'ada' }, [tenant], {
    command,
    commandVersion: 1,
    key: key as Record<string, string>,
    expectedVersion: Number(row.version),
    idempotencyKey: `${command}-${tenant}-${String(key.id ?? input.id ?? input.ticket)}-${Number(row.version)}`,
    input,
  });
}
const ticket = async (lab: Lab, id: string) =>
  (await lab.rows(`SELECT stage, asked, answer FROM ticket WHERE id = '${id}'`)).map((row) => ({ ...row }))[0];

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant flows on ${dialect}`, { skip }, () => {
    test("a flow's run is one tenant's: it starts on its own tenant's records alone, and another tenant's fact never resumes it", async (t) => {
      const lab = await openLab(t, dialect);
      const enrollment = await enroll(t, lab),
        host = await hostOf(t, enrollment);
      const workflows = await lab.workflows();
      const north = workflowPartition('tickets', 'north'),
        south = workflowPartition('tickets', 'south');
      const instances = async () => (await workflows.inspect()).map((row) => ({ workflow: row.workflow, key: row.key, state: row.state }));

      // South's high-priority ticket first: north's flow would match it, were it to see it.
      await execute(lab, enrollment, 'south', 'openTicket', {}, { id: 'st', title: 'Brakes', priority: 'high' });
      await execute(lab, enrollment, 'north', 'openTicket', {}, { id: 'nt', title: 'Engine', priority: 'high' });
      const northRun = `${historyKey({ id: 'nt', tenant_id: 'north' })}|nf`;
      await until(
        host,
        async () => (await instances()).some((row) => row.key === northRun && row.state === 'waiting'),
        "north's run waiting",
      );
      assert.deepEqual(
        await instances(),
        [{ workflow: north, key: northRun, state: 'waiting' }],
        "one run, in north's partition, keyed with its owner",
      );
      assert.deepEqual(await ticket(lab, 'nt'), { stage: 'triage', asked: 'ops', answer: null });
      assert.deepEqual(await ticket(lab, 'st'), { stage: 'new', asked: null, answer: null }, "north's flow never touched south's ticket");

      // South records the fact naming north's ticket: it reaches south's partition alone, where no run waits for it.
      await execute(lab, enrollment, 'south', 'announce', {}, { ticket: 'nt' });
      for (let i = 0; i < 20; i++) await host.tick();
      assert.deepEqual(await instances(), [{ workflow: north, key: northRun, state: 'waiting' }], "south's fact never resumed north's run");

      // North's own answer resumes it: the branch holds and the flow closes the ticket.
      await execute(lab, enrollment, 'north', 'answerTicket', { id: 'nt' }, { answer: 'yes' });
      await until(host, async () => (await instances()).some((row) => row.state === 'completed'), "north's run completing");
      assert.deepEqual(await ticket(lab, 'nt'), { stage: 'closed', asked: 'ops', answer: 'yes' });
      assert.deepEqual(await ticket(lab, 'st'), { stage: 'new', asked: null, answer: null });
      assert.ok(!(await instances()).some((row) => row.workflow === south), 'no run of any flow in south');
      // Each command the flow ran was the runner's principal's, in north.
      const receipts = await lab.rows(
        `SELECT command_id, tenant_id, actor_id FROM "${journal.receipt}" WHERE actor_id = 'service:automation' ORDER BY command_id, tenant_id`,
      );
      const ran = (tenant: string) => [...new Set(receipts.filter((row) => row.tenant_id === tenant).map((row) => String(row.command_id)))];
      assert.deepEqual(ran('north'), ['askTeam', 'flows-ticket'], "in north: the step kind's command and the flows' own reads and sets");
      // In south only the match ran, in south, against south's flows: none started on south's ticket.
      assert.deepEqual(ran('south'), ['flows-ticket']);
      assert.equal(receipts.filter((row) => row.tenant_id === 'south').length, 1);
    });

    test("the flows section's route reads in the member's own tenant, and a manual start runs in the starter's tenant alone", async (t) => {
      const lab = await openLab(t, dialect);
      const enrollment = await enroll(t, lab),
        host = await hostOf(t, enrollment);
      host.start();
      await execute(lab, enrollment, 'north', 'openTicket', {}, { id: 'nt', title: 'Engine', priority: 'low' });
      await execute(lab, enrollment, 'south', 'openTicket', {}, { id: 'st', title: 'Brakes', priority: 'low' });

      const session: VerifiedSessionInstance = {
        identity: { id: 'ada', who: 'ada@example.test' },
        sessionId: 'tenant-flows-session-ada',
        expiresAt: Date.now() + HOUR,
      };
      const bound = { host: '127.0.0.1', port: 0 };
      const owner = createTenantHttpServer({
        app,
        enrollment: enrollment as TenantEnrollment<IncomingMessage>,
        bound,
        verifySessionInstance: () => session,
      });
      owner.server.listen(0, bound.host);
      await once(owner.server, 'listening');
      bound.port = (owner.server.address() as { port: number }).port;
      t.after(async () => {
        const closed = new Promise<void>((resolve) => owner.server.close(() => resolve()));
        owner.server.closeAllConnections();
        await closed;
        await owner.retire();
      });
      const call = async (path: string, tenant: string, body: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=${binding.appId}&tenant=${tenant}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
      };
      const open = async (tenant: string) => {
        const reply = await call('/api/tenant/context/open', tenant, {});
        assert.equal(reply.status, 200, reply.text);
        const value = reply.body as { tabId: string; context: string; revision: number; accountId: string };
        return (path: string, body: unknown) =>
          call(path, tenant, body, {
            'x-mistri-tab': value.tabId,
            'x-mistri-context': value.context,
            'x-mistri-lease-revision': String(value.revision),
            'x-mistri-account': value.accountId,
          });
      };
      const inNorth = await open('north'),
        inSouth = await open('south');

      // South's ticket: its manual flow is offered in south, and nothing has run yet.
      const read = await inSouth('/api/record-flows', { table: 'ticket', key: { id: 'st' } });
      assert.equal(read.status, 200, read.text);
      assert.deepEqual(read.body, { running: true, runs: [], manual: [{ id: 'sm', name: 'Escalate by hand' }] });
      // North neither sees south's ticket nor starts south's flow on its own.
      assert.notEqual((await inNorth('/api/record-flows', { table: 'ticket', key: { id: 'st' } })).status, 200);
      assert.notEqual((await inNorth('/api/record-flows/start', { table: 'ticket', key: { id: 'st' }, flow: 'sm' })).status, 200);
      const foreign = await inNorth('/api/record-flows/start', { table: 'ticket', key: { id: 'nt' }, flow: 'sm' });
      assert.equal(foreign.status, 409, "south's flow is not north's to start");

      const started = await inSouth('/api/record-flows/start', { table: 'ticket', key: { id: 'st' }, flow: 'sm' });
      assert.equal(started.status, 200, started.text);
      await until(host, async () => (await ticket(lab, 'st')).stage === 'escalated', 'the manual run');
      assert.deepEqual(await ticket(lab, 'nt'), { stage: 'new', asked: null, answer: null });
      let runs: Array<Record<string, unknown>> = [];
      await until(
        host,
        async () => {
          runs = (await inSouth('/api/record-flows', { table: 'ticket', key: { id: 'st' } })).body.runs as typeof runs;
          return runs.length === 1 && runs[0].state === 'completed';
        },
        'the run shown completed',
      );
      assert.equal(runs[0].name, 'Escalate by hand');
      assert.deepEqual(
        (runs[0].steps as Array<{ label: string }>).map((step) => step.label),
        ['Read the flow', '1. Escalate', '2. Tell the desk'],
      );
      // The notify step told the desk in south's inbox alone, in the rule's words with the row's message.
      const told = async (tenant: string) =>
        (
          await enrollment.deployment.inbox.readInbox({
            app: tenantInbox(binding.appId, tenant),
            recipient: 'desk@example.invalid',
            limit: 10,
          })
        ).map((notice) => [notice.resource, notice.title]);
      assert.deepEqual(await told('south'), [['ticket', 'Brakes: escalated by hand']]);
      assert.deepEqual(await told('north'), []);
      // North's ticket shows no run of south's.
      const northRuns = await inNorth('/api/record-flows', { table: 'ticket', key: { id: 'nt' } });
      assert.deepEqual(northRuns.body.runs, []);

      // A step row is judged on the tenant write path: an unknown kind is refused in the App's rejected envelope, by field.
      const good = await inNorth('/api/insert', {
        table: 'ticket_flow_step',
        values: { id: 'good', flow_id: 'nf', position: 9, kind: 'set', field: 'stage', value: 'done' },
      });
      assert.equal(good.status, 200, good.text);
      const bad = await inNorth('/api/insert', {
        table: 'ticket_flow_step',
        values: { id: 'bad', flow_id: 'nf', position: 9, kind: 'teleport' },
      });
      assert.equal(bad.status, 200, bad.text);
      assert.deepEqual(bad.body, {
        errors: [
          {
            code: 'validation_failed',
            message: 'The record does not satisfy the application rules.',
            fields: [{ field: 'kind', message: 'Choose one of the step kinds this App offers.' }],
          },
        ],
        outcome: 'rejected',
      });
      assert.equal((await lab.rows(`SELECT id FROM ticket_flow_step WHERE id = 'bad'`)).length, 0);
    });

    test('a flows runner whose flows table is not tenant-owned is refused at enrollment', async (t) => {
      const lab = await openLab(t, dialect);
      await assert.rejects(
        enroll(t, lab, { app: parseTestApp(manifest('global'), 'tenant-flows.ts'), policy: policyOf('global') }),
        /"ticket_flow" must be tenant-owned/,
      );
    });
  });
