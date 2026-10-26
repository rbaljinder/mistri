import { namedCommands, parseTestApp } from './support/commandCatalog.js';
/**
 * A hostile two-tenant HTTP proof of a tenant App on PostgreSQL, entered the
 * way an operator starts one: `prepareTenantStartup` with a server-only policy
 * and command registry over a PostgreSQL connection, real native auth (a
 * SQLite file store), and the dedicated authenticated tenant host.
 *
 * Two tenants hold rows with equal business IDs. The proof guesses another
 * tenant's opaque IDs through the data routes, forges the ownership column on
 * insert and update, replays a command idempotency key across tenants, reuses
 * another account's context headers, and revokes a membership mid-session,
 * and reads the database on a separate control connection before and after,
 * so what is asserted is what PostgreSQL holds, not what the host says.
 *
 * Live and opt-in like postgres.test.ts: TABLEWALK_TEST_PG names a disposable
 * server, and TABLEWALK_REQUIRE_LIVE=1 makes a missing one a failure. A tenant
 * App's database holds only its declared resources, so this file works in a
 * database of its own beside TABLEWALK_TEST_PG (created once; the role needs
 * CREATEDB) and resets every `__mistri_*` table and its fixtures there.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { postgresAuditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { ADMINISTRATION_JOURNAL_TABLES as adminJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { ADMINISTRATION_HTTP_HEADER } from '../packages/mistri/src/shared/tenantAdministration.js';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { Registry, type ConnectionConfig } from '../packages/engine/src/server/connections.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup, TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { TENANT_TABLES, type MembershipChange, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { tenantInbox } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { dedicatedPostgresUrl } from './support/tenantDialects.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const appId = 'pg-tenant-http';
const password = 'Disposable-local-password-123!';
const binding = { appId, source: { id: 'business', connection: 'pg-business' }, storeId: 'pg-tenant-http-store' };
type Owner = Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
type Answer = { status: number; headers: Headers; body: Record<string, unknown>; text: string };
type Account = { accountId: string; cookie: string; email: string };
type Context = Record<string, string>;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(url: string): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: url, statement_timeout: 10_000 });
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
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
/** Nothing about the connection, the physical tables or the ownership column leaves the host. */
function sealed(reply: Answer) {
  assert.doesNotMatch(reply.text, /postgres(ql)?:|pg_item|pg_task|tenant_id|__mistri_|sessionId|"stack"|"cause"/i);
  if (LIVE) {
    const url = new URL(LIVE);
    for (const secret of [url.password, url.username, url.hostname].filter((value) => value.length > 3))
      assert.equal(reply.text.includes(secret), false);
  }
}
function refused(reply: Answer) {
  assert.ok(reply.status >= 400, reply.text);
  sealed(reply);
  for (const name of ['tenant', 'tab', 'context', 'lease-revision']) assert.equal(reply.headers.get(`x-mistri-${name}`), null);
}
function rows(reply: Answer): Record<string, unknown>[] {
  assert.equal(reply.status, 200, reply.text);
  sealed(reply);
  assert.ok(Array.isArray(reply.body.rows), reply.text);
  return reply.body.rows.map(object);
}

const RESET = [
  'DROP SCHEMA IF EXISTS mistri CASCADE',
  `DO $$ DECLARE r record; BEGIN
     FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE lower(c.relname) LIKE '\\_\\_mistri\\_%' AND c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_temp'
     LOOP EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', r.nspname, r.relname); END LOOP; END $$`,
  'DROP TABLE IF EXISTS public.pg_item, public.pg_task, public.pg_person CASCADE',
];
/* Each tenant's people, a row per membership holding the account's id (auth.me), and an item's notes that @mention them. */
const MENTIONS = [
  'ALTER TABLE public.pg_item ADD COLUMN notes text',
  `CREATE TABLE public.pg_person (id text PRIMARY KEY, tenant_id text NOT NULL, handle text NOT NULL, account_id text NOT NULL,
     UNIQUE (tenant_id, handle))`,
];
const SETUP = [
  `CREATE TABLE public.pg_item (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     UNIQUE (tenant_id, business_id))`,
  `CREATE TABLE public.pg_task (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     version integer NOT NULL DEFAULT 0, UNIQUE (tenant_id, business_id))`,
  `INSERT INTO public.pg_item VALUES ('north-item', 'north', 'same', 'North item'), ('south-item', 'south', 'same', 'South item')`,
  `INSERT INTO public.pg_task VALUES ('north-task', 'north', 'same', 'North task', 0), ('south-task', 'south', 'same', 'South task', 0)`,
];

