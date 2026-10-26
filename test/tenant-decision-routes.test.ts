/**
 * A tenant App's decisions as its members meet them, through a real
 * enrollment, job host and tenant HTTP server, on SQLite and, when
 * `TABLEWALK_TEST_PG` names a disposable server, PostgreSQL (each test owns a
 * database named by a UUID). The model is the scripted provider double
 * (MISTRI_DECIDE_SCRIPT): no network.
 *
 * 1. The payload reserves a decided field, and the record's suggestion, the
 *    list's mark, "Why this?" and settling are answered on the lease — the
 *    tenant's own rows alone. North never sees south's suggestion: not on
 *    south's record, not by its id, and not a row south's tenant holds about
 *    north's record; settling one of south's from north moves nothing.
 * 2. Only a member granted the answer command is offered a suggestion: a
 *    resident who reads the same ticket is told of none, and is refused
 *    "Why this?" and settling, by the server.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { DECISION_TABLES, type DecisionStore } from '../packages/mistri/src/adapters/decide/decisionStore.js';
import { openPostgresDecisions, provisionPostgresDecisions } from '../packages/mistri/src/adapters/decide/postgresDecisions.js';
import { openSqliteDecisions, provisionSqliteDecisions } from '../packages/mistri/src/adapters/decide/sqliteDecisions.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import {
  defineCommand,
  defineCommands,
  defineEvent,
  defineEventProjection,
  field,
  shape,
  text,
} from '../packages/mistri/src/server/commands.js';
import { resetCircuits } from '../packages/mistri/src/server/decide/providers/decisionProviders.js';
import type { JobHost } from '../packages/mistri/src/server/jobs/jobHost.js';
import { defineDecision, defineDecisions, defineJobs } from '../packages/mistri/src/server/jobs.js';
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
const binding = { appId: 'tenant-decide', source: { id: 'business', connection: 'decide-business' }, storeId: 'tenant-decide-store' };

/* ---------- the App: repair tickets whose team a decision suggests ---------- */

const app = parseTestApp(
  {
    id: binding.appId,
    name: 'Tenant decisions',
    sources: { business: { connection: binding.source.connection } },
    resources: { dealer: { owner: 'platform' }, ticket: { access: 'write', owner: 'tenant' } },
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
      roles: {
        // The office: may accept a suggested team.
        manager: { realm: 'tenant', read: true, commands: ['openTicket', 'assign'] },
        // Reports a repair and reads it, team and all; never chooses the team.
        resident: { realm: 'tenant', read: true, commands: ['openTicket'] },
        automation: { realm: 'tenant', read: true, commands: ['assign'] },
      },
    },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
  },
  'tenant-decide.ts',
);
const pages = parsePagesConfig(
  { pages: [{ id: 'ticket', label: 'Ticket', base: 'ticket', sections: [{ kind: 'fields', show: ['title', 'team'] }] }] },
  'tenant decisions fixture',
);
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { dealer: { kind: 'platform' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ ticket: true }),
  resolveRows: () => ({ ticket: true }),
  resolvePlatformRows: () => ({ dealer: true, ticket: true }),
  resultReferences: {
    openTicket: (value: unknown) => [{ table: 'ticket', key: { id: (value as { id: string }).id } }],
    assign: () => [],
  },
});

const ticketOpened = defineEvent('ticket.opened', shape({ id: text() }));
const commands = defineCommands({
  openTicket: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    input: { id: { type: 'text' }, title: { type: 'text' } },
    output: shape({ id: text() }),
    events: { opened: defineEventProjection(ticketOpened, (value: { id: string }) => ({ id: value.id })) },
    async handle({ db }, input) {
      await db.ticket.insert({ id: String(input.id), title: String(input.title), version: 0 });
      return { id: String(input.id) };
    },
  }),
  assign: defineCommand({
    source: 'business',
    target: 'ticket',
    input: { team: field.choice(['plumbing', 'electrical']) },
    async handle({ db, record }, input) {
      await db.ticket.update(record, { team: input.team, version: Number(record.version) + 1 });
    },
  }),
});
const jobs = defineJobs(
  {},
  {
    principals: { triage: { roles: ['automation'] } },
    store: { namespace: 'tenant-decide', leaseMs: 20_000, backoffMs: { base: 1_000, cap: 1_000 } },
    decisions: defineDecisions({
      routeTicket: defineDecision({
        question: 'Which team should take this repair?',
        target: 'ticket',
        inputs: ['title'],
        answer: { command: 'assign', field: 'team' },
        on: { event: ticketOpened, command: 'openTicket', key: (event: { id: string }) => ({ id: event.id }) },
        runAs: 'triage',
        provider: 'jev',
      }),
    }),
  },
);

