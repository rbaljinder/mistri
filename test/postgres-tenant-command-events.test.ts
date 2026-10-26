import { namedCommands } from './support/commandCatalog.js';
/**
 * Tenant command events on PostgreSQL, through the real enrolled host.
 *
 * The same terms as tenant-command-events.test.ts on SQLite, entered the way an
 * operator starts one: public `prepareTenantStartup` with the eventful
 * registry, then the dedicated host. Enrollment attests the preprovisioned
 * event store in its read snapshot and never creates one; a registry with
 * webhook effects is refused (a tenant host delivers none). Each batch is written by the tenant writer's journal inside
 * the transaction that holds the tenant/membership fence to COMMIT; the
 * control connection reads what PostgreSQL holds, not what the host says.
 *
 * Every test owns a fresh database named by a UUID beside TABLEWALK_TEST_PG
 * (the role needs CREATEDB) and drops it afterwards. Live and opt-in like the
 * other PostgreSQL suites; TABLEWALK_REQUIRE_LIVE=1 makes a missing server fail.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { postgresAuditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import type { EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import {
  openPostgresEventDeliveryStore,
  provisionPostgresEventDeliveryStore,
} from '../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';
import { runtimeName, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const appId = 'pg-tenant-events';
const password = 'Disposable-local-password-123!';
const binding = { appId, source: { id: 'business', connection: 'pg-events-business' }, storeId: 'pg-tenant-events-store' };
const eventSource = { appId, storeId: binding.storeId, sourceId: binding.source.id };
const manifest = [{ name: 'task.advanced', version: 1 }];
type Owner = Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
type Answer = { status: number; headers: Headers; body: Record<string, unknown>; text: string };
type Account = { accountId: string; cookie: string };
type Context = Record<string, string>;
type Row = Record<string, unknown>;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
type PgModule = { Client: new (c: unknown) => Control & { query: (...args: unknown[]) => Promise<unknown> } };
async function pgModule(): Promise<PgModule> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: PgModule } & Partial<PgModule>;
  return (pg.Client ? pg : pg.default) as PgModule;
}
async function client(url: string): Promise<Control> {
  const created = new (await pgModule()).Client({ connectionString: url, statement_timeout: 10_000 });
  await created.connect();
  return created;
}
async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
function object(value: unknown): Row {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
}
/** Nothing about the connection, the reserved tables or an event envelope leaves the host. */
function sealed(reply: Answer) {
  assert.doesNotMatch(reply.text, /postgres(ql)?:|pg_task|tenant_id|__mistri_|sessionId|payloadJson|envelopeVersion|"stack"|"cause"/i);
}
function refused(reply: Answer) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), reply.text);
  sealed(reply);
  for (const name of ['tenant', 'tab', 'context', 'lease-revision']) assert.equal(reply.headers.get(`x-mistri-${name}`), null);
  for (const key of ['result', 'receiptId']) assert.equal(key in reply.body, false, `refusal disclosed ${key}`);
}

const SETUP = [
  `CREATE TABLE public.pg_item (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     UNIQUE (tenant_id, business_id))`,
  `CREATE TABLE public.pg_task (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     version integer NOT NULL DEFAULT 0, UNIQUE (tenant_id, business_id))`,
  `INSERT INTO public.pg_task VALUES ('north-task', 'north', 'same', 'North task', 0), ('north-other', 'north', 'other', 'North other', 0),
     ('south-task', 'south', 'same', 'South task', 0)`,
];
const app = {
  id: appId,
  name: 'PostgreSQL tenant events fixture',
  auth: {
    providers: ['email'],
    signUp: 'open',
    store: './auth.db',
    rows: 'tenant',
    // Generic CRUD goes to `item` only: a command-owned resource refuses it.
    roles: { member: { read: true, write: ['item'], commands: ['advance', 'note'] } },
  },
  sources: { business: { connection: binding.source.connection } },
  resources: {
    item: {
      physical: 'public.pg_item',
      owner: 'tenant',
      access: 'write',
      fields: { read: ['id', 'business_id', 'name'], write: ['id', 'business_id', 'name'] },
    },
    task: {
      physical: 'public.pg_task',
      owner: 'tenant',
      access: 'write',
      fields: { read: ['id', 'business_id', 'name', 'version'], write: ['id', 'business_id', 'name', 'version'] },
      actions: {
        advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } },
        note: { label: 'Note', command: { id: 'note', version: 1, target: 'task', input: {} } },
      },
    },
  },
  views: { tasks: { kind: 'list', from: 'task' } },
  home: 'tasks',
  nav: ['tasks'],
};
const policyModule = `export default {
  kind: 'tenant', appId: ${JSON.stringify(appId)}, storeId: ${JSON.stringify(binding.storeId)},
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, task: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true, task: true }),
  resolveRows: () => ({ item: true, task: true }),
  authorizeDeletedRecord: () => true,
  resultReferences: { advance: result => [{ table: 'task', key: { id: result.taskId } }], note: result => [{ table: 'task', key: { id: result.taskId } }] },
};`;
/** The same two commands, with and without `advance` declaring its fact. */
const commandsModule = (events: boolean) => `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
${
  events
    ? `import { defineEvent, defineEventProjection } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessEvents.ts', import.meta.url).href)};