/* A free-form page whose loader reads items, and one whose loader tries to write one. */
const pageView = (key: string) => ({
  kind: 'page',
  label: key,
  component: { id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' },
  reads: ['item'],
  loader: key,
});
const manifest = (store: string, mentions: boolean | 'email' = false, pages = false) => ({
  id: appId,
  name: 'PostgreSQL tenant fixture',
  auth: {
    providers: ['email'],
    signUp: 'open',
    store,
    rows: 'tenant',
    ...(mentions ? { me: { from: 'person', column: 'account_id' } } : {}),
    roles: { member: { read: true, write: ['item'], commands: ['advance'] } },
  },
  sources: { business: { connection: binding.source.connection } },
  resources: {
    item: {
      physical: 'public.pg_item',
      owner: 'tenant',
      access: 'write',
      fields: mentions
        ? { read: ['id', 'business_id', 'name', 'notes'], write: ['id', 'business_id', 'name', 'notes'] }
        : { read: ['id', 'business_id', 'name'], write: ['id', 'business_id', 'name'] },
      ...(mentions
        ? {
            notify: [
              {
                on: { changes: 'notes' },
                mentions: { in: 'notes', by: 'handle' },
                title: 'Mentioned on {name}',
                ...(mentions === 'email' ? { email: true } : {}),
              },
            ],
          }
        : {}),
    },
    ...(mentions ? { person: { physical: 'public.pg_person', owner: 'tenant', fields: { read: ['id', 'handle', 'account_id'] } } } : {}),
    task: {
      physical: 'public.pg_task',
      owner: 'tenant',
      access: 'write',
      fields: { read: ['id', 'business_id', 'name', 'version'], write: ['id', 'business_id', 'name', 'version'] },
      actions: { advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } } },
    },
  },
  views: {
    items: { kind: 'list', from: 'item' },
    tasks: { kind: 'list', from: 'task' },
    ...(pages ? { board: pageView('board'), scribble: pageView('scribble') } : {}),
  },
  home: 'items',
  nav: ['items', 'tasks', ...(pages ? ['board', 'scribble'] : [])],
});
const policyModule = (extra = '', mentions: boolean | 'email' = false) => `export default {
  kind: 'tenant', appId: ${JSON.stringify(appId)}, storeId: ${JSON.stringify(binding.storeId)},
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, task: { kind: 'tenant', column: 'tenant_id' }${mentions ? ", person: { kind: 'tenant', column: 'tenant_id' }" : ''} },
  resolveMembershipRows: () => ({ item: true, task: true${mentions ? ', person: true' : ''} }),
  resolveRows: () => ({ item: true, task: true${mentions ? ', person: true' : ''} }),
  authorizeDeletedRecord: () => true,
  resultReferences: { advance: result => [{ table: 'task', key: { id: result.taskId } }] },
  ${extra}
};`;
const commandsModule = (pages = false) => `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
${
  pages
    ? `import { defineLoader, defineLoaders } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/pageLoaders.ts', import.meta.url).href)};
export const loaders = defineLoaders({
  board: defineLoader({ reads: ['item'], load: async ({ db }) => ({ items: (await db.item.where({}).orderBy('id')).map((row) => row.name) }) }),
  scribble: defineLoader({ reads: ['item'], load: async ({ db }) => db.item.update({ id: 'north-item' }, { name: 'WRITTEN' }) }),
});`
    : ''
}
export default defineCommands({ advance: defineCommand({ source: 'business', target: 'task', 
  input: {},
  output: { parse(value) { if (!value || typeof value.taskId !== 'string' || !Number.isSafeInteger(value.version)) throw new Error('Bad output'); return { taskId: value.taskId, version: value.version }; } },
  async handle({ db, record }) {
    // A test holds the transaction open here (the revocation that waits for a COMMIT).
    if (globalThis.__advanceGate) await globalThis.__advanceGate();
    const { version } = await db.task.update(record, { version: record.version + 1 });
    return { taskId: String(record.id), version };
  },
}) });`;