/* ---------- the engines ---------- */

const TABLES = (types: { text: string; int: string }) => `
    CREATE TABLE dealer (id ${types.text} PRIMARY KEY NOT NULL, name ${types.text} NOT NULL);
    CREATE TABLE ticket (id ${types.text} PRIMARY KEY NOT NULL, tenant_id ${types.text} NOT NULL REFERENCES dealer(id),
      title ${types.text} NOT NULL, team ${types.text}, version ${types.int} NOT NULL DEFAULT 0);
    INSERT INTO dealer VALUES ('north', 'North Homes'), ('south', 'South Lets');`;

interface Lab {
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  rows(sql: string): Promise<Row[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  decisions(): Promise<DecisionStore>;
}

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-decide-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;${TABLES({ text: 'TEXT', int: 'INTEGER' })}`);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  await provisionStores({ sqlite: path }, { app: { tenant: binding, commands }, jobs });
  provisionSqliteDecisions(path);
  return {
    source: { ...binding.source, existingPath: path },
    rows: async (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    run: async (sql, params) => {
      db.prepare(sql).run(...(params as never[]));
    },
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
    async decisions() {
      const store = openSqliteDecisions(path);
      t.after(() => store.close());
      return store;
    },
  };
}

async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_decide');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(TABLES({ text: 'text', int: 'integer' }));
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  await provisionStores({ postgres: url }, { app: { tenant: binding, commands }, jobs });
  await provisionPostgresDecisions(url);
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  return {
    source: { ...binding.source, url },
    rows: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows.map((row) => ({ ...row })),
    run: async (sql, params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    },
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
    async decisions() {
      const store = await openPostgresDecisions(url);
      t.after(() => store.close());
      return store;
    },
  };
}

/** Two tenants and the platform, active: Ada manages in each, Bea is a resident of north. */
async function openLab(t: TestContext, dialect: Dialect): Promise<Lab> {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    const member = (tenantId: string, accountId: string, roles: string[]) =>
      admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles,
        validUntil: Date.now() + HOUR,
        expectedVersion: null,
      });
    await member('north', 'ada', ['manager']);
    await member('south', 'ada', ['manager']);
    await member('north', 'bea', ['resident']);
  });
  return lab;
}

type Request = IncomingMessage | { readonly account: string };
const accountOf = (request: Request) =>
  'account' in request ? request.account : String((request as IncomingMessage).headers['x-test-account'] ?? 'ada');

async function enroll(t: TestContext, lab: Lab) {
  const enrollment = await createTenantEnrollment<Request>({
    app,
    pages,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['manager', 'resident', 'automation'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: accountOf(request), who: `${accountOf(request)}@example.test` }),
    commands: { registry: commands },
    jobs: { module: jobs },
  }).catch((error: unknown) => {
    throw Object.assign(new Error(refusalReasons(error).join(' / ') || String(error)), { refusal: error });
  });
  t.after(() => enrollment.retire());
  return enrollment;
}

async function until(host: JobHost, done: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await done()) return;
    await host.tick();
  }
  assert.fail(`${what} never happened`);
}

async function serve(t: TestContext, enrollment: TenantEnrollment<Request>) {
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment: enrollment as TenantEnrollment<IncomingMessage>,
    bound,
    verifySessionInstance: (request): VerifiedSessionInstance => {
      const id = accountOf(request);
      return { identity: { id, who: `${id}@example.test` }, sessionId: `tenant-decide-session-${id}`, expiresAt: Date.now() + HOUR };
    },
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
  const call = async (method: 'GET' | 'POST', path: string, tenant: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=${binding.appId}&tenant=${tenant}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as Record<string, any>, text };
  };
  /** A member's tab on one tenant's lease: its posts, and its App payload. */
  return async (account: string, tenant: string) => {
    const opened = await call('POST', '/api/tenant/context/open', tenant, {}, { 'x-test-account': account });
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body as { tabId: string; context: string; revision: number; accountId: string };
    const headers = {
      'x-test-account': account,
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    };
    return {
      post: (path: string, body: unknown) => call('POST', path, tenant, body, headers),
      app: async () => (await call('GET', '/api/app', tenant, undefined, headers)).body.app as { decisions?: unknown },
    };
  };
}

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant decisions served on ${dialect}`, { skip }, () => {
    test("each tenant's members see its own suggestions alone, and only those who could accept one", async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'tablewalk-decide-script-'));
      const script = join(directory, 'script.json');
      writeFileSync(
        script,
        JSON.stringify({
          model: 'scripted',
          modelVersion: 'scripted-1',
          decisions: {
            routeTicket: [
              { when: { title: 'tap' }, answer: 'plumbing', probability: 0.8 },
              { when: { title: 'socket' }, answer: 'electrical', probability: 0.75 },
            ],
          },
        }),
      );
      const before = process.env.MISTRI_DECIDE_SCRIPT;
      process.env.MISTRI_DECIDE_SCRIPT = script;
      resetCircuits();
      t.after(() => {
        if (before === undefined) delete process.env.MISTRI_DECIDE_SCRIPT;
        else process.env.MISTRI_DECIDE_SCRIPT = before;
        rmSync(directory, { recursive: true, force: true });
      });