import { shape, text, int } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandShapes.ts', import.meta.url).href)};
const advanced = defineEvent('task.advanced', shape({ taskId: text(), version: int() }));`
    : ''
}
const output = { parse(value) { if (!value || typeof value.taskId !== 'string' || !Number.isSafeInteger(value.version)) throw new Error('Bad output'); return { taskId: value.taskId, version: value.version }; } };
export default defineCommands({
  advance: defineCommand({ source: 'business', target: 'task', input: {}, output,
    ${events ? 'events: { advanced: defineEventProjection(advanced, value => ({ taskId: value.taskId, version: value.version })) },' : ''}
    async handle({ db, record }) {
      const { version } = await db.task.update(record, { version: record.version + 1 });
      return { taskId: String(record.id), version };
    } }),
  note: defineCommand({ source: 'business', target: 'task', input: {}, output,
    async handle({ db, record }) {
      const { version } = await db.task.update(record, { name: 'Noted', version: record.version + 1 });
      return { taskId: String(record.id), version };
    } }),
});`;

/** One snapshot of every business row and its receipt/audit/event companions. */
async function evidence(control: Control) {
  await control.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const read = async (sql: string) => (await control.query(postgresRuntimeSql(sql))).rows.map((row) => ({ ...row }) as Row);
    return {
      tasks: await read('SELECT id, tenant_id, name, version FROM public.pg_task ORDER BY id'),
      // completed_at is a timestamptz here; the envelope carries the same instant as ISO UTC text.
      receipts: await read(
        `SELECT *, to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_iso FROM ${runtimeTable('postgres', journal.receipt)} ORDER BY id`,
      ),
      audits: await read(`SELECT * FROM ${postgresAuditRows} a ORDER BY receipt_id, ordinal`),
      meta: await read(`SELECT * FROM ${runtimeTable('postgres', eventTables.meta)}`),
      batches: await read(
        `SELECT id AS receipt_id, manifest_json, event_count, digest FROM ${runtimeTable('postgres', journal.receipt)} WHERE manifest_json IS NOT NULL ORDER BY id`,
      ),
      events: await read(
        `SELECT event_id, receipt_id, ordinal, envelope_json FROM ${runtimeTable('postgres', eventTables.event)} ORDER BY event_id`,
      ),
    };
  } finally {
    await control.query('ROLLBACK');
  }
}
type Evidence = Awaited<ReturnType<typeof evidence>>;
const byKey = (key: string) => (a: Row, b: Row) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0);

