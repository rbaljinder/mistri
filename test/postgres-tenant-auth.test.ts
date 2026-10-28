import { namedCommands } from './support/commandCatalog.js';
/**
 * The tenant host on a PostgreSQL authentication store, against a real server.
 *
 * The file store is read synchronously; a postgres:// store cannot be, so the
 * tenant binding observes it asynchronously (`observeSession`, and the account
 * lookups) at the owner's last await before COMMIT: the tenant host's verifier
 * on admission and after a write's callback, and each administration step.
 * This file proves that observation refuses what the file store's refuses —
 * impersonation, a ban, an ended session, a session shortened after an
 * administration context opened, a missing target account — and where the
 * pre-commit window lies: a sign-out during a write's callback refuses its
 * commit; one after COMMIT leaves it applied and refuses the next request.
 *
 * Those cases change the store as another process would, so they run with
 * nothing kept (MISTRI_AUTH_SESSION_CACHE=0): every observation reads the
 * store. What a few seconds of kept reads changes (authStoreReads.ts) is
 * proven at the end: a signed-in request's cost on the store, cold, warm and
 * in a page's burst; a sign-out in this process refused at once, before a
 * commit too; one elsewhere refused once what was kept expires.
 *
 * The business source is PostgreSQL too, in another database on the same
 * server, which is what separation permits. Live and opt-in like the other
 * PostgreSQL suites; the role needs CREATEDB for the dedicated databases.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { RUNTIME_SCHEMA, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { ADMINISTRATION_JOURNAL_TABLES as administrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { prepareTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import {
  createPostgresTenantInvitations,
  migratePostgresTenantInvitations,
} from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { INVITATION_TABLES, provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { provisionSqliteTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openTenantAdministration } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import {
  INVITATION_ISSUER_OPERATIONS,
  INVITATION_HTTP_HEADER,
  type InvitationPair,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { ADMINISTRATION_HTTP_HEADER } from '../packages/mistri/src/shared/tenantAdministration.js';
import { liveSkip } from './live.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const appId = 'pg-tenant-auth';
const password = 'Disposable-local-password-123!';
const binding = { appId, source: { id: 'business', connection: 'pg-auth-business' }, storeId: 'pg-tenant-auth-store' };
const S = RUNTIME_SCHEMA;
type Owner = Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
type Answer = { status: number; headers: Headers; body: Record<string, unknown>; text: string };
type Account = { accountId: string; cookie: string; email: string };
/** The command handler's pause, shared in-process with the loaded command module. */
const hold = globalThis as { __tablewalkTenantAuthHold?: () => Promise<void> };

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
function refused(reply: Answer) {
  assert.ok(reply.status >= 400, reply.text);
  assert.doesNotMatch(reply.text, /postgres(ql)?:|pg_item|pg_task|tenant_id|__mistri_|mistri\.auth_|sessionId|"stack"|"cause"/i);
  for (const name of ['tenant', 'tab', 'context', 'lease-revision']) assert.equal(reply.headers.get(`x-mistri-${name}`), null);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const RESET = [
  'DROP SCHEMA IF EXISTS mistri CASCADE',
  `DO $$ DECLARE r record; BEGIN
     FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE lower(c.relname) LIKE '\\_\\_mistri\\_%' AND c.relkind IN ('r', 'p') AND n.nspname !~ '^pg_temp'
     LOOP EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', r.nspname, r.relname); END LOOP; END $$`,
  'DROP TABLE IF EXISTS public.pg_item, public.pg_task CASCADE',
];
const SETUP = [
  `CREATE TABLE public.pg_item (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     UNIQUE (tenant_id, business_id))`,
  `CREATE TABLE public.pg_task (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL, name text NOT NULL,
     version integer NOT NULL DEFAULT 0, UNIQUE (tenant_id, business_id))`,
  `INSERT INTO public.pg_item VALUES ('north-item', 'north', 'same', 'North item'), ('south-item', 'south', 'same', 'South item')`,
  `INSERT INTO public.pg_task VALUES ('north-task', 'north', 'same', 'North task', 0), ('south-task', 'south', 'same', 'South task', 0)`,
];
const manifest = (store: string) => ({
  id: appId,
  name: 'PostgreSQL auth tenant fixture',
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
      actions: { advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } } },
    },
  },
  auth: {
    providers: ['email'],
    signUp: 'open',
    store,
    rows: 'tenant',
    roles: { member: { read: true, write: ['item'], commands: ['advance'] } },
  },
  views: { item: { kind: 'list', from: 'item' }, task: { kind: 'list', from: 'task' } },
  home: 'item',
  nav: ['item', 'task'],
});
const policyModule = (extra = '') => `export default {
  kind: 'tenant', appId: ${JSON.stringify(appId)}, storeId: ${JSON.stringify(binding.storeId)},
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, task: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true, task: true }),
  resolveRows: () => ({ item: true, task: true }),
  authorizeDeletedRecord: () => true,
  resultReferences: { advance: result => [{ table: 'task', key: { id: result.taskId } }] },
  ${extra}
};`;
const commandsModule = () => `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
export default defineCommands({ advance: defineCommand({ source: 'business', target: 'task', 
  input: {},
  output: { parse(value) { if (!value || typeof value.taskId !== 'string' || !Number.isSafeInteger(value.version)) throw new Error('Bad output'); return { taskId: value.taskId, version: value.version }; } },
  async handle({ db, record }) {
    const { version } = await db.task.update(record, { version: record.version + 1 });
    await globalThis.__tablewalkTenantAuthHold?.();
    return { taskId: String(record.id), version };
  },
}) });`;