      const lab = await openLab(t, dialect);
      const store = await lab.decisions();
      // The platform owner turned the provider on for both customers (setTenantDecisions).
      for (const tenant of ['north', 'south'])
        await store.setSwitch(binding.appId, tenant, 'jev', true, `DPA-${tenant}`, new Date().toISOString());
      const enrollment = await enroll(t, lab);
      const host = await openTenantJobHost(enrollment, { idleMs: 60_000 });
      assert.ok(host, 'an enrollment with decisions opens a host');
      t.after(() => host.stop());
      const execute = (tenant: string, input: Row) =>
        enrollment.deployment.execute({ account: 'ada' }, [tenant], {
          command: 'openTicket',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          input,
        });
      await execute('north', { id: 'n1', title: 'Dripping tap' });
      await execute('south', { id: 's1', title: 'Dead socket' });
      const own = (tenant: string, id: string) => store.ofRecord({ app: binding.appId, tenant }, 'ticket', JSON.stringify({ id }), 10);
      await until(host, async () => (await own('north', 'n1')).length > 0 && (await own('south', 's1')).length > 0, 'both decided');
      const [northRow] = await own('north', 'n1');
      const [southRow] = await own('south', 's1');
      assert.deepEqual([northRow.outcome, northRow.answer], ['suggested', 'plumbing']);
      assert.deepEqual([southRow.outcome, southRow.answer], ['suggested', 'electrical']);
      assert.deepEqual(await own('south', 'n1'), [], "each tenant's decision is kept under its own tenant");

      /* A row south's tenant holds about north's record (as a forged or misrouted one would be): north's lease
         reads its own tenant's rows, so it is never offered, whatever record it names. */
      const [stored] = await lab.rows(`SELECT * FROM "${DECISION_TABLES.record}" WHERE id = '${northRow.id}'`);
      const forged = { ...stored, id: 'forged-south-row', tenant: 'south', answer: JSON.stringify('electrical') };
      const columns = Object.keys(forged);
      await lab.run(
        `INSERT INTO "${DECISION_TABLES.record}" (${columns.map((name) => `"${name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((name) => (forged as Row)[name]),
      );

      const tab = await serve(t, enrollment);
      const adaNorth = await tab('ada', 'north'),
        adaSouth = await tab('ada', 'south'),
        beaNorth = await tab('bea', 'north');

      // The payload reserves the decided field for a member who could accept it.
      assert.deepEqual(await adaNorth.app().then((served) => served.decisions), {
        ticket: { team: { decision: 'routeTicket', command: 'assign' } },
      });