describe('a tenant App on PostgreSQL over HTTP, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control, url: string;
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
  const item = async (id: string) =>
    (await control.query('SELECT id, tenant_id, business_id, name FROM public.pg_item WHERE id = $1', [id])).rows[0];
  const items = async () => (await control.query('SELECT id, tenant_id, business_id, name FROM public.pg_item ORDER BY id')).rows;
  const taskVersion = async (id: string) =>
    (await control.query('SELECT version FROM public.pg_task WHERE id = $1', [id])).rows[0]?.version;
  const receipts = async () =>
    (
      await control.query(`SELECT r.tenant_id, a.tenant_id AS audit_tenant FROM ${runtimeTable('postgres', journal.receipt)} r
    JOIN ${postgresAuditRows} a ON a.receipt_id = r.id ORDER BY r.tenant_id`)
    ).rows;

  before(async () => {
    url = await dedicatedPostgresUrl('tenant_http');
    control = await client(url);
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
  });

  /** The operator's files, the database layout and a prepared startup, without a host. */
  async function deployment(
    t: TestContext,
    patch: { policy?: string; store?: string; administration?: boolean; mentions?: boolean | 'email'; pages?: boolean } = {},
  ) {
    for (const statement of [...RESET, ...SETUP, ...(patch.mentions ? MENTIONS : [])]) await control.query(statement);
    await migratePostgresTenantStore(url, binding);
    if (patch.mentions) await provisionPostgresInbox(url);
    await migratePostgresCommandJournal(url);
    if (patch.administration) await migratePostgresTenantAdministrationJournal(url, binding);
    await administer(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    });
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-postgres-tenant-http-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const appPath = join(directory, 'app.json'),
      policyFile = join(directory, 'policy.mjs'),
      commandsFile = join(directory, 'commands.mjs');
    writeFileSync(
      appPath,
      JSON.stringify(namedCommands(manifest(patch.store === 'business-database' ? url : (patch.store ?? './auth.db'), patch.mentions)).app),
    );
    writeFileSync(policyFile, policyModule(patch.policy, patch.mentions));
    writeFileSync(commandsFile, commandsModule(patch.pages));
    const read = await loadApp(appPath);
    /* A page's component module is the App directory's to compile; the loader is the commands module's. The pages'
       views are the parsed manifest's, grafted on, so the host serves the loaders the commands module exports. */
    const paged = patch.pages ? parseTestApp(manifest('./auth.db', patch.mentions, true), 'pg pages') : undefined;
    const loaded = paged ? { ...read, app: { ...read.app, views: paged.views, nav: paged.nav } } : read;
    const connection: ConnectionConfig = {
      id: binding.source.connection,
      name: binding.source.connection,
      url,
      source: 'config',
      writable: true,
    };
    return { loaded, policyFile, prepare: () => prepareTenantStartup({ loaded, connections: [connection], policyFile, commandsFile }) };
  }
  async function nativeAuth(loaded: Awaited<ReturnType<typeof deployment>>['loaded'], origin: string): Promise<AppAuthRuntime> {
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'synthetic-postgres-tenant-secret-at-least-thirty-two-characters';
    try {
      return await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous;
    }
  }

  /* A registry whose config names one email service, read through serviceConnections.ts as the host reads it, and
     whose transport, opened on first use, is the one given. */
  function mailRegistry(transport: EmailTransport) {
    const registry = new Registry();
    registry.addService({ kind: 'email', name: transport.name, url: 'log:', from: 'Tenant <no-reply@example.test>' });
    registry.serviceState('email', () => ({ transport: transport as EmailTransport | undefined }));
    return registry;
  }

  async function fixture(t: TestContext, patch: { mentions?: boolean | 'email'; pages?: boolean; mail?: EmailTransport } = {}) {
    const { loaded, prepare } = await deployment(t, patch);
    const prepared = await prepare();
    const port = await reservePort(),
      origin = `http://127.0.0.1:${port}`;
    const auth = await nativeAuth(loaded, origin);
    const registry = patch.mail && mailRegistry(patch.mail);
    let owner: Owner;
    try {
      owner = await createTenantAuthenticatedHttpServer({
        loaded,
        auth,
        enrollment: prepared.enrollment,
        bound: { host: '127.0.0.1', port },
        // The config's services, as far as this host asks: the email service alone, its transport the test's.
        ...(registry ? { registry } : {}),
      });
    } catch (error) {
      await registry?.closeAll();
      auth.close();
      throw error;
    }
    t.after(async () => {
      owner.server.closeAllConnections();
      await owner.retire();
      await registry?.closeAll();
      auth.close();
    });
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
      const email = `${name.toLowerCase()}@example.test`,
        answer = await call('/api/auth/sign-up/email', { name, email, password });
      assert.equal(answer.status, 200, answer.text);
      const cookie = answer.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      return { accountId: String(object(answer.body.user).id), cookie, email };
    };
    const grant = (account: Account, tenantId: string, patch: Partial<MembershipChange> = {}) =>
      administer((admin) =>
        admin.putMembership({
          tenantId,
          accountId: account.accountId,
          membershipId: `${tenantId}-${account.accountId}`,
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 120_000,
          expectedVersion: null,
          ...patch,
        }),
      );
    const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
    const signedIn = (account: Account) => ({ cookie: account.cookie, 'x-mistri-account': account.accountId });
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
    const data = (path: string, context: Context, body?: unknown) => {
      const { tenant, ...headers } = context;
      return call(select(path, tenant), body, headers);
    };
    const command = (task: string, idempotencyKey: string, expectedVersion = 0) => ({
      command: 'advance',
      commandVersion: 1,
      key: { id: task },
      expectedVersion,
      idempotencyKey,
      input: {},
    });
    return { prepared, owner, call, signup, grant, open, data, select, signedIn, command };
  }

  test('startup takes a PostgreSQL source through --policy, keeps its URL private and needs no auth exclusion', async (t) => {
    const { prepare } = await deployment(t);
    const prepared = await prepare();
    assert.equal(prepared.authStoreExclusion, undefined, 'a PostgreSQL database has no file for native auth to alias');
    assert.deepEqual(Object.keys(prepared.enrollment.source).sort(), ['connection', 'id', 'url']);
    assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.enrollment) && Object.isFrozen(prepared.enrollment.source));
    assert.notEqual(prepared.enrollment.commands, undefined);
  });

  for (const [label, patch, message] of [
    // Public startup takes invitations now; it attests their storage and never creates it.
    [
      'invitations without their provisioned storage',
      {
        policy: `invitations: { id: 'invites', version: '1', maxMembershipLifetimeMs: 86400000,
      maxRedemptionLifetimeMs: 86400000, maxPendingPerTenant: 10,
      operators: [{ accountId: 'operator', tenants: ['north'], operations: ['issueInvitation'], roles: ['member'] }] },`,
      },
      /existing tenant store/,
    ],
    [
      'a postgres:// authentication store in the business database itself',
      { store: 'business-database' },
      /the PostgreSQL source and separate authentication store/,
    ],
  ] as const) {
    test(`startup refuses ${label} on a PostgreSQL tenant source, saying so without the URL`, async (t) => {
      const { prepare } = await deployment(t, patch);
      await assert.rejects(prepare(), (error) => {
        assert.ok(error instanceof TenantStartupError);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /postgres(ql)?:|PRIVATE_/);
        if (LIVE && new URL(LIVE).password) assert.equal(error.message.includes(new URL(LIVE).password), false);
        return true;
      });
    });
  }

  test('administration on PostgreSQL: an operator creates a tenant, grants and revokes a membership, with receipts in its journal', async (t) => {
    const { loaded, policyFile, prepare } = await deployment(t, { administration: true });
    const port = await reservePort(),
      origin = `http://127.0.0.1:${port}`;
    const auth = await nativeAuth(loaded, origin);
    let owner: Owner | undefined;
    t.after(async () => {
      if (owner) {
        owner.server.closeAllConnections();
        await owner.retire();
      }
      auth.close();
    });
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, body: text ? object(JSON.parse(text)) : {} };
    };
    const signup = async (name: string): Promise<Account> => {
      const email = `${name.toLowerCase()}@example.test`,
        answer = await call('/api/auth/sign-up/email', { name, email, password });
      assert.equal(answer.status, 200, answer.text);
      return {
        accountId: String(object(answer.body.user).id),
        cookie: answer.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
        email,
      };
    };
    // Accounts exist before the operator policy that names one, as in a real deployment.
    const bootstrap = createServer((req, res) => {
      void auth.handler(req, res).catch(() => res.destroy());
    });
    bootstrap.listen(port, '127.0.0.1');
    await once(bootstrap, 'listening');
    let operator: Account, member: Account;
    try {
      operator = await signup('Operator');
      member = await signup('Member');
    } finally {
      bootstrap.closeAllConnections();
      await new Promise<void>((resolve) => bootstrap.close(() => resolve()));
    }
    writeFileSync(
      policyFile,
      policyModule(`administration: { id: 'pg-operations', version: '1', maxMembershipLifetimeMs: 120000,
      operators: [{ accountId: ${JSON.stringify(operator.accountId)}, tenants: ['east'],
        operations: ['createTenant', 'setTenantStatus', 'grantMembership', 'replaceMembership', 'revokeMembership'], roles: ['member'] }] },`),
    );
    const prepared = await prepare();
    owner = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      enrollment: prepared.enrollment,
      bound: { host: '127.0.0.1', port },
    });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const root = (operation: string, query = '') => `/api/tenant/administration/${operation}?app=${appId}${query}`;
    const identity = (account: Account) => ({ cookie: account.cookie, 'x-mistri-app': appId, 'x-mistri-account': account.accountId });
    const opened = await call(root('open'), {}, identity(operator));
    assert.equal(opened.status, 200, opened.text);
    sealed(opened);
    const context = String(object(opened.body.session).context),
      operating = { ...identity(operator), [ADMINISTRATION_HTTP_HEADER]: context };
    assert.equal((await call(root('open'), {}, identity(member))).body.session, null, 'login is identity, never operator authority');

    const create = { idempotencyKey: 'pg-admin-create-east', intent: { operation: 'createTenant', tenantId: 'east' } };
    const created = await call(root('execute'), create, operating);
    assert.equal(created.status, 200, created.text);
    sealed(created);
    assert.equal(created.body.outcome, 'applied');
    const replayed = await call(root('execute'), create, operating);
    assert.equal(object(replayed.body.result).replayed, true);
    assert.equal(object(replayed.body.result).receiptId, object(created.body.result).receiptId);
    const listed = await call(root('tenants'), undefined, operating);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(object((object(listed.body.page).items as unknown[])[0]).tenant, { tenantId: 'east', status: 'active', version: '1' });

    const granted = await call(
      root('execute'),
      {
        idempotencyKey: 'pg-admin-grant-member',
        intent: {
          operation: 'grantMembership',
          tenantId: 'east',
          expectedTenantVersion: '1',
          accountId: member.accountId,
          roles: ['member'],
          validUntil: Date.now() + 90_000,
        },
      },
      operating,
    );
    assert.equal(granted.status, 200, granted.text);
    assert.equal(granted.body.outcome, 'applied');
    const membership = object(object(object(granted.body.result).change).after).membership as Record<string, string>;
    const members = await call(root('memberships', '&tenantId=east&operation=revokeMembership'), undefined, operating);
    assert.deepEqual(object(members.body.page).items, [membership]);

    // The granted member now works inside the new tenant, and only there.
    const tenantOpen = await call(`/api/tenant/context/open?app=${appId}&tenant=east`, {}, identity(member));
    assert.equal(tenantOpen.status, 200, tenantOpen.text);
    const east = {
      ...identity(member),
      'x-mistri-tab': String(tenantOpen.body.tabId),
      'x-mistri-context': String(tenantOpen.body.context),
      'x-mistri-lease-revision': String(tenantOpen.body.revision),
    };
    assert.deepEqual(rows(await call(`/api/query?app=${appId}&tenant=east`, { table: 'item' }, east)), []);
    const inserted = await call(
      `/api/insert?app=${appId}&tenant=east`,
      { table: 'item', values: { id: 'east-item', business_id: 'same', name: 'East' } },
      east,
    );
    assert.equal(inserted.status, 200, inserted.text);
    assert.deepEqual({ ...(await item('east-item')) }, { id: 'east-item', tenant_id: 'east', business_id: 'same', name: 'East' });

    const revoked = await call(
      root('execute'),
      {
        idempotencyKey: 'pg-admin-revoke-member',
        intent: {
          operation: 'revokeMembership',
          tenantId: 'east',
          expectedTenantVersion: '1',
          membershipId: membership.membershipId,
          expectedMembershipVersion: membership.version,
        },
      },
      operating,
    );
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.body.outcome, 'applied');
    refused(await call(`/api/query?app=${appId}&tenant=east`, { table: 'item' }, east));
    refused(
      await call(
        `/api/update?app=${appId}&tenant=east`,
        { table: 'item', key: { id: 'east-item' }, values: { name: 'After revocation' } },
        east,
      ),
    );
    assert.equal((await item('east-item')).name, 'East');

    const journaled = (
      await control.query(`SELECT r.operation, r.tenant_id, r.actor_id, r.session_id <> '' AS session
      FROM ${runtimeTable('postgres', adminJournal.receipt)} r ORDER BY r.completed_at, r.operation`)
    ).rows;
    assert.deepEqual(
      journaled.map((row) => [row.operation, row.tenant_id, row.actor_id, row.session]),
      [
        ['createTenant', 'east', operator.accountId, true],
        ['grantMembership', 'east', operator.accountId, true],
        ['revokeMembership', 'east', operator.accountId, true],
      ],
    );
    assert.doesNotMatch(JSON.stringify(journaled), new RegExp(operator.cookie.split('=')[1] ?? 'no-cookie'));

    for (const change of ['target', 'session'] as const)
      await t.test(`SQLite native ${change} deletion during final PG attestation refuses commit`, async (sub) => {
        const target = await signup(`FinalRace${change}`);
        const counts = async () =>
          Promise.all(
            [TENANT_TABLES.membership, adminJournal.receipt].map(async (table) =>
              Number((await control.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', table)}`)).rows[0].n),
            ),
          );
        const before = await counts();
        const original = PostgresAdapter.prototype.runtimeMaintenanceTransaction;
        let injected = false;
        sub.mock.method(PostgresAdapter.prototype, 'runtimeMaintenanceTransaction', function <
          T,
        >(this: PostgresAdapter, verify: (client: PgQuery) => Promise<void>, work: (client: PgQuery, operations: TransactionOperations, current: () => void) => Promise<T>): Promise<T> {
          let completed = false;
          const forwarded = (client: PgQuery): PgQuery => {
            function query(text: string, args?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
            function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
            async function query(input: string | { text: string; values?: unknown[]; rowMode?: string }, args?: unknown[]) {
              const result = await (typeof input === 'string' ? client.query(input, args) : client.query(input));
              if (completed && !injected) {
                injected = true;
                // PG storage yielded after mutation work. The auth store is
                // genuinely SQLite: live(), not the async PG auth branch, must
                // re-observe this deletion before the business COMMIT.
                const native = new DatabaseSync(auth.store);
                try {
                  if (change === 'session') native.prepare('DELETE FROM "session" WHERE "userId"=?').run(operator.accountId);
                  else native.prepare('DELETE FROM "user" WHERE id=?').run(target.accountId);
                } finally {
                  native.close();
                }
              }
              return result;
            }
            return { query };
          };
          return original.call(
            this,
            (client) => verify(forwarded(client)),
            async (client, operations, current) => {
              const result = await work(client, operations, current);
              completed = true;
              return result;
            },
          ) as Promise<T>;
        });
        const reply = await call(
          root('execute'),
          {
            idempotencyKey: `sqlite-auth-final-${change}`,
            intent: {
              operation: 'grantMembership',
              tenantId: 'east',
              expectedTenantVersion: '1',
              accountId: target.accountId,
              roles: ['member'],
              validUntil: Date.now() + 90_000,
            },
          },
          operating,
        );
        assert.equal(injected, true, 'mutation must run during final native PG attestation');
        assert.ok(reply.status >= 400, reply.text);
        assert.equal(reply.body.outcome, 'not_applied');
        assert.deepEqual(await counts(), before);
      });
  });

  test('guessed IDs and equal business IDs stay inside the selected tenant on every data route', async (t) => {
    const f = await fixture(t),
      ada = await f.signup('Ada'),
      bob = await f.signup('Bob');
    await f.grant(ada, 'north');
    await f.grant(bob, 'south');
    const before = await items();
    const north = await f.open(ada, 'north'),
      south = await f.open(bob, 'south');
    assert.deepEqual(rows(await f.data('/api/query', north, { table: 'item' })), [
      { id: 'north-item', business_id: 'same', name: 'North item' },
    ]);
    assert.deepEqual(rows(await f.data('/api/query', south, { table: 'item' })), [
      { id: 'south-item', business_id: 'same', name: 'South item' },
    ]);
    const guessed = { groups: [[{ column: 'id', op: '=', value: 'south-item' }]] };
    assert.deepEqual(rows(await f.data('/api/query', north, { table: 'item', filter: guessed })), []);
    refused(await f.data('/api/update', north, { table: 'item', key: { id: 'south-item' }, values: { name: 'STOLEN' } }));
    refused(await f.data('/api/delete', north, { table: 'item', key: { id: 'south-item' }, confirm: true }));
    refused(await f.data('/api/references', north, { table: 'item', key: { id: 'south-item' } }));
    refused(await f.call(f.select('/api/tenant/context/open', 'south'), {}, f.signedIn(ada)));
    assert.deepEqual(await items(), before);
    // Context tokens are bound to the native login and the tenant that opened them.
    refused(await f.data('/api/query', { ...south, ...f.signedIn(ada) }, { table: 'item' }));
    refused(await f.data('/api/query', { ...north, tenant: 'south' }, { table: 'item' }));
  });

  test("a page's loader reads its member's own tenant on PostgreSQL through the lease's reader, and cannot write", async (t) => {
    const f = await fixture(t, { pages: true }),
      ada = await f.signup('Ada'),
      bob = await f.signup('Bob');
    await f.grant(ada, 'north');
    await f.grant(bob, 'south');
    const north = await f.open(ada, 'north'),
      south = await f.open(bob, 'south');
    const before = await items();
    const board = async (context: Context) => {
      const reply = await f.data('/api/pages/load', context, { page: 'board' });
      assert.equal(reply.status, 200, reply.text);
      sealed(reply);
      return reply.body;
    };
    assert.deepEqual(await board(north), { data: { items: ['North item'] } });
    assert.deepEqual(await board(south), { data: { items: ['South item'] } });
    const wrote = await f.data('/api/pages/load', north, { page: 'scribble' });
    refused(wrote);
    assert.equal(wrote.body.code, 'loader_refused');
    assert.deepEqual(await items(), before);
    refused(await f.data('/api/pages/load', { ...south, ...f.signedIn(ada) }, { page: 'board' }));
  });

  test('forged ownership on insert and update refuses; the managed column keeps business IDs tenant-local', async (t) => {
    const f = await fixture(t),
      ada = await f.signup('Ada'),
      bob = await f.signup('Bob');
    await f.grant(ada, 'north');
    await f.grant(bob, 'south');
    const north = await f.open(ada, 'north'),
      south = await f.open(bob, 'south');
    const before = await items();
    refused(
      await f.data('/api/insert', north, {
        table: 'item',
        values: { id: 'forged', business_id: 'forged', name: 'Forged', tenant_id: 'south' },
      }),
    );
    refused(
      await f.data('/api/insert', north, {
        table: 'item',
        values: { id: 'forged', business_id: 'forged', name: 'Forged', tenant_id: 'north' },
      }),
    );
    refused(await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { tenant_id: 'south' } }));
    refused(
      await f.data('/api/insert', north, { table: 'item', values: { id: 'duplicate', business_id: 'same', name: 'Same business ID' } }),
    );
    assert.deepEqual(await items(), before);
    for (const [context, id] of [
      [north, 'ada-fresh'],
      [south, 'bob-fresh'],
    ] as const) {
      const created = await f.data('/api/insert', context, { table: 'item', values: { id, business_id: 'fresh', name: 'Fresh' } });
      assert.equal(created.status, 200, created.text);
      sealed(created);
    }
    assert.deepEqual({ ...(await item('ada-fresh')) }, { id: 'ada-fresh', tenant_id: 'north', business_id: 'fresh', name: 'Fresh' });
    assert.deepEqual({ ...(await item('bob-fresh')) }, { id: 'bob-fresh', tenant_id: 'south', business_id: 'fresh', name: 'Fresh' });
  });

  test('a command idempotency key replays inside its tenant and never across tenants', async (t) => {
    const f = await fixture(t),
      cy = await f.signup('Cy');
    await f.grant(cy, 'north');
    await f.grant(cy, 'south');
    const north = await f.open(cy, 'north'),
      south = await f.open(cy, 'south'),
      key = 'pg-http-attempt-0001';
    const first = await f.data('/api/commands/execute', north, f.command('north-task', key));
    assert.equal(first.status, 200, first.text);
    sealed(first);
    assert.equal(first.body.status, 'applied');
    const replay = await f.data('/api/commands/status', north, f.command('north-task', key));
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.receiptId, first.body.receiptId);
    // The same key in the other tenant is another attempt with its own receipt.
    const second = await f.data('/api/commands/execute', south, f.command('south-task', key));
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.status, 'applied');
    assert.notEqual(second.body.receiptId, first.body.receiptId);
    // North's receipt is not reachable from south, by status or by re-execution against its target.
    for (const route of ['/api/commands/status', '/api/commands/execute']) {
      const crossed = await f.data(route, south, f.command('north-task', key));
      assert.ok(crossed.status >= 400 || crossed.body.status !== 'applied', crossed.text);
      sealed(crossed);
      assert.notEqual(crossed.body.receiptId, first.body.receiptId);
    }
    assert.equal(await taskVersion('north-task'), 1);
    assert.equal(await taskVersion('south-task'), 1);
    assert.deepEqual(await receipts(), [
      { tenant_id: 'north', audit_tenant: 'north' },
      { tenant_id: 'south', audit_tenant: 'south' },
    ]);
  });

  test("an @mention tells a member of the record's tenant at their account's email, and nobody whose account is not one", async (t) => {
    const f = await fixture(t, { mentions: true });
    const [alice, bob, carol] = [await f.signup('Alice'), await f.signup('Bob'), await f.signup('Carol')];
    await f.grant(alice, 'north');
    await f.grant(bob, 'north');
    // Carol is south's; north's own row naming her account is the tenant's data, not a membership.
    await f.grant(carol, 'south');
    await control.query(
      `INSERT INTO public.pg_person VALUES ('n-alice', 'north', 'alice', $1), ('n-bob', 'north', 'bob', $2), ('n-carol', 'north', 'carol', $3)`,
      [alice.accountId, bob.accountId, carol.accountId],
    );
    const aliceNorth = await f.open(alice, 'north');
    const write = async (notes: string) => {
      const reply = await f.data('/api/update', aliceNorth, { table: 'item', key: { id: 'north-item' }, values: { notes } });
      assert.equal(reply.status, 200, reply.text);
    };
    const told = async () =>
      (await control.query('SELECT app, recipient, title FROM mistri."inbox_notice" ORDER BY id')).rows.map((row) => ({
        ...row,
      }));
    await write('Over to @carol');
    assert.deepEqual(await told(), []);
    await write('Over to @bob, and @carol');
    assert.deepEqual(await told(), [{ app: tenantInbox(appId, 'north'), recipient: bob.email, title: 'Mentioned on North item' }]);
    // Bob reads it in north's inbox, as his own session.
    const bobNorth = await f.open(bob, 'north');
    const inbox = await f.data('/api/inbox', bobNorth, { limit: 20 });
    assert.equal(inbox.status, 200, inbox.text);
    assert.deepEqual(
      (inbox.body.notices as Array<{ title: string }>).map((notice) => notice.title),
      ['Mentioned on North item'],
    );
  });

  test("an emailed mention goes out as the recipient's membership at send time, opens in that tenant, and never carries another tenant's record", async (t) => {
    const sent: EmailMessage[] = [];
    const f = await fixture(t, { mentions: 'email', mail: { name: 'test', send: async (message) => void sent.push(message) } });
    const [alice, bob, carol] = [await f.signup('Alice'), await f.signup('Bob'), await f.signup('Carol')];
    await f.grant(alice, 'north');
    await f.grant(bob, 'north');
    await f.grant(carol, 'north');
    await f.grant(carol, 'south');
    await control.query(
      `INSERT INTO public.pg_person VALUES ('n-alice', 'north', 'alice', $1), ('n-bob', 'north', 'bob', $2), ('n-carol', 'north', 'carol', $3)`,
      [alice.accountId, bob.accountId, carol.accountId],
    );
    const aliceNorth = await f.open(alice, 'north');
    const write = async (notes: string) => {
      const reply = await f.data('/api/update', aliceNorth, { table: 'item', key: { id: 'north-item' }, values: { notes } });
      assert.equal(reply.status, 200, reply.text);
    };
    const queued = async () => Number((await control.query('SELECT count(*) AS n FROM mistri."inbox_mail"')).rows[0].n);
    const drained = async () => {
      for (let waited = 0; (await queued()) > 0; waited += 25) {
        assert.ok(waited < 10_000, 'the outbox was not drained');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // Queued while Bob was a member, sent after he was removed: nobody is mailed.
    await write('Over to @bob');
    assert.equal(await queued(), 1);
    await administer((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: bob.accountId,
        membershipId: `north-${bob.accountId}`,
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: '1',
      }),
    );
    f.owner.jobs!.start();
    await drained();
    assert.equal(sent.length, 0);
    // Carol, still a member, is told at her account's address, with a link into north.
    await write('Over to @carol');
    await drained();
    assert.deepEqual(
      sent.map((message) => [message.to, message.subject]),
      [[carol.email, 'Mentioned on North item']],
    );
    // The host was given no public URL, so the link starts where a local server's would.
    assert.ok(sent[0].text.includes(`Open it: http://localhost/${appId}/items/north-item?tenant=north\n`), sent[0].text);
    /* A row planted in north's outbox about south's record, which Carol may
       read in south, is read as her north membership, which cannot: dropped unsent. */
    await control.query(
      `WITH planted AS (
        INSERT INTO mistri."inbox_notice" (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
        SELECT app, recipient, at, resource, '{"id":"south-item"}', 'Planted', uses_json, actor, actor_name, action
        FROM mistri."inbox_notice" WHERE app = $1 AND recipient = $2 ORDER BY id LIMIT 1 RETURNING id)
      INSERT INTO mistri."inbox_mail" (notice, state, due_at, attempts) SELECT id, 'queued', '2000-01-01T00:00:00.000Z', 0 FROM planted`,
      [tenantInbox(appId, 'north'), carol.email],
    );
    await drained();
    assert.equal(sent.length, 1);
  });

  /* A write's membership is proven by the writer's fence, the tenant and
     membership rows locked from BEGIN to COMMIT, not by a snapshot read before
     it: the refusal a revoked member or a suspended tenant's member hears is
     still the membership's, never an unknown outcome or one about the record. */
  test("a revoked member, and a suspended tenant's, are refused a write as the membership refuses it", async (t) => {
    const f = await fixture(t),
      ada = await f.signup('Ada'),
      bea = await f.signup('Bea');
    await f.grant(ada, 'north');
    await f.grant(bea, 'south');
    const north = await f.open(ada, 'north'),
      south = await f.open(bea, 'south');
    // Each login's admission is kept now, so the next request reads no membership before its transaction.
    for (const [context, task, key] of [
      [north, 'north-task', 'pg-http-kept-north-0001'],
      [south, 'south-task', 'pg-http-kept-south-0001'],
    ] as const) {
      const applied = await f.data('/api/commands/execute', context, f.command(task, key));
      assert.equal(applied.status, 200, applied.text);
    }
    await administer((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: ada.accountId,
        membershipId: `north-${ada.accountId}`,
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: '1',
      }),
    );
    await administer((admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '1' }));
    const command = {
      code: 'forbidden',
      message: 'This command is not available to this account.',
      error: 'This command is not available to this account.',
    };
    const record = {
      error: 'The change is unavailable under the current permissions or record state.',
      errors: [{ code: 'forbidden', message: 'The change is unavailable under the current permissions or record state.' }],
      outcome: 'rejected',
    };
    for (const [context, task, key] of [
      [north, 'north-task', 'pg-http-revoked-000001'],
      [south, 'south-task', 'pg-http-suspended-0001'],
    ] as const) {
      const executed = await f.data('/api/commands/execute', context, f.command(task, key, 1));
      assert.equal(executed.status, 403, executed.text);
      // Unknown, as every execute refused before its receipt is read: an earlier attempt with the key may have committed.
      assert.deepEqual(executed.body, { ...command, outcome: 'unknown' });
      refused(executed);
      const prepared = await f.data('/api/commands/prepare', context, f.command(task, `${key}-p`, 1));
      assert.equal(prepared.status, 403, prepared.text);
      assert.equal(prepared.body.code, 'forbidden');
      const updated = await f.data('/api/update', context, {
        table: 'item',
        key: { id: `${context.tenant}-item` },
        values: { name: 'After the change' },
      });
      assert.equal(updated.status, 403, updated.text);
      assert.deepEqual(updated.body, record);
      assert.equal(await taskVersion(task), 1);
    }
    assert.equal((await item('north-item')).name, 'North item');
  });

  test('a revocation that begins while a command runs waits for its COMMIT, and the command is answered as applied', async (t) => {
    const f = await fixture(t),
      ada = await f.signup('Ada');
    await f.grant(ada, 'north');
    const north = await f.open(ada, 'north');
    const warm = await f.data('/api/commands/execute', north, f.command('north-task', 'pg-http-gate-warm-0001'));
    assert.equal(warm.status, 200, warm.text);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve)),
      held = new Promise<void>((resolve) => (release = resolve));
    const gates = globalThis as { __advanceGate?: () => Promise<void> };
    gates.__advanceGate = () => {
      entered();
      return held;
    };
    t.after(() => {
      delete gates.__advanceGate;
    });
    const executed = f.data('/api/commands/execute', north, f.command('north-task', 'pg-http-gate-run-00001', 1));
    await inside;
    let revokedAt = 0;
    const revocation = administer((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: ada.accountId,
        membershipId: `north-${ada.accountId}`,
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: '1',
      }),
    ).then(() => {
      revokedAt = Date.now();
    });
    // The command holds the tenant and membership rows FOR SHARE: the revocation's FOR UPDATE waits.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(revokedAt, 0, 'the revocation did not wait for the command');
    const released = Date.now();
    release();
    const answer = await executed;
    await revocation;
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.status, 'applied');
    assert.ok(revokedAt >= released, 'the revocation committed before the command was let go');
    assert.equal(await taskVersion('north-task'), 2);
    // The next write is the revoked member's, and is refused.
    const after = await f.data('/api/commands/execute', north, f.command('north-task', 'pg-http-gate-after-001', 2));
    assert.equal(after.status, 403, after.text);
    assert.equal(await taskVersion('north-task'), 2);
  });

  test('revocation mid-session refuses the next write and read, and changes nothing', async (t) => {
    const f = await fixture(t),
      ada = await f.signup('Ada');
    await f.grant(ada, 'north');
    const north = await f.open(ada, 'north');
    const edited = await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { name: 'Before revocation' } });
    assert.equal(edited.status, 200, edited.text);
    await administer((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: ada.accountId,
        membershipId: `north-${ada.accountId}`,
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: '1',
      }),
    );
    refused(await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { name: 'After revocation' } }));
    refused(await f.data('/api/commands/execute', north, f.command('north-task', 'pg-http-after-revocation')));
    refused(await f.data('/api/query', north, { table: 'item' }));
    refused(await f.call(f.select('/api/tenant/context/open', 'north'), {}, f.signedIn(ada)));
    assert.equal((await item('north-item')).name, 'Before revocation');
    assert.equal(await taskVersion('north-task'), 0);
    const membership = (
      await control.query(`SELECT status FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} WHERE account_id = $1`, [ada.accountId])
    ).rows;
    assert.deepEqual(membership, [{ status: 'revoked' }]);
  });
});
