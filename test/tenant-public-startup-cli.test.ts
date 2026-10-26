/**
 * Tenant invitations and tenant command events through the real public CLI:
 * `mistri --config … --app … --policy … --commands …`, on SQLite and on
 * PostgreSQL. Every reserved store is provisioned only through the public
 * maintenance entry (`@mistriwork/mistri/maintenance`); the
 * server provisions nothing. Over HTTP an operator the policy names issues an
 * invitation, the exact native recipient previews and accepts it, and the new
 * member runs an event-emitting command; the database is read afterwards on a
 * separate control connection. The PostgreSQL engine uses a database this
 * file owns, named by a UUID, dropped afterwards; it runs when
 * TABLEWALK_TEST_PG names a server (TABLEWALK_REQUIRE_LIVE=1 makes that required).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import * as maintenance from '../packages/mistri/src/server/maintenance.js';
import { INVITATION_TABLES } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { createSqliteTenantAdministration, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { createPostgresTenantAdministration } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { INVITATION_HTTP_HEADER, INVITATION_ISSUER_OPERATIONS } from '../packages/mistri/src/shared/tenantInvitations.js';
import { liveSkip } from './live.js';
import { scratch } from './support/scratch.js';
import { pgClient, uuidPostgresDatabase, type Control } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const entry = resolve('packages/mistri/src/server/index.ts');
const appId = 'tenant-public',
  secret = 'synthetic-tenant-public-cli-secret-at-least-thirty-two-characters';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'public-store' };
const password = 'Disposable-public-tenant-password-123!';
type Row = Record<string, unknown>;
type Account = { id: string; email: string; cookie: string };
type Reply = { status: number; body: Row; text: string };
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

/** The engine's control: the tables, the tenant rows and what a test reads back. */
interface Engine {
  url: string;
  /** A resource's physical name: PostgreSQL's schema-qualified, as its guide shows. */
  table(name: string): string;
  query(sql: string): Promise<Row[]>;
  administer(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
const TABLES = [
  'CREATE TABLE item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL)',
  'CREATE TABLE task (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)',
  "INSERT INTO item VALUES ('north-item', 'north', 'North item'), ('south-item', 'south', 'South item')",
  "INSERT INTO task VALUES ('north-task', 'north', 'North task', 0), ('south-task', 'south', 'South task', 0)",
];
async function sqliteEngine(directory: string): Promise<Engine> {
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  try {
    for (const statement of TABLES) db.exec(statement);
  } finally {
    db.close();
  }
  // Public maintenance only, in the documented order.
  await maintenance.provisionStores(
    { sqlite: path },
    { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration', 'tenant-invitations'] },
  );
  maintenance.migrateSqliteCommandJournal(path);
  await maintenance.provisionStores({ sqlite: path }, { app: { tenant: binding } });
  return {
    url: path,
    table: (name) => name,
    query: async (sql) => {
      const read = new DatabaseSync(path, { readOnly: true });
      try {
        return read.prepare(sql).all() as Row[];
      } finally {
        read.close();
      }
    },
    administer: async (run) => {
      const write = new DatabaseSync(path),
        operations = new TransactionOperations();
      write.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(write, operations, binding));
        await operations.finish();
        write.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        write.exec('ROLLBACK');
        throw error;
      } finally {
        write.close();
      }
    },
    close: async () => {},
  };
}
async function postgresEngine(t: TestContext): Promise<Engine> {
  const { url, drop } = await uuidPostgresDatabase('tablewalk_public');
  const control: Control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  for (const statement of TABLES) await control.query(statement.replace('INTEGER', 'integer'));
  await maintenance.migratePostgresTenantStore(url, binding);
  await maintenance.migratePostgresTenantAdministrationJournal(url, binding);
  await maintenance.migratePostgresTenantInvitations(url, binding);
  await maintenance.migratePostgresCommandJournal(url);
  await maintenance.provisionStores({ postgres: url }, { app: { tenant: binding } });
  return {
    url,
    table: (name) => `public.${name}`,
    query: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows as Row[],
    administer: async (run) => {
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
    close: async () => {},
  };
}

const commandsModule = `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
import { defineEvent, defineEventProjection } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessEvents.ts', import.meta.url).href)};
import { shape, text, int } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandShapes.ts', import.meta.url).href)};
const advanced = defineEvent('task.advanced', shape({ taskId: text(), version: int() }));
export default defineCommands({ advance: defineCommand({ source: 'business', target: 'task', input: {},
  output: { parse(value) { if (!value || typeof value.taskId !== 'string' || !Number.isSafeInteger(value.version)) throw new Error('Bad output'); return value; } },
  events: { advanced: defineEventProjection(advanced, value => ({ taskId: value.taskId, version: value.version })) },
  async handle({ db, record }) {
    const { version } = await db.task.update(record, { version: record.version + 1 });
    return { taskId: String(record.id), version };
  } }) });`;

/** The operator's files, native accounts made before the policy names one, and a launch. */
async function deployment(
  stopping: (stop: () => unknown) => void,
  engine: Engine,
  directory: string,
  authStore = join(directory, 'auth.db'),
) {
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const app = {
    id: appId,
    name: 'Tenant public CLI',
    auth: { store: authStore, signUp: 'open', rows: 'tenant', roles: { member: { read: true, write: ['item'], commands: ['advance'] } } },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      item: { physical: engine.table('item'), owner: 'tenant', access: 'write', fields: { read: ['id', 'name'], write: ['id', 'name'] } },
      task: {
        physical: engine.table('task'),
        owner: 'tenant',
        access: 'write',
        fields: { read: ['id', 'name', 'version'], write: ['id', 'name', 'version'] },
        actions: { advance: { label: 'Advance', command: 'advance' } },
      },
    },
    views: { items: { kind: 'list', from: 'item' }, tasks: { kind: 'list', from: 'task' } },
    home: 'items',
    nav: ['items', 'tasks'],
  };
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(app));
  const config = join(directory, 'config.json'),
    policy = join(directory, 'policy.mjs'),
    commandsFile = join(appDir, 'commands.mjs');
  writeFileSync(config, JSON.stringify({ connections: [{ name: binding.source.connection, url: engine.url, writable: true }] }));
  writeFileSync(commandsFile, commandsModule);
  await engine.administer(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });

  // Accounts exist before the policy names one, as in a real deployment.
  const bootstrapPort = await port(),
    bootstrapOrigin = `http://127.0.0.1:${bootstrapPort}`;
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = secret;
  let auth: Awaited<ReturnType<typeof createAppAuth>>;
  try {
    auth = await createAppAuth(await loadApp(appDir), { baseURL: bootstrapOrigin, trustedOrigins: [bootstrapOrigin] });
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous;
  }
  const bootstrap = createHttpServer((req, res) => {
    void auth.handler(req, res).catch(() => res.destroy());
  });
  bootstrap.listen(bootstrapPort, '127.0.0.1');
  await once(bootstrap, 'listening');
  const ids: Record<string, string> = {};
  try {
    for (const name of ['operator', 'member', 'outsider']) {
      const response = await fetch(`${bootstrapOrigin}/api/auth/sign-up/email`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { origin: bootstrapOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ name, email: `${name}@example.test`, password }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      ids[name] = String(object(object(await response.json()).user).id);
    }
  } finally {
    bootstrap.closeAllConnections();
    await new Promise<void>((done) => bootstrap.close(() => done()));
    auth.close();
  }
  writeFileSync(
    policy,
    `export default { kind: 'tenant', appId: ${JSON.stringify(appId)}, storeId: ${JSON.stringify(binding.storeId)},
    ownership: { item: { kind: 'tenant', column: 'tenant_id' }, task: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => ({ item: true, task: true }), resolveRows: () => ({ item: true, task: true }),
    authorizeDeletedRecord: () => true,
    resultReferences: { advance: result => [{ table: 'task', key: { id: result.taskId } }] },
    invitations: { id: 'public-inviters', version: '1', maxMembershipLifetimeMs: 3600000, maxRedemptionLifetimeMs: 1800000,
      maxPendingPerTenant: 10, operators: [{ accountId: ${JSON.stringify(ids.operator)}, tenants: ['north'],
        operations: ${JSON.stringify(INVITATION_ISSUER_OPERATIONS)}, roles: ['member'] }] } };`,
  );
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: secret,
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const args = ['--import', 'tsx', entry, '--config', config, '--app', appDir, '--policy', policy, '--commands', commandsFile];

  const launch = async () => {
    const number = await port(),
      origin = `http://127.0.0.1:${number}`;
    const child = spawn(process.execPath, [...args, '--port', String(number)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const ended = once(child, 'exit');
    stopping(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await ended;
    });
    for (let tries = 0; tries < 400; tries++) {
      if (output.includes('Listening on')) return { child, origin, ended, output: () => output };
      if (child.exitCode !== null || child.signalCode !== null) return { child, origin, ended, output: () => output, failed: true };
      await delay(50);
    }
    child.kill('SIGKILL');
    throw new Error(`Tenant CLI never listened: ${output}`);
  };
  return { ids, launch };
}

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(
    `public --policy startup on ${dialect}: an invitation makes a member whose command records its tenant event`,
    { timeout: 120_000, skip: dialect === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async (t) => {
      const { directory, stopping } = scratch(t, 'tablewalk-tenant-public-cli-');
      const engine = dialect === 'sqlite' ? await sqliteEngine(directory) : await postgresEngine(t);
      const { ids, launch } = await deployment(stopping, engine, directory);
      const live = await launch();
      assert.equal('failed' in live, false, live.output());
      const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
        const response = await fetch(live.origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { origin: live.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        assert.doesNotMatch(text, /__mistri_|tenant_id|postgres(ql)?:|business\.db|digest|payloadJson/);
        return { status: response.status, text, body: text ? object(JSON.parse(text)) : {} };
      };
      const signIn = async (name: string): Promise<Account> => {
        const response = await fetch(`${live.origin}/api/auth/sign-in/email`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { origin: live.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: `${name}@example.test`, password }),
        });
        assert.equal(response.status, 200);
        return {
          id: ids[name],
          email: `${name}@example.test`,
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; '),
        };
      };
      const operator = await signIn('operator'),
        member = await signIn('member'),
        outsider = await signIn('outsider');
      const identity = (account: Account) => ({ cookie: account.cookie, 'x-mistri-account': account.id, 'x-mistri-app': appId });
      const path = (operation: string) => `/api/tenant/invitations/${operation}?app=${appId}`;

      // Discovery says invitations are on; a signed-in account is not an issuer.
      assert.equal(object((await call(path('open-issuer'), {}, identity(outsider))).body).session ?? null, null);
      const opened = await call(path('open-issuer'), {}, identity(operator));
      assert.equal(opened.status, 200, opened.text);
      const issuer = { ...identity(operator), [INVITATION_HTTP_HEADER]: String(object(opened.body.session).context) };
      const intent = {
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: member.id,
        roles: ['member'],
        redeemUntil: Date.now() + 600_000,
        validUntil: Date.now() + 1_200_000,
      };
      assert.ok(
        (await call(path('execute'), { idempotencyKey: 'public-over-ceiling', intent: { ...intent, tenantId: 'south' } }, issuer)).status >=
          400,
      );
      const issued = await call(path('execute'), { idempotencyKey: 'public-issue-1', intent }, issuer);
      assert.equal(issued.status, 200, issued.text);
      assert.equal(typeof issued.body.token, 'string');
      const token = String(issued.body.token),
        invitationId = invitationTokenId(token);
      // A pending invitation grants nothing, and possession of the token is not the recipient's account.
      assert.ok((await call(`/api/tenant/context/open?app=${appId}&tenant=north`, {}, identity(member))).status >= 400);
      const wrong = await call(path('open-recipient'), { invitationId }, identity(outsider));
      const wrongContext = { ...identity(outsider), [INVITATION_HTTP_HEADER]: String(object(wrong.body.session ?? {}).context ?? '') };
      assert.ok((await call(path('preview'), { token }, wrongContext)).status >= 400);
      const recipientOpened = await call(path('open-recipient'), { invitationId }, identity(member));
      assert.equal(recipientOpened.status, 200, recipientOpened.text);
      const recipient = { ...identity(member), [INVITATION_HTTP_HEADER]: String(object(recipientOpened.body.session).context) };
      const preview = await call(path('preview'), { token }, recipient);
      assert.equal(preview.status, 200, preview.text);
      const acceptance = { idempotencyKey: 'public-accept-1', intent: object(preview.body.preview).intent };
      const accepted = await call(path('execute'), { ...acceptance, token }, recipient);
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(object(accepted.body.result).status, 'accepted');
      const status = await call(path('status'), acceptance, recipient);
      assert.equal(status.body.status, 'completed');
      assert.equal(Object.hasOwn(status.body, 'token'), false);

      // The accepted membership, and only its tenant, admits the member.
      assert.ok((await call(`/api/tenant/context/open?app=${appId}&tenant=south`, {}, identity(member))).status >= 400);
      const context = await call(`/api/tenant/context/open?app=${appId}&tenant=north`, {}, identity(member));
      assert.equal(context.status, 200, context.text);
      const selected = {
        cookie: member.cookie,
        'x-mistri-account': member.id,
        'x-mistri-tab': String(context.body.tabId),
        'x-mistri-context': String(context.body.context),
        'x-mistri-lease-revision': String(context.body.revision),
      };
      const rows = await call(`/api/query?app=${appId}&tenant=north`, { table: 'item' }, selected);
      assert.equal(rows.status, 200, rows.text);
      assert.match(rows.text, /North item/);
      assert.doesNotMatch(rows.text, /South item/);
      const input = {
        command: 'advance',
        commandVersion: 1,
        key: { id: 'north-task' },
        expectedVersion: 0,
        idempotencyKey: 'public-advance-1',
        input: {},
      };
      const executed = await call(`/api/commands/execute?app=${appId}&tenant=north`, input, selected);
      assert.equal(executed.status, 200, executed.text);
      assert.equal(executed.body.status, 'applied');
      const replay = await call(`/api/commands/status?app=${appId}&tenant=north`, input, selected);
      assert.equal(replay.body.receiptId, executed.body.receiptId);
      assert.equal(replay.body.replayed, true);

      // What the database holds: one accepted pair, one receipt, one tenant batch naming the member.
      assert.deepEqual(
        (await engine.query(`SELECT status FROM "${INVITATION_TABLES.invitation}"`)).map((row) => row.status),
        ['accepted'],
      );
      const receipts = await engine.query(`SELECT id, tenant_id, actor_id FROM "${journal.receipt}"`);
      assert.deepEqual(
        receipts.map((row) => [row.id, row.tenant_id, row.actor_id]),
        [[executed.body.receiptId, 'north', member.id]],
      );
      const events = await engine.query(`SELECT receipt_id, envelope_json FROM "${eventTables.event}"`);
      assert.equal(events.length, 1);
      assert.equal(events[0].receipt_id, executed.body.receiptId);
      const envelope = object(JSON.parse(String(events[0].envelope_json)));
      assert.deepEqual(
        [envelope.scope, envelope.tenantId, envelope.actorId, envelope.storeId, envelope.name],
        ['tenant', 'north', member.id, binding.storeId, 'task.advanced'],
      );
      assert.deepEqual(JSON.parse(String(envelope.payloadJson)), { taskId: 'north-task', version: 1 });
      assert.deepEqual(
        (await engine.query("SELECT version FROM task WHERE id = 'south-task'")).map((row) => Number(row.version)),
        [0],
      );

      live.child.kill('SIGTERM');
      const [code] = await live.ended;
      assert.equal(code, 0, live.output());
      await engine.close();
    },
  );
}

test(
  'public --policy startup refuses invitations on a SQLite source whose auth store is postgres://, naming why',
  { timeout: 60_000, skip: liveSkip('postgres', LIVE) },
  async (t) => {
    const { directory, stopping } = scratch(t, 'tablewalk-tenant-public-cli-');
    const { url: authUrl, drop } = await uuidPostgresDatabase('tablewalk_public_auth');
    t.after(drop);
    await migratePostgresAuthStore(authUrl);
    const engine = await sqliteEngine(directory);
    const { launch } = await deployment(stopping, engine, directory, authUrl);
    const live = await launch();
    assert.equal('failed' in live, true, 'the CLI must refuse, not listen');
    const [code] = await live.ended;
    assert.equal(code, 1);
    assert.match(live.output(), /invitations on a SQLite source with a file-based authentication store/);
    assert.doesNotMatch(live.output(), /postgres(ql)?:\/\//);
    assert.equal(Number((await engine.query(`SELECT count(*) AS n FROM "${journal.receipt}"`))[0].n), 0);
  },
);
