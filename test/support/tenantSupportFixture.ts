/**
 * A lender's tenant host with audited support ("enter as dealer"), on SQLite
 * or on a live PostgreSQL database this fixture owns (named by a UUID and
 * dropped after), over genuine native auth in a SQLite auth file.
 *
 * Dealers: north and south active, parkside suspended. Accounts: Olivia is a
 * platform reviewer (may enter north and parkside as dealer_staff), Avery a
 * platform lender_admin (every active dealer, as dealer_admin or
 * dealer_staff), Sam north's own dealer_staff, Oscar nothing. Every session a
 * test changes is changed in the native store itself — its age, its expiry,
 * an impersonation — never by a stand-in proof.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import type { LoadedApp } from '../../packages/mistri/src/server/app/apps.js';
import {
  captureAppAuthRuntime,
  createAppAuth,
  createSuiteAppAuth,
  type AppAuthRuntime,
} from '../../packages/mistri/src/server/auth/auth.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../../packages/mistri/src/server/auth/suiteGrantStore.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { provisionSqliteTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { migratePostgresTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { openTenantSupport, type TenantSupport } from '../../packages/mistri/src/server/tenant/tenantSupportOperations.js';
import { provisionSqliteSupportAudit, verifySqliteSupportAudit } from '../../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from '../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  migratePostgresSupportAudit,
  verifyPostgresSupportAudit,
} from '../../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';
import type { FederatedProviderConfig } from '../../packages/mistri/src/server/auth/identityConfig.js';
import type { ScimDirectoryConfig } from '../../packages/mistri/src/server/auth/scimConfig.js';
import type { EmbedIssuerConfig } from '../../packages/mistri/src/server/embed/issuerConfig.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../../packages/mistri/src/shared/tenantContext.js';
import { pgClient, uuidPostgresDatabase, type Control, type TenantDialect } from './tenantDialects.js';
import { postgresRuntimeSql } from './runtimeSql.js';

export const SUPPORT_SECRET = 'synthetic-support-audit-key-at-least-thirty-two-bytes';
export const appId = 'lending-support';
export const binding = { appId, source: { id: 'business', connection: 'support-business' }, storeId: 'support-store' };
export const SUPPORT_POLICY = {
  id: 'lender-support',
  version: '1',
  grants: [
    { platformRole: 'reviewer', tenants: ['north', 'parkside'], dealerRoles: ['dealer_staff'] },
    { platformRole: 'lender_admin', tenants: 'all' as const, dealerRoles: ['dealer_admin', 'dealer_staff'] },
  ],
};
const ROLES = ['reviewer', 'lender_admin', 'dealer_admin', 'dealer_staff'];

export function supportManifest(authStore: string) {
  return {
    id: appId,
    name: 'Lending support',
    sources: { business: { connection: binding.source.connection } },
    resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
    auth: {
      store: authStore,
      signUp: 'open',
      rows: 'tenant',
      tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
      roles: {
        reviewer: { realm: 'platform', read: true },
        lender_admin: { realm: 'platform', read: true },
        dealer_admin: { realm: 'tenant', read: true, write: ['lead'] },
        dealer_staff: { realm: 'tenant', read: true },
      },
    },
    views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
    nav: [
      { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
      { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
    ],
    home: 'leads',
  };
}
const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0);`,
  postgres: `CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL,
      version integer NOT NULL DEFAULT 0);`,
  rows: `INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto'), ('parkside', 'Parkside Cars');
    INSERT INTO lead (id, tenant_id, name) VALUES ('n1', 'north', 'North lead'), ('s1', 'south', 'South lead');`,
};

export interface Account {
  name: string;
  email: string;
  password: string;
  accountId: string;
  cookie: string;
}
export interface Answer {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}
export interface FixtureOptions {
  readonly sharedIdentity?: boolean;
  /** The support policy, as a tenant policy's `support` block. */
  readonly policy?: unknown;
  /** Replace the manifest before the App parses it. */
  readonly manifest?: (raw: ReturnType<typeof supportManifest>) => void;
  /** The config file's identity providers (kind "oidc" or "saml"). */
  readonly identity?: readonly FederatedProviderConfig[];
  /** The config file's hosts that sign people in (kind "embed"), given the origin the fixture serves on. */
  readonly embed?: (origin: string) => readonly EmbedIssuerConfig[];
  /** The config file's SCIM directories (kind "scim"). */
  readonly scim?: readonly ScimDirectoryConfig[];
  /** More of the tenant policy (administration, assistant), read at each start so it can name accounts a test signed up. */
  readonly tenantPolicy?: Record<string, unknown>;
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
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export async function tenantSupportFixture(t: TestContext, dialect: TenantDialect, options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-support-'));
  const authPath = join(directory, 'auth.db'),
    path = join(directory, 'business.db');
  const key = supportAuditKey(SUPPORT_SECRET);
  const environment = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD', SUPPORT_AUDIT_KEY_VARIABLE].map(
    (name) => [name, process.env[name]] as const,
  );
  process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-support-secret-at-least-thirty-two-characters';
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = SUPPORT_SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let db: DatabaseSync | undefined, control: Control | undefined, database: { url: string; drop: () => Promise<void> } | undefined;
  let host: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined, auth: AppAuthRuntime | undefined;
  let authDb: DatabaseSync | undefined;
  let nativeAuth: AppAuthRuntime | undefined;
  const grantDb = options.sharedIdentity ? new DatabaseSync(join(directory, 'grants.db')) : undefined;
  if (grantDb) provisionSuiteGrantStore(grantDb, 'support-suite');
  const grants = grantDb ? openSuiteGrantStore(grantDb, 'support-suite') : undefined;
  /** Owners this fixture handed out, retired before their stores close. */
  const owners: TenantSupport[] = [];
  t.after(async () => {
    try {
      // A handed-out owner holds its own writer: retire it before the stores go.
      await Promise.allSettled(owners.map((created) => created.retire()));
      if (host) {
        host.server.closeAllConnections();
        await host.retire();
      } else auth?.close();
    } finally {
      nativeAuth?.close();
      grantDb?.close();
      authDb?.close();
      db?.close();
      await control?.end().catch(() => {});
      await database?.drop();
      rmSync(directory, { recursive: true, force: true });
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  if (dialect === 'sqlite') {
    db = new DatabaseSync(path);
    db.exec(SCHEMA.sqlite + SCHEMA.rows);
    provisionSqliteTenantStore(path, binding);
    provisionSqliteTenantAdministrationJournal(path, binding);
    provisionSqliteSupportAudit(path, binding, key);
  } else {
    database = await uuidPostgresDatabase('support');
    control = await pgClient(database.url);
    await control.query(SCHEMA.postgres);
    await control.query(SCHEMA.rows.replaceAll('INTO dealer', 'INTO public.dealer').replaceAll('INTO lead', 'INTO public.lead'));
    await migratePostgresTenantStore(database.url, binding);
    await migratePostgresTenantAdministrationJournal(database.url, binding);
    await migratePostgresSupportAudit(database.url, binding, key);
  }
  const rows = async (sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> =>
    dialect === 'sqlite'
      ? db!
          .prepare(sql)
          .all(...(params as never[]))
          .map((row) => ({ ...row }))
      : (await control!.query(postgresRuntimeSql(numbered(sql)), [...params])).rows.map((row) => ({ ...row }));
  const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    const operations = new TransactionOperations();
    if (dialect === 'sqlite') {
      db!.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db!, operations, binding));
        await operations.finish();
        db!.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db!.isTransaction) db!.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    await control!.query('BEGIN');
    try {
      await run(createPostgresTenantAdministration(control!, operations, binding));
      await operations.finish();
      await control!.query('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      await control!.query('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south', 'parkside']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putTenant({ tenantId: 'parkside', status: 'suspended', expectedVersion: '1' });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });

  // A restart takes a fresh port: fetch would otherwise reuse a keep-alive
  // socket the retired host already destroyed.
  let port = await reservePort(),
    origin = `http://127.0.0.1:${port}`;
  const raw = supportManifest(authPath);
  options.manifest?.(raw);
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    dir: directory,
    pages: [],
    sources: {},
    app: parseAppConfig(raw, 'tenant support fixture'),
  };
  const policyOf = () =>
    defineAppTenantPolicy({
      kind: 'tenant',
      appId,
      storeId: binding.storeId,
      ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: () => ({ lead: true }),
      resolveRows: () => ({ lead: true }),
      resolvePlatformRows: () => ({ dealer: true, lead: true }),
      support: (options.policy ?? SUPPORT_POLICY) as never,
      ...options.tenantPolicy,
    });
  const clock = { offset: 0 };
  let generation = 0;
  const start = async () => {
    nativeAuth = await createAppAuth(options.sharedIdentity ? { ...loaded, app: { ...loaded.app, id: 'support-suite' } } : loaded, {
      baseURL: origin,
      trustedOrigins: [origin],
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.embed ? { embed: options.embed(origin) } : {}),
      ...(options.scim ? { scim: options.scim } : {}),
    });
    auth = grants
      ? createSuiteAppAuth(nativeAuth, { appId, spec: loaded.app.auth!, roles: ROLES, basePath: '', suiteBase: '', grant: grants.read })
      : nativeAuth;
    authDb?.close();
    authDb = new DatabaseSync(authPath);
    host = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      bound: { host: '127.0.0.1', port },
      enrollment: {
        policy: policyOf(),
        source: { ...binding.source, ...(dialect === 'sqlite' ? { existingPath: path } : { url: database!.url }) },
        deployment: `support-generation-${++generation}`,
        roles: ROLES,
        maxLifetimeMs: 300000,
        now: () => Date.now() + clock.offset,
      },
    });
    host.server.listen(port, '127.0.0.1');
    await once(host.server, 'listening');
  };
  await start();
  /** Retire the host and its native runtime, then start both again on the same stores. */
  const restart = async () => {
    const previous = host!;
    host = undefined;
    previous.server.closeAllConnections();
    await previous.retire();
    nativeAuth?.close();
    port = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    await start();
  };

  const call = async (
    target: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Answer> => {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const response = await fetch(origin + target, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { origin, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const signIn = async (email: string, password: string) => {
    const reply = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(reply.status, 200);
    return reply.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  const signup = async (name: string, handle: string): Promise<Account> => {
    const email = `${handle}@example.test`,
      password = `tenant-support-${handle}-password-123`;
    const created = await call('/api/auth/sign-up/email', { body: { name, email, password } });
    assert.equal(created.status, 200, created.text);
    if (grants)
      grants.change({
        appId,
        subjectId: (created.body.user as { id: string }).id,
        actorId: 'operator',
        roles: ['reviewer'],
        declaredRoles: ROLES,
        expectedRevision: 0,
      });
    return { name, email, password, accountId: (created.body.user as { id: string }).id, cookie: await signIn(email, password) };
  };
  const accounts = {
    olivia: await signup('Olivia Operator', 'olivia'),
    avery: await signup('Avery Admin', 'avery'),
    sam: await signup('Sam Staff', 'sam'),
    oscar: await signup('Oscar Outsider', 'oscar'),
  };
  const hour = Date.now() + 3600000;
  await maintenance(async (admin) => {
    await admin.putPlatformMembership({
      accountId: accounts.olivia.accountId,
      membershipId: 'platform-olivia',
      status: 'active',
      roles: ['reviewer'],
      validUntil: hour,
      expectedVersion: null,
    });
    await admin.putPlatformMembership({
      accountId: accounts.avery.accountId,
      membershipId: 'platform-avery',
      status: 'active',
      roles: ['lender_admin'],
      validUntil: hour,
      expectedVersion: null,
    });
    await admin.putMembership({
      tenantId: 'north',
      accountId: accounts.sam.accountId,
      membershipId: 'north-sam',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil: hour,
      expectedVersion: null,
    });
  });

  const proof = async (cookie: string) => {
    const found = await captureAppAuthRuntime(auth!).sessionInstance({ headers: { cookie } } as IncomingMessage);
    assert.ok(found);
    return found;
  };
  /** Change a login in the native store, as time or an administrator would. */
  const native = {
    age: async (cookie: string, ms: number) => {
      authDb!
        .prepare('UPDATE session SET createdAt = ? WHERE id = ?')
        .run(new Date(Date.now() - ms).toISOString(), (await proof(cookie)).sessionId);
    },
    expire: async (cookie: string, at: number) => {
      authDb!.prepare('UPDATE session SET expiresAt = ? WHERE id = ?').run(new Date(at).toISOString(), (await proof(cookie)).sessionId);
    },
    impersonate: async (cookie: string, by: string) => {
      authDb!.prepare('UPDATE session SET impersonatedBy = ? WHERE id = ?').run(by, (await proof(cookie)).sessionId);
    },
  };
  const support = (
    who: Pick<Account, 'accountId' | 'cookie'>,
    operation: 'open' | 'exit' | 'status',
    body: Record<string, unknown> = {},
    extra: Record<string, string> = {},
  ) =>
    call(`/api/tenant/support/${operation}?app=${appId}`, {
      body,
      headers: { cookie: who.cookie, [headers.account]: who.accountId, ...extra },
    });
  let attempts = 0;
  const open = (
    who: Pick<Account, 'accountId' | 'cookie'>,
    tenantId: string,
    dealerRole: string,
    idempotencyKey = `open-${++attempts}`,
    reason = 'Checking a stuck application',
  ) => support(who, 'open', { idempotencyKey, intent: { operation: 'openSupport', tenantId, dealerRole, reason } });
  const exit = (
    who: Pick<Account, 'accountId' | 'cookie'>,
    session: { tenantId: string; supportId: string; version: string },
    idempotencyKey = `exit-${++attempts}`,
  ) =>
    support(who, 'exit', {
      idempotencyKey,
      intent: {
        operation: 'exitSupport',
        tenantId: session.tenantId,
        supportId: session.supportId,
        expectedSupportVersion: session.version,
      },
    });
  /** A request on a lease, as a tab holding it sends one. */
  const onLease = (
    who: Pick<Account, 'accountId' | 'cookie'>,
    lease: TenantContextReply,
    target: string,
    body: unknown = {},
    selector: Record<string, string> = { tenant: lease.tenantId },
  ) =>
    call(`${target}?${new URLSearchParams({ app: appId, ...selector })}`, {
      body,
      headers: {
        cookie: who.cookie,
        [headers.account]: who.accountId,
        [headers.tab]: lease.tabId,
        [headers.context]: lease.context,
        [headers.revision]: String(lease.revision),
      },
    });
  const verifyAudit = () =>
    dialect === 'sqlite'
      ? Promise.resolve(verifySqliteSupportAudit(path, binding, key))
      : verifyPostgresSupportAudit(database!.url, binding, key);
  /** A support owner on these same stores, for the owner methods no HTTP route
   * reaches — the read ledger. The host builds its own internally and keeps it
   * private; this is built the same way, from the same native runtime, binding,
   * key and policy, and is retired with the fixture. Its deployment differs,
   * which nothing the ledger checks depends on. */
  const owner = async (): Promise<TenantSupport> => {
    const created = await openTenantSupport({
      ...(dialect === 'sqlite' ? { path } : { url: database!.url }),
      binding,
      auth: auth!,
      app: loaded.app,
      policy: (options.policy ?? SUPPORT_POLICY) as never,
      key,
      deployment: 'support-owner-for-tests',
      now: () => Date.now() + clock.offset,
    });
    owners.push(created);
    return created;
  };
  /** A request as a tab sends one: the native login's cookie and nothing else. */
  const asLogin = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
  return {
    dialect,
    path,
    url: database?.url ?? '',
    // A restart takes a fresh port, so the origin is read when asked for.
    get origin() {
      return origin;
    },
    accounts,
    clock,
    key,
    rows,
    maintenance,
    restart,
    call,
    signIn,
    native,
    support,
    open,
    exit,
    onLease,
    verifyAudit,
    proof,
    owner,
    asLogin,
    grants,
    auth: () => auth!,
    authDb: () => authDb!,
    businessDb: () => db,
    control: () => control,
  };
}
export type SupportFixture = Awaited<ReturnType<typeof tenantSupportFixture>>;