describe('the tenant host on a PostgreSQL authentication store, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control, auth: Control, businessUrl: string, authUrl: string;
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
  const taskVersion = async (id: string) =>
    (await control.query('SELECT version FROM public.pg_task WHERE id = $1', [id])).rows[0]?.version;
  const itemName = async (id: string) => (await control.query('SELECT name FROM public.pg_item WHERE id = $1', [id])).rows[0]?.name;
  const receipts = async () =>
    Number((await control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', journal.receipt)}`)).rows[0].n);

  // Two databases this file alone owns, named by UUIDs and dropped afterwards.
  const drops: Array<() => Promise<void>> = [];
  before(async () => {
    const business = await uuidPostgresDatabase('tenant_auth_business');
    drops.push(business.drop);
    const store = await uuidPostgresDatabase('tenant_auth_store');
    drops.push(store.drop);
    businessUrl = business.url;
    authUrl = store.url;
    await migratePostgresAuthStore(authUrl);
    control = await client(businessUrl);
    auth = await client(authUrl);
  });
  after(async () => {
    delete hold.__tablewalkTenantAuthHold;
    await control?.end().catch(() => {});
    await auth?.end().catch(() => {});
    for (const drop of drops) await drop();
  });

  async function fixture(
    t: TestContext,
    options: {
      administration?: boolean;
      invitationStorage?: boolean;
      publicInvitations?: boolean;
      sqliteAuth?: boolean;
      missingInvitations?: boolean;
      /** MISTRI_AUTH_SESSION_CACHE for this App's auth store; undefined leaves it unset (the default). */
      keptSessions?: string | undefined;
    } = {},
  ) {
    const kept = 'keptSessions' in options ? options.keptSessions : '0';
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
    /* CASCADE: the store's later tables (an identity provider's sessions, SCIM's links, OAuth's grants) hang off a
       session or a user and are deleted with them, so they go too rather than each being named here. */
    await auth.query(`TRUNCATE ${S}.auth_verification, ${S}.auth_account, ${S}.auth_session, ${S}.auth_user CASCADE`);
    await migratePostgresTenantStore(businessUrl, binding);
    await migratePostgresCommandJournal(businessUrl);
    if (options.administration || options.publicInvitations) await migratePostgresTenantAdministrationJournal(businessUrl, binding);
    if (options.publicInvitations && !options.missingInvitations) await migratePostgresTenantInvitations(businessUrl, binding);
    await administer(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    });
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-postgres-tenant-auth-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const appPath = join(directory, 'app.json'),
      policyFile = join(directory, 'policy.mjs'),
      commandsFile = join(directory, 'commands.mjs');
    writeFileSync(appPath, JSON.stringify(namedCommands(manifest(options.sqliteAuth ? join(directory, 'native-auth.db') : authUrl)).app));
    writeFileSync(policyFile, policyModule());
    writeFileSync(commandsFile, commandsModule());
    const loaded = await loadApp(appPath);
    const connection: ConnectionConfig = {
      id: binding.source.connection,
      name: binding.source.connection,
      url: businessUrl,
      source: 'config',
      writable: true,
    };
    const port = await reservePort(),
      origin = `http://127.0.0.1:${port}`;
    const previous = process.env.BETTER_AUTH_SECRET,
      previousKept = process.env.MISTRI_AUTH_SESSION_CACHE;
    process.env.BETTER_AUTH_SECRET = 'synthetic-postgres-auth-tenant-secret-at-least-thirty-two-characters';
    if (kept === undefined) delete process.env.MISTRI_AUTH_SESSION_CACHE;
    else process.env.MISTRI_AUTH_SESSION_CACHE = kept;
    let runtime: AppAuthRuntime;
    try {
      runtime = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], excludeConnections: [connection] });
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous;
      if (previousKept === undefined) delete process.env.MISTRI_AUTH_SESSION_CACHE;
      else process.env.MISTRI_AUTH_SESSION_CACHE = previousKept;
    }
    let owner: Owner | undefined;
    const privateOwners: Array<() => Promise<void>> = [];
    t.after(async () => {
      for (const close of privateOwners.reverse()) await close();
      if (owner) {
        owner.server.closeAllConnections();
        await owner.retire();
      }
      runtime.close();
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
    // Accounts exist before an operator policy names one, as in a real deployment.
    const bootstrap = createServer((req: IncomingMessage, res) => {
      void runtime.handler(req, res).catch(() => res.destroy());
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
    if (options.administration)
      writeFileSync(
        policyFile,
        policyModule(`administration: { id: 'pg-auth-operations', version: '1',
      maxMembershipLifetimeMs: 120000, operators: [{ accountId: ${JSON.stringify(operator.accountId)}, tenants: ['north'],
      operations: ['grantMembership', 'replaceMembership', 'revokeMembership'], roles: ['member'] }] },`),
      );
    let invitedMembership: string | undefined;
    if (options.invitationStorage) {
      await migratePostgresTenantInvitations(businessUrl, binding);
      invitedMembership = randomUUID();
      const membershipId = invitedMembership,
        now = Date.now();
      await control.query('BEGIN');
      const operations = new TransactionOperations();
      try {
        await createPostgresTenantAdministration(control, operations, binding).putMembership({
          membershipId,
          tenantId: 'north',
          accountId: member!.accountId,
          status: 'invited',
          expectedVersion: null,
          roles: ['member'],
          validUntil: now + 90_000,
        });
        await createPostgresTenantInvitations(control, operations, binding, () => {}).insert({
          invitationId: randomUUID(),
          version: '1',
          tenantId: 'north',
          membershipId,
          accountId: member!.accountId,
          inviterId: operator!.accountId,
          issuanceOperation: 'issueInvitation',
          roles: ['member'],
          expectedTenantVersion: '1',
          policyId: 'former-invitation-policy',
          policyVersion: '1',
          createdAt: now,
          redeemUntil: now + 60_000,
          validUntil: now + 90_000,
          status: 'pending',
          digest: 'ab'.repeat(32),
        });
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    }
    if (options.publicInvitations) {
      // Public startup, as an operator runs it: the server-only policy file declares them.
      const invitations = {
        id: 'public-http-inviters',
        version: '1',
        maxMembershipLifetimeMs: 120_000,
        maxRedemptionLifetimeMs: 90_000,
        maxPendingPerTenant: 10,
        operators: [{ accountId: operator!.accountId, tenants: ['north'], roles: ['member'], operations: INVITATION_ISSUER_OPERATIONS }],
      };
      writeFileSync(policyFile, policyModule(`invitations: ${JSON.stringify(invitations)},`));
    }
    const { enrollment } = await prepareTenantStartup({ loaded, connections: [connection], policyFile, commandsFile });
    owner = await createTenantAuthenticatedHttpServer({ loaded, auth: runtime, enrollment, bound: { host: '127.0.0.1', port } });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const signedIn = (account: Account) => ({ cookie: account.cookie, 'x-mistri-account': account.accountId });
    const grant = (account: Account, tenantId = 'north') =>
      administer((admin) =>
        admin.putMembership({
          tenantId,
          accountId: account.accountId,
          membershipId: `${tenantId}-${account.accountId}`,
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 120_000,
          expectedVersion: null,
        }),
      );
    const open = async (account: Account, tenant = 'north') => {
      const reply = await call(`/api/tenant/context/open?app=${appId}&tenant=${tenant}`, {}, signedIn(account));
      assert.equal(reply.status, 200, reply.text);
      return {
        ...signedIn(account),
        'x-mistri-tab': String(reply.body.tabId),
        'x-mistri-context': String(reply.body.context),
        'x-mistri-lease-revision': String(reply.body.revision),
      };
    };
    const data = (path: string, headers: Record<string, string>, body?: unknown, tenant = 'north') =>
      call(`${path}?app=${appId}&tenant=${tenant}`, body, headers);
    return {
      runtime,
      host: owner,
      call,
      signup,
      operator: operator!,
      member: member!,
      signedIn,
      grant,
      open,
      data,
      invitedMembership,
      request: (account: Account) => ({ headers: { cookie: account.cookie, origin } }) as IncomingMessage,
      addCleanup: (close: () => Promise<void>) => {
        privateOwners.push(close);
      },
    };
  }

  for (const sqliteAuth of [false, true])
    test(`private PG invitation HTTP uses genuine ${sqliteAuth ? 'SQLite' : 'PG'} auth and existing enrollment`, async (t) => {
      const f = await fixture(t, { publicInvitations: true, sqliteAuth });
      const path = (operation: string, query = '') => `/api/tenant/invitations/${operation}?app=${appId}${query}`;
      const identity = (account: Account) => ({ ...f.signedIn(account), 'x-mistri-app': appId });
      const issuerOpen = await f.call(path('open-issuer'), {}, identity(f.operator));
      assert.equal(issuerOpen.status, 200, issuerOpen.text);
      const issuer = { ...identity(f.operator), [INVITATION_HTTP_HEADER]: String(object(issuerOpen.body.session).context) };
      const noAdmin = await f.call(`/api/tenant/administration/open?app=${appId}`, {}, identity(f.operator));
      assert.equal(noAdmin.status, 200, noAdmin.text);
      assert.equal(noAdmin.body.session, null);
      const targets = await f.call(path('targets'), undefined, issuer);
      assert.equal(targets.status, 200, targets.text);
      assert.equal(object(targets.body.page).items instanceof Array, true);
      let sequence = 0;
      const intent = {
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: f.member.accountId,
        roles: ['member'],
        redeemUntil: Date.now() + 60_000,
        validUntil: Date.now() + 90_000,
      };
      for (const patch of [{ roles: ['outside-ceiling'] }, { tenantId: 'south' }]) {
        const reply = await f.call(path('execute'), { idempotencyKey: `bad-${++sequence}`, intent: { ...intent, ...patch } }, issuer);
        assert.ok(reply.status >= 400, reply.text);
      }
      const issued = await f.call(path('execute'), { idempotencyKey: `issue-${++sequence}`, intent }, issuer);
      assert.equal(issued.status, 200, issued.text);
      assert.equal(typeof issued.body.token, 'string');
      const pair = object(object(issued.body.result).change).after as InvitationPair;
      const pairIntent = (value: InvitationPair) => ({
        tenantId: 'north',
        expectedTenantVersion: '1',
        invitationId: value.invitation.invitationId,
        expectedInvitationVersion: value.invitation.version,
        membershipId: value.membership.membershipId,
        expectedMembershipVersion: value.membership.version,
      });
      const listed = await f.call(path('list', '&tenantId=north&operation=reissueInvitation'), undefined, issuer);
      assert.equal(listed.status, 200, listed.text);
      assert.doesNotMatch(listed.text, /digest/);
      assert.equal(listed.text.includes(String(issued.body.token)), false);
      const replaced = await f.call(
        path('execute'),
        {
          idempotencyKey: `reissue-${++sequence}`,
          intent: {
            ...pairIntent(pair),
            operation: 'reissueInvitation',
            roles: intent.roles,
            redeemUntil: intent.redeemUntil,
            validUntil: intent.validUntil,
          },
        },
        issuer,
      );
      assert.equal(replaced.status, 200, replaced.text);
      const next = object(object(replaced.body.result).change).after as InvitationPair;
      const revoked = await f.call(
        path('execute'),
        { idempotencyKey: `revoke-${++sequence}`, intent: { ...pairIntent(next), operation: 'revokeInvitation' } },
        issuer,
      );
      assert.equal(revoked.status, 200, revoked.text);
      const fresh = await f.call(path('execute'), { idempotencyKey: `issue-${++sequence}`, intent }, issuer);
      assert.equal(fresh.status, 200, fresh.text);
      const invitationId = invitationTokenId(String(fresh.body.token));
      const openRecipient = async (account: Account) => {
        const opened = await f.call(path('open-recipient'), { invitationId }, identity(account));
        assert.equal(opened.status, 200, opened.text);
        return { ...identity(account), [INVITATION_HTTP_HEADER]: String(object(opened.body.session).context) };
      };
      const unrelated = await openRecipient(f.operator);
      assert.ok((await f.call(path('preview'), { token: fresh.body.token }, unrelated)).status >= 400);
      const recipient = await openRecipient(f.member);
      assert.ok((await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, {}, identity(f.member))).status >= 400);
      const preview = await f.call(path('preview'), { token: fresh.body.token }, recipient);
      assert.equal(preview.status, 200, preview.text);
      assert.doesNotMatch(preview.text, /digest|inviterId|policyId/);
      const attempt = { idempotencyKey: `accept-${++sequence}`, intent: object(preview.body.preview).intent };
      const accepted = await f.call(path('execute'), { ...attempt, token: fresh.body.token }, recipient);
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(object(accepted.body.result).status, 'accepted');
      const recovered = await f.call(path('status'), attempt, recipient);
      assert.equal(recovered.status, 200, recovered.text);
      assert.equal(recovered.body.status, 'completed');
      assert.equal(Object.hasOwn(recovered.body, 'token'), false);
      const headers = await f.open(f.member);
      const rows = await f.data('/api/query', headers, { table: 'item' });
      assert.equal(rows.status, 200, rows.text);
      assert.ok(JSON.stringify(rows.body).includes('North item'));
      assert.ok(!JSON.stringify(rows.body).includes('South item'));
      if (!sqliteAuth) {
        await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId"=$1`, [f.operator.accountId]);
        assert.ok((await f.call(path('targets'), undefined, issuer)).status >= 400);
      }
    });

  test('private PG HTTP enrollment refuses absent invitation tables without provisioning', async (t) => {
    await assert.rejects(fixture(t, { publicInvitations: true, missingInvitations: true }));
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'mistri' AND c.relname LIKE 'invitation\\_%'",
        )
      ).rows[0].n,
      0,
    );
  });

  async function invitationOwner(t: TestContext) {
    const f = await fixture(t, { administration: true });
    await migratePostgresTenantInvitations(businessUrl, binding);
    let instant = Date.now();
    const options = {
      url: businessUrl,
      binding,
      auth: f.runtime,
      deployment: 'private-pg-invitation-owner',
      now: () => instant,
      invitations: {
        id: 'pg-inviters',
        version: '1',
        maxMembershipLifetimeMs: 120_000,
        maxRedemptionLifetimeMs: 90_000,
        maxPendingPerTenant: 10,
        operators: [{ accountId: f.operator.accountId, tenants: ['north'], roles: ['member'], operations: INVITATION_ISSUER_OPERATIONS }],
      },
    };
    // The enrolled host's own entry: PG business storage takes the async final
    // native checkpoint, with either auth store. No separate private entry.
    const owner = await openTenantAdministration(options);
    f.addCleanup(owner.retire);
    assert.ok(owner.invitations);
    const api = owner.invitations,
      issuerRequest = f.request(f.operator),
      recipientRequest = f.request(f.member);
    const opened = await api.openIssuer(issuerRequest, { expectedAccount: f.operator.accountId });
    assert.ok(opened);
    const issue = {
      expectedAccount: f.operator.accountId,
      context: opened.context,
      idempotencyKey: 'private-pg-issue',
      intent: {
        operation: 'issueInvitation' as const,
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: f.member.accountId,
        roles: ['member'],
        redeemUntil: instant + 60_000,
        validUntil: instant + 90_000,
      },
    };
    return {
      ...f,
      owner,
      api,
      issuerRequest,
      recipientRequest,
      issue,
      advance: (ms: number) => {
        instant += ms;
      },
    };
  }

  test('SQLite business invitations still refuse an asynchronous PostgreSQL auth store at the normal entry', async (t) => {
    const f = await fixture(t, { administration: true });
    assert.equal(captureAppAuthRuntime(f.runtime).synchronous, false);
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sqlite-business-pg-auth-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'business.db');
    new DatabaseSync(path).close();
    provisionSqliteTenantStore(path, binding);
    provisionSqliteTenantAdministrationJournal(path, binding);
    provisionSqliteTenantInvitations(path, binding);
    const common = { path, binding, auth: f.runtime, deployment: 'sqlite-business-pg-auth' };
    // SQLite's final verifier is synchronous: it has no awaitable native checkpoint.
    await assert.rejects(
      openTenantAdministration({
        ...common,
        invitations: {
          id: 'sqlite-inviters',
          version: '1',
          maxMembershipLifetimeMs: 120_000,
          maxRedemptionLifetimeMs: 90_000,
          maxPendingPerTenant: 10,
          operators: [{ accountId: f.operator.accountId, tenants: ['north'], roles: ['member'], operations: INVITATION_ISSUER_OPERATIONS }],
        },
      }),
    );
    // The same file and runtime without invitation policy is an ordinary owner.
    const owner = await openTenantAdministration({
      ...common,
      policy: {
        id: 'sqlite-operations',
        version: '1',
        maxMembershipLifetimeMs: 120_000,
        operators: [{ accountId: f.operator.accountId, tenants: ['north'], operations: ['grantMembership'], roles: ['member'] }],
      },
    });
    f.addCleanup(owner.retire);
    assert.equal(owner.invitations, undefined);
  });

  test('private PG invitation owner issues, accepts and recovers historical receipts without activation', async (t) => {
    const f = await invitationOwner(t);
    const issued = await f.api.execute(f.issuerRequest, f.issue);
    assert.ok(issued.token);
    const invitationId = invitationTokenId(issued.token);
    const opened = await f.api.openRecipient(f.recipientRequest, { expectedAccount: f.member.accountId, invitationId });
    const recipient = { expectedAccount: f.member.accountId, context: opened.context };
    const preview = await f.api.preview(f.recipientRequest, { ...recipient, token: issued.token });
    const acceptance = { ...recipient, idempotencyKey: 'private-pg-accept', intent: preview.intent };
    const accepted = await f.api.execute(f.recipientRequest, { ...acceptance, token: issued.token });
    assert.ok('status' in accepted.result);
    assert.equal(accepted.result.status, 'accepted');
    f.advance(100_000);
    const replay = await f.api.status(f.recipientRequest, acceptance);
    assert.equal(replay?.receiptId, accepted.result.receiptId);
    assert.equal(replay?.replayed, true);
    const issuerReplay = await f.api.status(f.issuerRequest, f.issue);
    assert.equal(issuerReplay?.receiptId, issued.result.receiptId);
    await f.owner.retire();
    await assert.rejects(f.api.status(f.recipientRequest, acceptance));
  });

  test('private PG invitation owner reissues and revokes paired reservations atomically', async (t) => {
    const f = await invitationOwner(t);
    const issued = await f.api.execute(f.issuerRequest, f.issue);
    assert.ok('change' in issued.result);
    const before = issued.result.change.after;
    const replaced = await f.api.execute(f.issuerRequest, {
      ...f.issue,
      idempotencyKey: 'private-pg-reissue',
      intent: {
        operation: 'reissueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        invitationId: before.invitation.invitationId,
        expectedInvitationVersion: before.invitation.version,
        membershipId: before.membership.membershipId,
        expectedMembershipVersion: before.membership.version,
        roles: ['member'],
        redeemUntil: f.issue.intent.redeemUntil,
        validUntil: f.issue.intent.validUntil,
      },
    });
    assert.ok('change' in replaced.result);
    assert.ok(replaced.token);
    const next = replaced.result.change.after;
    assert.notEqual(next.invitation.invitationId, before.invitation.invitationId);
    const request = {
      ...f.issue,
      idempotencyKey: 'private-pg-revoke',
      intent: {
        operation: 'revokeInvitation' as const,
        tenantId: 'north',
        expectedTenantVersion: '1',
        invitationId: next.invitation.invitationId,
        expectedInvitationVersion: next.invitation.version,
        membershipId: next.membership.membershipId,
        expectedMembershipVersion: next.membership.version,
      },
    };
    const revoked = await f.api.execute(f.issuerRequest, request);
    assert.equal(revoked.token, undefined);
    assert.deepEqual((await control.query(`SELECT status FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)}`)).rows, [
      { status: 'revoked' },
      { status: 'revoked' },
    ]);
    assert.deepEqual((await control.query('SELECT status FROM mistri."tenant_membership"')).rows, [
      { status: 'revoked' },
      { status: 'revoked' },
    ]);
    f.advance(100_000);
    assert.equal((await f.api.status(f.issuerRequest, request))?.receiptId, revoked.result.receiptId);
  });

  for (const change of ['session', 'inviter', 'recipient', 'abort', 'expiry', 'retire'] as const)
    test(`private PG invitation final attestation ${change} loss rolls back all durable effects`, async (t) => {
      const f = await invitationOwner(t);
      const original = PostgresAdapter.prototype.runtimeMaintenanceTransaction;
      let injected = false;
      t.mock.method(PostgresAdapter.prototype, 'runtimeMaintenanceTransaction', function <
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
              if (change === 'abort') f.issuerRequest.aborted = true;
              else if (change === 'expiry') f.advance(100_000);
              else if (change === 'retire') void f.owner.retire();
              else if (change === 'session') await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId"=$1`, [f.operator.accountId]);
              else
                await auth.query(`DELETE FROM ${S}.auth_user WHERE id=$1`, [
                  change === 'inviter' ? f.operator.accountId : f.member.accountId,
                ]);
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
      await assert.rejects(f.api.execute(f.issuerRequest, f.issue), (error) => {
        assert.equal((error as { outcome?: string }).outcome, 'not_applied');
        return true;
      });
      assert.equal(injected, true);
      for (const table of [INVITATION_TABLES.invitation, '__mistri_tenant_membership', administrationJournal.receipt]) {
        assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', table)}`)).rows[0].n, 0);
      }
      // Final sequential native observations, not atomic cross-database revocation.
    });

  test('startup takes a postgres:// auth store beside a PostgreSQL source, and a real session reads, writes and runs commands', async (t) => {
    const f = await fixture(t);
    assert.equal(captureAppAuthRuntime(f.runtime).synchronous, false, 'the binding reads this store asynchronously');
    await f.grant(f.member);
    const context = await f.open(f.member);
    const rows = await f.data('/api/query', context, { table: 'item' });
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(rows.body.rows, [{ id: 'north-item', business_id: 'same', name: 'North item' }]);
    const edited = await f.data('/api/update', context, { table: 'item', key: { id: 'north-item' }, values: { name: 'Edited' } });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(await itemName('north-item'), 'Edited');
    const advanced = await f.data('/api/commands/execute', context, {
      command: 'advance',
      commandVersion: 1,
      key: { id: 'north-task' },
      expectedVersion: 0,
      idempotencyKey: 'pg-auth-command-0001',
      input: {},
    });
    assert.equal(advanced.status, 200, advanced.text);
    assert.equal(advanced.body.status, 'applied');
    assert.equal(await taskVersion('north-task'), 1);
  });

  for (const [change, sql] of [
    [
      'impersonation provenance on the stored session',
      `UPDATE ${S}.auth_session SET "impersonatedBy" = 'deployment-operator' WHERE "userId" = $1`,
    ],
    ['a ban on the account', `UPDATE ${S}.auth_user SET banned = true WHERE id = $1`],
    ['the session ending', `UPDATE ${S}.auth_session SET "expiresAt" = now() - interval '1 second' WHERE "userId" = $1`],
    ['a sign-out elsewhere', `DELETE FROM ${S}.auth_session WHERE "userId" = $1`],
  ] as const) {
    test(`${change} refuses the next tenant read and write, and a new context`, async (t) => {
      const f = await fixture(t);
      await f.grant(f.member);
      const context = await f.open(f.member);
      assert.equal((await f.data('/api/query', context, { table: 'item' })).status, 200);
      await auth.query(sql, [f.member.accountId]);
      refused(await f.data('/api/query', context, { table: 'item' }));
      refused(await f.data('/api/update', context, { table: 'item', key: { id: 'north-item' }, values: { name: 'After' } }));
      refused(await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, {}, f.signedIn(f.member)));
      assert.equal(await itemName('north-item'), 'North item');
    });
  }

  test("the pre-commit window: a sign-out during a command's callback refuses its commit; one after COMMIT leaves it applied", async (t) => {
    const f = await fixture(t);
    await f.grant(f.member);
    const context = await f.open(f.member),
      entered = gate(),
      release = gate();
    hold.__tablewalkTenantAuthHold = async () => {
      entered.release();
      await release.promise;
    };
    t.after(() => {
      delete hold.__tablewalkTenantAuthHold;
      release.release();
    });
    const body = {
      command: 'advance',
      commandVersion: 1,
      key: { id: 'north-task' },
      expectedVersion: 0,
      idempotencyKey: 'pg-auth-window-0001',
      input: {},
    };
    const pending = f.data('/api/commands/execute', context, body);
    await entered.promise;
    // The handler has written and holds the transaction open; the session ends now.
    await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId" = $1`, [f.member.accountId]);
    release.release();
    const refusedCommand = await pending;
    assert.ok(refusedCommand.status >= 400 || refusedCommand.body.status !== 'applied', refusedCommand.text);
    assert.equal(await taskVersion('north-task'), 0, 'the business effect rolled back');
    assert.equal(await receipts(), 0);
    delete hold.__tablewalkTenantAuthHold;

    // After COMMIT the write stands; the revocation refuses what follows.
    const login = await f.call('/api/auth/sign-in/email', { email: f.member.email, password });
    assert.equal(login.status, 200, login.text);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const fresh = await f.open({ ...f.member, cookie });
    const applied = await f.data('/api/commands/execute', fresh, { ...body, idempotencyKey: 'pg-auth-window-0002' });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.status, 'applied');
    await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId" = $1`, [f.member.accountId]);
    assert.equal(await taskVersion('north-task'), 1);
    assert.equal(await receipts(), 1);
    refused(await f.data('/api/commands/status', fresh, { ...body, idempotencyKey: 'pg-auth-window-0002' }));
  });

  test("administration observes the operator's admission session and the target account in the PostgreSQL store", async (t) => {
    const f = await fixture(t, { administration: true });
    const root = (operation: string, query = '') => `/api/tenant/administration/${operation}?app=${appId}${query}`;
    const identity = { ...f.signedIn(f.operator), 'x-mistri-app': appId };
    const opened = await f.call(root('open'), {}, identity);
    assert.equal(opened.status, 200, opened.text);
    const operating = { ...identity, [ADMINISTRATION_HTTP_HEADER]: String(object(opened.body.session).context) };
    const grant = (account: string, key: string) =>
      f.call(
        root('execute'),
        {
          idempotencyKey: key,
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: account,
            roles: ['member'],
            validUntil: Date.now() + 90_000,
          },
        },
        operating,
      );
    const granted = await grant(f.member.accountId, 'pg-auth-admin-grant');
    assert.equal(granted.status, 200, granted.text);
    assert.equal(granted.body.outcome, 'applied');
    // An account the store does not hold cannot receive a membership.
    const missing = await grant('00000000-0000-4000-8000-000000000000', 'pg-auth-admin-missing');
    assert.ok(missing.status >= 400, missing.text);
    // A session shortened after the context opened refuses, as on the file store.
    await auth.query(`UPDATE ${S}.auth_session SET "expiresAt" = now() + interval '1 hour' WHERE "userId" = $1`, [f.operator.accountId]);
    const shortened = await f.call(root('tenants'), undefined, operating);
    assert.ok(shortened.status >= 400, shortened.text);
    // So does a ban, on a freshly opened context.
    await auth.query(`UPDATE ${S}.auth_session SET "expiresAt" = now() + interval '7 days' WHERE "userId" = $1`, [f.operator.accountId]);
    const reopened = await f.call(root('open'), {}, identity);
    assert.equal(reopened.status, 200, reopened.text);
    const again = { ...identity, [ADMINISTRATION_HTTP_HEADER]: String(object(reopened.body.session).context) };
    await auth.query(`UPDATE ${S}.auth_user SET banned = true WHERE id = $1`, [f.operator.accountId]);
    assert.ok((await f.call(root('tenants'), undefined, again)).status >= 400);
    const members = (await control.query(`SELECT account_id FROM mistri."tenant_membership" WHERE status = 'active'`)).rows;
    assert.deepEqual(members, [{ account_id: f.member.accountId }]);
  });

  test('administration without invitation policy atomically revokes an existing PG invitation pair', async (t) => {
    const f = await fixture(t, { administration: true, invitationStorage: true });
    const path = (operation: string) => `/api/tenant/administration/${operation}?app=${appId}`;
    const identity = { ...f.signedIn(f.operator), 'x-mistri-app': appId };
    const opened = await f.call(path('open'), {}, identity);
    assert.equal(opened.status, 200, opened.text);
    const headers = { ...identity, [ADMINISTRATION_HTTP_HEADER]: String(object(opened.body.session).context) };
    const reply = await f.call(
      path('execute'),
      {
        idempotencyKey: 'revoke-policy-disabled-invitation',
        intent: {
          operation: 'revokeMembership',
          tenantId: 'north',
          expectedTenantVersion: '1',
          membershipId: f.invitedMembership,
          expectedMembershipVersion: '1',
        },
      },
      headers,
    );
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body.outcome, 'applied');
    assert.deepEqual((await control.query(`SELECT status,version FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)}`)).rows, [
      { status: 'revoked', version: '2' },
    ]);
    assert.deepEqual((await control.query('SELECT status,version FROM mistri."tenant_membership"')).rows, [
      { status: 'revoked', version: '2' },
    ]);
  });

  for (const present of [false, true])
    test(`administration refuses invitation storage ${present ? 'disappearance' : 'appearance'} after acquisition`, async (t) => {
      const f = await fixture(t, { administration: true, invitationStorage: present });
      const path = (operation: string) => `/api/tenant/administration/${operation}?app=${appId}`;
      const identity = { ...f.signedIn(f.operator), 'x-mistri-app': appId };
      const opened = await f.call(path('open'), {}, identity);
      assert.equal(opened.status, 200, opened.text);
      const headers = { ...identity, [ADMINISTRATION_HTTP_HEADER]: String(object(opened.body.session).context) };
      if (present) {
        await control.query(
          `DROP TABLE ${runtimeTable('postgres', INVITATION_TABLES.invitation)}, ${runtimeTable('postgres', INVITATION_TABLES.meta)}`,
        );
      } else await migratePostgresTenantInvitations(businessUrl, binding);
      const reply = await f.call(path('tenants'), undefined, headers);
      assert.ok(reply.status >= 400, reply.text);
    });

  for (const change of ['session', 'target'] as const)
    test(`administration final attestation ${change} loss refuses before COMMIT`, async (t) => {
      const f = await fixture(t, { administration: true });
      const path = (operation: string) => `/api/tenant/administration/${operation}?app=${appId}`;
      const identity = { ...f.signedIn(f.operator), 'x-mistri-app': appId };
      const opened = await f.call(path('open'), {}, identity);
      assert.equal(opened.status, 200, opened.text);
      const headers = { ...identity, [ADMINISTRATION_HTTP_HEADER]: String(object(opened.body.session).context) };
      const original = PostgresAdapter.prototype.runtimeMaintenanceTransaction;
      let injected = false;
      t.mock.method(PostgresAdapter.prototype, 'runtimeMaintenanceTransaction', function <
        T,
      >(this: PostgresAdapter, verify: (client: PgQuery) => Promise<void>, work: (client: PgQuery, operations: TransactionOperations, current: () => void) => Promise<T>): Promise<T> {
        let completed = false;
        const forwarded = (client: PgQuery): PgQuery => {
          function query(text: string, args?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
          function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
          async function query(input: string | { text: string; values?: unknown[]; rowMode?: string }, args?: unknown[]) {
            const result = await (typeof input === 'string' ? client.query(input, args) : client.query(input));
            // Real storage attestation has yielded AFTER mutation work completed.
            // Change the separate native auth DB; never replace auth observations.
            if (completed && !injected) {
              injected = true;
              if (change === 'session') await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId"=$1`, [f.operator.accountId]);
              else await auth.query(`DELETE FROM ${S}.auth_user WHERE id=$1`, [f.member.accountId]);
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
      const reply = await f.call(
        path('execute'),
        {
          idempotencyKey: `final-attestation-${change}`,
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: f.member.accountId,
            roles: ['member'],
            validUntil: Date.now() + 90_000,
          },
        },
        headers,
      );
      assert.equal(injected, true, 'race must occur inside final native storage attestation');
      assert.ok(reply.status >= 400, reply.text);
      assert.equal(reply.body.outcome, 'not_applied');
      for (const table of ['__mistri_tenant_membership', administrationJournal.receipt]) {
        assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', table)}`)).rows[0].n, 0);
      }
      // Final-observation guarantee only, not an atomic auth/business transaction.
    });

  /**
   * Every statement this process sends the App's auth store, as its pool's
   * clients send them, from now until the test ends; the test's own client is
   * not counted, nor a new connection's setup (`SET search_path …`).
   */
  async function authStatements(t: TestContext) {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: { prototype: PgQuery } }; Client?: { prototype: PgQuery } };
    const prototype = (pg.Client ?? pg.default!.Client).prototype as PgQuery & Record<string, unknown>;
    const original = prototype.query;
    const database = new URL(authUrl).pathname.slice(1);
    const seen: string[] = [];
    prototype.query = function (this: { database?: string }, request: unknown, ...rest: unknown[]) {
      const text = typeof request === 'string' ? request : (request as { text?: string } | null)?.text;
      if (this !== (auth as unknown) && this.database === database && text !== undefined && !text.startsWith('SET ')) seen.push(text);
      return (original as (...given: unknown[]) => unknown).call(this, request, ...rest);
    } as PgQuery['query'];
    t.after(() => {
      prototype.query = original;
    });
    return {
      /** What was sent since the last take. */
      take: () => seen.splice(0),
    };
  }

  test('a signed-in read costs the auth store at most two statements cold and none warm, and a page-like burst of sixteen no more', async (t) => {
    const f = await fixture(t, { keptSessions: '3' });
    await f.grant(f.member);
    const context = await f.open(f.member);
    const sent = await authStatements(t);
    const read = async () => {
      const reply = await f.data('/api/query', context, { table: 'item' });
      assert.equal(reply.status, 200, reply.text);
    };
    // Cold: Better Auth reads the session by its token and then its account; every observation after it is that read.
    await sleep(3_100);
    sent.take();
    await read();
    const cold = sent.take();
    assert.ok(cold.length <= 2, `cold: ${cold.length}\n${cold.join('\n')}`);
    // Warm: nothing at all.
    await read();
    await read();
    assert.deepEqual(sent.take(), []);
    // A page's burst, arriving cold together, reads once between them.
    await sleep(3_100);
    sent.take();
    await Promise.all(Array.from({ length: 16 }, read));
    const burst = sent.take();
    assert.ok(burst.length <= 2, `burst: ${burst.length}\n${burst.join('\n')}`);
  });

  test('with nothing kept, a signed-in read observes the store at every fence, as before the cache', async (t) => {
    const f = await fixture(t);
    await f.grant(f.member);
    const context = await f.open(f.member);
    const sent = await authStatements(t);
    assert.equal((await f.data('/api/query', context, { table: 'item' })).status, 200);
    // The session and its account, then the session again at each fence: the cost a field report measured.
    assert.ok(sent.take().length > 2);
  });

  test('a sign-out in this process is refused at once, inside what was kept', async (t) => {
    const f = await fixture(t, { keptSessions: undefined });
    await f.grant(f.member);
    const context = await f.open(f.member);
    assert.equal((await f.data('/api/query', context, { table: 'item' })).status, 200);
    const out = await f.call('/api/auth/sign-out', {}, f.signedIn(f.member));
    assert.equal(out.status, 200, out.text);
    refused(await f.data('/api/query', context, { table: 'item' }));
    refused(await f.data('/api/update', context, { table: 'item', key: { id: 'north-item' }, values: { name: 'After' } }));
    refused(await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, {}, f.signedIn(f.member)));
    assert.equal(await itemName('north-item'), 'North item');
  });

  test("a sign-out in this process during a command's callback refuses its commit, inside what was kept", async (t) => {
    const f = await fixture(t, { keptSessions: undefined });
    await f.grant(f.member);
    const context = await f.open(f.member),
      entered = gate(),
      release = gate();
    hold.__tablewalkTenantAuthHold = async () => {
      entered.release();
      await release.promise;
    };
    t.after(() => {
      delete hold.__tablewalkTenantAuthHold;
      release.release();
    });
    const pending = f.data('/api/commands/execute', context, {
      command: 'advance',
      commandVersion: 1,
      key: { id: 'north-task' },
      expectedVersion: 0,
      idempotencyKey: 'pg-auth-kept-window-0001',
      input: {},
    });
    await entered.promise;
    const out = await f.call('/api/auth/sign-out', {}, f.signedIn(f.member));
    assert.equal(out.status, 200, out.text);
    release.release();
    const answer = await pending;
    assert.ok(answer.status >= 400 || answer.body.status !== 'applied', answer.text);
    assert.equal(await taskVersion('north-task'), 0, 'the business effect rolled back');
    assert.equal(await receipts(), 0);
  });

  test('a sign-out elsewhere is refused here once what was kept expires', async (t) => {
    const f = await fixture(t, { keptSessions: '1' });
    await f.grant(f.member);
    const context = await f.open(f.member);
    assert.equal((await f.data('/api/query', context, { table: 'item' })).status, 200);
    // Another process ends the session: this one may answer from what it kept for at most the TTL.
    await auth.query(`DELETE FROM ${S}.auth_session WHERE "userId" = $1`, [f.member.accountId]);
    await sleep(1_100);
    refused(await f.data('/api/query', context, { table: 'item' }));
  });
});