      // North's manager: north's suggestion on north's ticket, and nothing of south's.
      const northSaid = await adaNorth.post('/api/record-decisions', { table: 'ticket', key: { id: 'n1' } });
      assert.equal(northSaid.status, 200, northSaid.text);
      assert.deepEqual(
        northSaid.body.suggestions.map((each: Row) => [each.id, each.field, each.label, each.command]),
        [[northRow.id, 'team', 'plumbing', 'assign']],
      );
      const marks = await adaNorth.post('/api/record-decisions/marks', { table: 'ticket', keys: [{ id: 'n1' }, { id: 's1' }] });
      assert.equal(marks.status, 200, marks.text);
      assert.deepEqual(marks.body.marks, [{ row: 0, field: 'team', label: 'plumbing' }]);
      // South's ticket is not north's to read, and south's rows are not north's by their id: the ordinary not-found.
      assert.equal((await adaNorth.post('/api/record-decisions', { table: 'ticket', key: { id: 's1' } })).status, 404);
      assert.equal((await adaNorth.post('/api/record-decisions/why', { id: southRow.id })).status, 404);
      assert.equal((await adaNorth.post('/api/record-decisions/why', { id: 'forged-south-row' })).status, 404);
      assert.equal((await adaNorth.post('/api/record-decisions/settle', { id: southRow.id, action: 'dismiss' })).status, 404);
      assert.equal((await own('south', 's1'))[0].outcome, 'suggested', "north's dismissal moved nothing of south's");
      // The lease still stands after those refusals: a decision route ends no context.
      assert.equal((await adaNorth.post('/api/record-decisions', { table: 'ticket', key: { id: 'n1' } })).status, 200);

      // South's manager, the same account on south's lease: south's suggestion alone.
      const southSaid = await adaSouth.post('/api/record-decisions', { table: 'ticket', key: { id: 's1' } });
      assert.deepEqual(
        southSaid.body.suggestions.map((each: Row) => [each.id, each.label]),
        [[southRow.id, 'electrical']],
      );
      assert.equal((await adaSouth.post('/api/record-decisions', { table: 'ticket', key: { id: 'n1' } })).status, 404);

      // "Why this?" on the lease: the question, the inputs as north reads them, who answered.
      const why = await adaNorth.post('/api/record-decisions/why', { id: northRow.id });
      assert.equal(why.status, 200, why.text);
      assert.equal(why.body.question, 'Which team should take this repair?');
      assert.deepEqual(why.body.inputs, [{ name: 'title', label: 'Title', value: 'Dripping tap', readable: true }]);
      assert.deepEqual([why.body.provider, why.body.modelVersion, why.body.probability], ['jev', 'scripted-1', 0.8]);

      // A resident of north reads the same ticket, team and all, and is offered nothing: the server says so.
      assert.equal((await beaNorth.app()).decisions, undefined);
      const resident = await beaNorth.post('/api/record-decisions', { table: 'ticket', key: { id: 'n1' } });
      assert.equal(resident.status, 200, resident.text);
      assert.deepEqual(resident.body, { suggestions: [] });
      assert.deepEqual((await beaNorth.post('/api/record-decisions/marks', { table: 'ticket', keys: [{ id: 'n1' }] })).body, {
        marks: [],
      });
      assert.equal((await beaNorth.post('/api/record-decisions/why', { id: northRow.id })).status, 404);
      assert.equal((await beaNorth.post('/api/record-decisions/settle', { id: northRow.id, action: 'dismiss' })).status, 404);
      assert.equal((await own('north', 'n1'))[0].outcome, 'suggested');

      // North's manager accepts as themselves (the answer command), and settling reads what landed.
      await enrollment.deployment.execute({ account: 'ada' }, ['north'], {
        command: 'assign',
        commandVersion: 1,
        key: { id: 'n1' },
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
        input: { team: 'plumbing' },
      });
      const settled = await adaNorth.post('/api/record-decisions/settle', { id: northRow.id, action: 'done' });
      assert.equal(settled.status, 200, settled.text);
      assert.deepEqual(settled.body, { outcome: 'accepted' });
      const [accepted] = await own('north', 'n1');
      assert.deepEqual([accepted.outcome, accepted.outcomeBy], ['accepted', 'ada@example.test']);
      assert.deepEqual((await adaNorth.post('/api/record-decisions', { table: 'ticket', key: { id: 'n1' } })).body, {
        suggestions: [],
      });
      // South's waits as it was.
      assert.equal((await own('south', 's1'))[0].outcome, 'suggested');
    });
  });