describe('tenant command events on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  async function fixture(t: TestContext, store: 'provisioned' | 'missing' | 'foreign' = 'provisioned', delivery?: EventDeliveryPolicy) {
    const { url, drop } = await uuidPostgresDatabase('tablewalk_events');
    const control = await client(url);
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-postgres-tenant-events-'));
    let owner: Owner | undefined, auth: AppAuthRuntime | undefined;
    t.after(async () => {
      try {
        if (owner) {
          owner.server.closeAllConnections();
          await owner.retire();
        }
      } finally {
        auth?.close();
        await control.end().catch(() => {});
        await drop();
        rmSync(directory, { recursive: true, force: true });
      }
    });
    const administer = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
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
    };
    for (const statement of SETUP) await control.query(statement);
    await migratePostgresTenantStore(url, binding);
    await migratePostgresCommandJournal(url);
    if (store === 'provisioned') await provisionPostgresCommandEventStore(url, eventSource);
    if (store === 'foreign') await provisionPostgresCommandEventStore(url, { ...eventSource, storeId: 'another-tenant-store' });
    // Before the host starts: DDL after startup retires the tenant sources.
    if (delivery) await provisionPostgresEventDeliveryStore(url, delivery);
    await administer(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    });

    const appPath = join(directory, 'app.json'),
      policyFile = join(directory, 'policy.mjs'),
      commandsFile = join(directory, 'commands.mjs');
    writeFileSync(appPath, JSON.stringify(namedCommands(app).app));
    writeFileSync(policyFile, policyModule);
    writeFileSync(commandsFile, commandsModule(true));
    const loaded = await loadApp(appPath);
    const connection: ConnectionConfig = {
      id: binding.source.connection,
      name: binding.source.connection,
      url,
      source: 'config',
      writable: true,
    };
    // Public startup, as an operator runs it: it attests the event store and never creates one.
    const prepare = () => prepareTenantStartup({ loaded, connections: [connection], policyFile, commandsFile });

    const port = await reservePort(),
      origin = `http://127.0.0.1:${port}`;
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'synthetic-postgres-tenant-events-secret-at-least-thirty-two-characters';
    try {
      auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous;
    }
    const start = async () =>
      createTenantAuthenticatedHttpServer({
        loaded,
        auth: auth!,
        enrollment: (await prepare()).enrollment,
        bound: { host: '127.0.0.1', port },
      });
    if (store !== 'provisioned') return { control, url, start, host: undefined };
    owner = await start();
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');

    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, body: text ? object(JSON.parse(text)) : {} };
    };
    const signup = async (name: string): Promise<Account> => {
      const answer = await call('/api/auth/sign-up/email', { name, email: `${name.toLowerCase()}@example.test`, password });
      assert.equal(answer.status, 200, answer.text);
      return {
        accountId: String(object(answer.body.user).id),
        cookie: answer.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      };
    };
    const membership = (account: Account, tenantId: string, status: 'active' | 'revoked', expectedVersion: string | null) =>
      administer((admin) =>
        admin.putMembership({
          tenantId,
          accountId: account.accountId,
          membershipId: `${tenantId}-${account.accountId}`,
          status,
          roles: ['member'],
          validUntil: Date.now() + 120_000,
          expectedVersion,
        }),
      );
    const signedIn = (account: Account) => ({ cookie: account.cookie, 'x-mistri-account': account.accountId });
    const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
    const open = async (account: Account, tenant: string): Promise<Context> => {
      const reply = await call(select('/api/tenant/context/open', tenant), {}, signedIn(account));
      assert.equal(reply.status, 200, reply.text);
      sealed(reply);
      return {
        ...signedIn(account),
        tenant,
        'x-mistri-tab': String(reply.body.tabId),
        'x-mistri-context': String(reply.body.context),
        'x-mistri-lease-revision': String(reply.body.revision),
      };
    };
    const data = async (path: string, context: Context, body?: unknown) => {
      const { tenant, ...headers } = context;
      const reply = await call(select(path, tenant), body, headers);
      sealed(reply);
      return reply;
    };
    const command = (task: string, idempotencyKey: string, expectedVersion = 0, id = 'advance') => ({
      command: id,
      commandVersion: 1,
      key: { id: task },
      expectedVersion,
      idempotencyKey,
      input: {},
    });
    /** The exact whole-database delta of one applied `advance`, and its batch. */
    const committed = async (before: Evidence, reply: Answer, tenant: string, task: string, account: Account) => {
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.body.status, 'applied');
      const after = await evidence(control),
        result = object(reply.body.result);
      const version = Number(before.tasks.find((row) => row.id === task)!.version) + 1;
      assert.deepEqual(result, { taskId: task, version });
      const receipt = after.receipts.find((row) => row.id === reply.body.receiptId);
      assert.ok(receipt);
      assert.deepEqual(
        [
          receipt.app_id,
          receipt.store_id,
          receipt.source_id,
          receipt.realm,
          receipt.tenant_id,
          receipt.actor_id,
          receipt.command_id,
          receipt.command_version,
        ],
        [appId, binding.storeId, binding.source.id, 'tenant', tenant, account.accountId, 'advance', 1],
      );
      const audit = after.audits.find((row) => row.receipt_id === receipt.id);
      assert.ok(audit);
      assert.deepEqual(
        [audit.realm, audit.tenant_id, audit.owner_tenant_id, audit.membership_id, audit.target],
        ['tenant', tenant, tenant, `${tenant}-${account.accountId}`, 'task'],
      );
      const batch = after.batches.find((row) => row.receipt_id === receipt.id);
      assert.ok(batch);
      const event = after.events.find((row) => row.receipt_id === receipt.id);
      assert.ok(event);
      assert.deepEqual(after.meta, [{ version: 1, app_id: appId, store_id: binding.storeId, source_id: binding.source.id }]);
      assert.deepEqual(JSON.parse(String(batch.manifest_json)), manifest);
      assert.equal(batch.event_count, 1);
      assert.equal(event.ordinal, 0);
      const envelope = object(JSON.parse(String(event.envelope_json)));
      assert.deepEqual(envelope, {
        envelopeVersion: 2,
        eventId: event.event_id,
        ordinal: 0,
        ...manifest[0],
        appId,
        storeId: binding.storeId,
        sourceId: binding.source.id,
        scope: 'tenant',
        tenantId: tenant,
        actorId: account.accountId,
        commandId: 'advance',
        commandVersion: 1,
        resource: 'task',
        key: { id: task },
        receiptId: receipt.id,
        requestId: receipt.request_id,
        occurredAt: receipt.completed_iso,
        correlationId: receipt.request_id,
        causation: { kind: 'command', receiptId: receipt.id },
        payloadJson: envelope.payloadJson,
      });
      assert.deepEqual(JSON.parse(String(envelope.payloadJson)), { taskId: task, version });
      assert.equal(
        batch.digest,
        createHash('sha256')
          .update(canonicalCommandJson({ manifest, events: [envelope] }, 1048576))
          .digest('hex'),
      );
      // Extra rows, a repeated handler, a cross-tenant write or a fragment committed alone all fail here.
      assert.deepEqual(after, {
        ...before,
        tasks: before.tasks.map((row) => (row.id === task ? { ...row, version } : row)),
        receipts: [...before.receipts, receipt].sort(byKey('id')),
        audits: [...before.audits, audit].sort(byKey('receipt_id')),
        batches: [...before.batches, batch].sort(byKey('receipt_id')),
        events: [...before.events, event].sort(byKey('event_id')),
      });
      return { after, receipt, event: envelope };
    };
    return { control, url, start, host: owner, signup, membership, open, data, call, select, signedIn, command, committed };
  }
  type Host = Extract<Awaited<ReturnType<typeof fixture>>, { signup: unknown }>;
  const host = async (t: TestContext, delivery?: EventDeliveryPolicy) => (await fixture(t, 'provisioned', delivery)) as Host;

  for (const store of ['missing', 'foreign'] as const) {
    test(`a ${store} event store refuses the private host's startup without provisioning or changing anything`, async (t) => {
      const f = await fixture(t, store);
      const before = (
        await f.control.query(`SELECT c.relname, (SELECT count(*)::int FROM public.pg_task WHERE version <> 0) AS moved
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mistri' AND c.relname LIKE 'event\\_%' AND c.relkind = 'r' ORDER BY c.relname`)
      ).rows;
      await assert.rejects(f.start(), 'the host attests the event store; it never creates or repairs one');
      const after = (
        await f.control.query(`SELECT c.relname, (SELECT count(*)::int FROM public.pg_task WHERE version <> 0) AS moved
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mistri' AND c.relname LIKE 'event\\_%' AND c.relkind = 'r' ORDER BY c.relname`)
      ).rows;
      assert.deepEqual(after, before);
      assert.equal(after.length, store === 'missing' ? 0 : 2);
      assert.equal(
        Number((await f.control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', journal.receipt)}`)).rows[0].n),
        0,
      );
      if (store === 'foreign') {
        assert.deepEqual((await f.control.query(`SELECT store_id FROM ${runtimeTable('postgres', eventTables.meta)}`)).rows, [
          { store_id: 'another-tenant-store' },
        ]);
      }
    });
  }

  test('an eventful command commits the task, receipt, audit and its tenant batch together; replay and status keep every ID', async (t) => {
    const f = await host(t),
      ada = await f.signup('Ada');
    await f.membership(ada, 'north', 'active', null);
    const first = await f.open(ada, 'north'),
      second = await f.open(ada, 'north');
    const input = f.command('north-task', 'pg-event-attempt-0001'),
      before = await evidence(f.control);
    const replies = await Promise.all([f.data('/api/commands/execute', first, input), f.data('/api/commands/execute', second, input)]);
    assert.deepEqual(replies.map((reply) => reply.body.replayed).sort(), [false, true]);
    assert.equal(replies[0].body.receiptId, replies[1].body.receiptId);
    const applied = replies.find((reply) => reply.body.replayed === false)!;
    const { after } = await f.committed(before, applied, 'north', 'north-task', ada);
    for (const path of ['/api/commands/execute', '/api/commands/status']) {
      const replay = await f.data(path, second, input);
      assert.deepEqual(replay.body, { ...applied.body, replayed: true });
      assert.deepEqual(await evidence(f.control), after, 'a replay never regenerates or adds a batch');
    }
  });

  test('one idempotency key in two tenants writes two tenant batches, and neither tenant reaches the other receipt', async (t) => {
    const f = await host(t),
      cy = await f.signup('Cy');
    await f.membership(cy, 'north', 'active', null);
    await f.membership(cy, 'south', 'active', null);
    const north = await f.open(cy, 'north'),
      south = await f.open(cy, 'south'),
      key = 'pg-event-shared-key';
    const start = await evidence(f.control);
    const northReply = await f.data('/api/commands/execute', north, f.command('north-task', key));
    const saved = await f.committed(start, northReply, 'north', 'north-task', cy);
    // The north target from the south context: a foreign record, never north's receipt.
    for (const path of ['/api/commands/status', '/api/commands/execute']) {
      const crossed = await f.data(path, south, f.command('north-task', key));
      assert.ok(crossed.status >= 400 || crossed.body.status !== 'applied', crossed.text);
      assert.notEqual(crossed.body.receiptId, northReply.body.receiptId);
      assert.deepEqual(await evidence(f.control), saved.after);
    }
    const southReply = await f.data('/api/commands/execute', south, f.command('south-task', key));
    const both = await f.committed(saved.after, southReply, 'south', 'south-task', cy);
    assert.notEqual(southReply.body.receiptId, northReply.body.receiptId);
    assert.deepEqual(both.after.events.map((row) => object(JSON.parse(String(row.envelope_json))).tenantId).sort(), ['north', 'south']);
  });

  test('membership revocation refuses prepared execution and recovery, writes nothing, and the other tenant still commits', async (t) => {
    const f = await host(t),
      bo = await f.signup('Bo');
    await f.membership(bo, 'north', 'active', null);
    await f.membership(bo, 'south', 'active', null);
    const north = await f.open(bo, 'north'),
      south = await f.open(bo, 'south');
    const input = f.command('north-task', 'pg-event-before-revocation');
    assert.equal((await f.data('/api/commands/execute', north, input)).body.status, 'applied');
    const pending = f.command('north-other', 'pg-event-prepared-before-revocation');
    const prepared = await f.data('/api/commands/prepare', north, { command: pending.command, commandVersion: 1, key: pending.key });
    assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepared.body.expectedVersion, 0);
    await f.membership(bo, 'north', 'revoked', '1');
    const before = await evidence(f.control);
    refused(await f.data('/api/commands/execute', north, pending));
    for (const path of ['/api/commands/execute', '/api/commands/status']) refused(await f.data(path, north, input));
    refused(await f.call(f.select('/api/tenant/context/open', 'north'), {}, f.signedIn(bo)));
    assert.deepEqual(await evidence(f.control), before);
    await f.committed(
      before,
      await f.data('/api/commands/execute', south, f.command('south-task', 'pg-event-south-after')),
      'south',
      'south-task',
      bo,
    );
  });

  test('a failed event insertion rolls back the task, receipt, audit and batch; the exact retry commits once', async (t) => {
    const f = await host(t),
      di = await f.signup('Di');
    await f.membership(di, 'north', 'active', null);
    const context = await f.open(di, 'north'),
      input = f.command('north-task', 'pg-event-insert-failure'),
      before = await evidence(f.control);
    const { Client } = await pgModule();
    const original = Client.prototype.query;
    // What the writer handed the driver, in order, up to the event insertion, which the server refuses.
    let staged: string[] | undefined;
    const handed: string[] = [];
    const fault = t.mock.method(Client.prototype, 'query', function (this: Control, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: unknown } | undefined)?.text ?? '');
      handed.push(text);
      if (!staged && text.startsWith(`INSERT INTO ${runtimeTable('postgres', eventTables.event)}`)) {
        staged = [...handed];
        return original.call(this, 'SELECT 1 / 0 AS disposable_event_insertion_failure');
      }
      return original.apply(this, args);
    });
    const failed = await f.data('/api/commands/execute', context, input);
    fault.mock.restore();
    assert.ok(staged, 'the event insertion was asked');
    const at = (pattern: RegExp) => staged!.findIndex((text) => pattern.test(text));
    const write = at(/^\s*UPDATE\b[\s\S]*pg_task/);
    assert.ok(write >= 0, 'after the business write');
    assert.ok(
      at(new RegExp(`INSERT INTO mistri\\."${runtimeName('postgres', journal.receipt)}"`)) > write,
      'and the receipt, with its audit and batch',
    );
    refused(failed);
    assert.equal(failed.body.outcome, 'not_applied');
    assert.deepEqual(await evidence(f.control), before);
    const missing = await f.data('/api/commands/status', context, input);
    assert.equal(missing.body.status, 'not_found');
    assert.equal('receiptId' in missing.body, false);
    const retried = await f.data('/api/commands/execute', context, input);
    assert.equal(retried.body.replayed, false);
    await f.committed(before, retried, 'north', 'north-task', di);
  });

  test('a command without events commits no batch in the eventful host', async (t) => {
    const f = await host(t),
      ed = await f.signup('Ed');
    await f.membership(ed, 'north', 'active', null);
    const context = await f.open(ed, 'north'),
      before = await evidence(f.control);
    const input = f.command('north-task', 'pg-event-plain-note', 0, 'note');
    const reply = await f.data('/api/commands/execute', context, input);
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body.status, 'applied');
    const after = await evidence(f.control);
    assert.equal(after.receipts.length, 1);
    assert.equal(after.audits.length, 1);
    assert.deepEqual(after.batches, before.batches);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual((await f.data('/api/commands/status', context, input)).body, { ...reply.body, replayed: true });
  });

  test('PostgreSQL delivery schedules only its named tenant batch, verified against the committed receipt', async (t) => {
    const policy: EventDeliveryPolicy = {
      source: eventSource,
      serviceId: 'pg-tenant-events-publisher',
      destinationId: 'north-advanced-v1',
      routes: [{ scope: 'tenant', tenantId: 'north', commandId: 'advance', commandVersion: 1, manifest }],
      limits: { maxAttempts: 3, leaseMs: 1_000, timeoutMs: 20, backoffMs: 10, maxBackoffMs: 20, maxRetained: 64, scanBatch: 8 },
    };
    const f = await host(t, policy),
      fay = await f.signup('Fay');
    await f.membership(fay, 'north', 'active', null);
    await f.membership(fay, 'south', 'active', null);
    const start = await evidence(f.control);
    const north = await f.committed(
      start,
      await f.data('/api/commands/execute', await f.open(fay, 'north'), f.command('north-task', 'pg-event-delivery-north')),
      'north',
      'north-task',
      fay,
    );
    await f.committed(
      north.after,
      await f.data('/api/commands/execute', await f.open(fay, 'south'), f.command('south-task', 'pg-event-delivery-south')),
      'south',
      'south-task',
      fay,
    );
    const manager = new PgConnectionManager(f.url);
    t.after(() => manager.close());
    const store = await openPostgresEventDeliveryStore(manager, policy, { clock: 'caller' });
    t.after(() => store.close());
    const discovered = await store.discover();
    assert.equal(discovered.scheduled, 1, "the south batch is not this destination's");
    const now = Date.now(),
      claim = await store.claim(now);
    assert.ok(claim);
    assert.deepEqual(claim.envelope, north.event, 'the delivered fact is exactly the committed north envelope');
    assert.equal(await store.claim(now), undefined);
    assert.equal(await store.complete(claim, 'accepted', 'accepted', now), true);
    assert.deepEqual(
      (await store.inspect('delivered')).map((row) => row.eventId),
      [claim.eventId],
    );
  });
});
