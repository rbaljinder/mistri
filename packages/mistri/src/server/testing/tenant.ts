/**
 * A tenant App's people in a test: a member signed in and working in one tenant, or a platform member in the
 * platform realm, each a client whose every App request rides the lease the browser opens and asserts it as the
 * browser does (client/tenantTransport.ts): the App and the tenant (or the realm) in the query, the lease's tab,
 * context and revision in its headers, never the App in a body. A test names the tenant and the roles; the header
 * names and the lease are the kit's.
 *
 * The membership is setup, made as an operator makes one (http/testControl.ts): what the test then asserts goes
 * through the App's own doors, under the server's isolation, as a person's would.
 */
import { randomBytes } from 'node:crypto';
import { PLATFORM_TENANT_ID, TENANT_HTTP_HEADERS } from '../../shared/tenantContext.js';
import { SUPPORT_LOG_PATH, SUPPORT_SESSIONS_PATH } from '../../shared/tenantSupportLog.js';
import { appRequests } from './appRequests.js';
import { createTestClient, type TestClient, type TestRequest } from './client.js';
import type { TestResult } from './appRequests.js';

/** Who a tenant test client is: the roles of its membership, and its account's address and name where a test says. */
export interface TestTenantAccount {
  roles: readonly string[];
  email?: string;
  name?: string;
}
/** The lease a tenant test client holds, as the server granted it. */
export interface TestTenantLease {
  appId: string;
  accountId: string;
  tenantId: string;
  /** `support` for a platform member's visit into a tenant (`support`). */
  realm: 'tenant' | 'platform' | 'support';
  tabId: string;
  context: string;
  revision: number;
}
export type TestTenantClient = TestClient & {
  /** The member's account, made for this client: a test signs it in again with these. */
  account: { accountId: string; email: string; password: string };
  lease: TestTenantLease;
  /**
   * Asks for another tenant's lease (or the platform's, `@platform`) under this same session, as a person who
   * changed the address would: what the server answers, and the lease when it grants one. This client keeps the
   * lease it holds.
   */
  enter(tenantId: string): Promise<TestResult<TestTenantLease>>;
  /**
   * Whether this member reaches one record of the tenant it works in, as the record page's reads ask: ok when the
   * record is the tenant's, and a refusal with code `not_found` when it is another tenant's or none at all, the two
   * never told apart.
   */
  record(table: string, key: Record<string, string | number>): Promise<TestResult<unknown>>;
  /**
   * A platform member's support visit into one tenant (the policy's `support.grants`): opened with the reason and the
   * dealer role it is assumed in, on a new lease of that tenant that reads as the role does and writes nothing. What
   * the server answers, and the visit when it opens one. This client keeps the lease it holds.
   */
  support(tenantId: string, visit: { role: string; reason: string }): Promise<TestResult<TestSupportVisit>>;
};

const selector = (tenantId: string): Record<string, string> =>
  tenantId === PLATFORM_TENANT_ID ? { realm: 'platform' } : { tenant: tenantId };

/** A lease opened under the client's session, as the tenant chooser opens it. */
async function open(client: TestClient, appId: string, accountId: string, tenantId: string): Promise<TestResult<TestTenantLease>> {
  const answer = await client.request(`/api/tenant/context/open?${new URLSearchParams({ app: appId, ...selector(tenantId) })}`, {
    method: 'POST',
    headers: { [TENANT_HTTP_HEADERS.account]: accountId, [TENANT_HTTP_HEADERS.app]: appId },
    json: {},
  });
  const text = await answer.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* Not JSON: said below as what it was. */
  }
  if (answer.status !== 200 || typeof body.context !== 'string' || typeof body.tabId !== 'string')
    return {
      ok: false,
      status: answer.status,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      message: String(body.error ?? body.message ?? (text.slice(0, 500) || `HTTP ${answer.status}`)),
      body,
    };
  return {
    ok: true,
    status: answer.status,
    value: {
      appId: String(body.appId),
      accountId: String(body.accountId),
      tenantId: String(body.tenantId),
      realm: body.realm === 'platform' ? 'platform' : 'tenant',
      tabId: body.tabId,
      context: body.context,
      revision: Number(body.revision),
    },
  };
}

/* What the tenant transport leaves alone: sign-in, and the lease's own routes, which carry their own assertions. The
   support logs are reads on a lease, as the client sends them (client/tenantTransport.ts). */
const unleased = (path: string) =>
  !path.startsWith('/api/') ||
  path.startsWith('/api/auth/') ||
  (path.startsWith('/api/tenant/') && path !== SUPPORT_LOG_PATH && path !== SUPPORT_SESSIONS_PATH);

/** What the server said, as a result: its JSON on a 2xx, else a refusal in its words. */
async function answered<T>(answer: Response): Promise<TestResult<T>> {
  const text = await answer.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* Not JSON: said below as what it was. */
  }
  if (answer.ok) return { ok: true, status: answer.status, value: body as T };
  return {
    ok: false,
    status: answer.status,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    message: String(body.error ?? body.message ?? (text.slice(0, 500) || `HTTP ${answer.status}`)),
    body,
  };
}

/** A support visit's lease, and how it ends: the visit is the platform member's, read-only, in the dealer's role. */
export type TestSupportVisit = TestTenantClient & {
  /** The visit as the server recorded it: its id, version, reason and the role it was opened in. */
  visit: Readonly<{ supportId: string; version: string; tenantId: string; dealerRole: string; reason: string }>;
  /** Ends the visit, as the dealer bar's Exit does. */
  exit(): Promise<TestResult<unknown>>;
};

/** One session's requests under one lease: the App and selector in the query, the lease in the headers. */
function leased(
  session: TestClient,
  origin: string,
  appId: string,
  account: { accountId: string; email: string; password: string },
  lease: TestTenantLease,
): TestTenantClient {
  /** One request as the tenant transport sends it under the lease. */
  async function request(path: string, options: TestRequest = {}) {
    const url = new URL(path, origin);
    if (unleased(url.pathname)) return session.request(path, options);
    url.searchParams.delete('app');
    url.searchParams.set('app', appId);
    // A visit names both the realm it acts in and the tenant it entered, as the dealer bar's requests do.
    const selected: Record<string, string> =
      lease.realm === 'support' ? { realm: 'support', tenant: lease.tenantId } : selector(lease.tenantId);
    for (const [key, value] of Object.entries(selected)) url.searchParams.set(key, value);
    const json =
      options.json && typeof options.json === 'object' && !Array.isArray(options.json)
        ? Object.fromEntries(Object.entries(options.json).filter(([key]) => key !== 'app'))
        : options.json;
    const headers = new Headers(options.headers);
    headers.set(TENANT_HTTP_HEADERS.account, lease.accountId);
    headers.set(TENANT_HTTP_HEADERS.app, lease.appId);
    headers.set(TENANT_HTTP_HEADERS.tab, lease.tabId);
    headers.set(TENANT_HTTP_HEADERS.context, lease.context);
    headers.set(TENANT_HTTP_HEADERS.revision, String(lease.revision));
    return session.request(url.pathname + url.search, { ...options, headers, ...(json === undefined ? {} : { json }) });
  }
  /** The account's own request to a tenant route that names no lease (support, administration): the login's. */
  const own = (path: string, json: unknown) =>
    session.request(`${path}?${new URLSearchParams({ app: appId })}`, {
      method: 'POST',
      headers: { [TENANT_HTTP_HEADERS.account]: account.accountId, [TENANT_HTTP_HEADERS.app]: appId },
      json,
    });
  const app = appRequests((path, init) => request(path, init), { app: appId });
  return {
    ...session,
    ...app,
    request,
    account,
    lease,
    enter: (other: string) => open(session, appId, account.accountId, other),
    record: async (table: string, key: Record<string, string | number>) =>
      answered<unknown>(await request('/api/references', { method: 'POST', json: { table, key } })),
    async support(tenantId: string, visit: { role: string; reason: string }): Promise<TestResult<TestSupportVisit>> {
      const opened = await answered<{ receipt: { session: TestSupportVisit['visit'] }; context?: Record<string, unknown> }>(
        await own('/api/tenant/support/open', {
          idempotencyKey: randomBytes(18).toString('base64url'),
          intent: { operation: 'openSupport', tenantId, dealerRole: visit.role, reason: visit.reason },
        }),
      );
      if (!opened.ok) return opened;
      const context = opened.value.context;
      if (!context || typeof context.context !== 'string' || typeof context.tabId !== 'string')
        return { ok: false, status: opened.status, message: 'The visit opened, but its lease did not.', body: opened.value };
      const { supportId, version, dealerRole, reason } = opened.value.receipt.session;
      const client = leased(session, origin, appId, account, {
        appId,
        accountId: account.accountId,
        tenantId,
        realm: 'support',
        tabId: context.tabId,
        context: context.context,
        revision: Number(context.revision),
      });
      return {
        ok: true,
        status: opened.status,
        value: {
          ...client,
          visit: Object.freeze({ supportId, version, tenantId, dealerRole, reason }),
          exit: async () =>
            answered(
              await own('/api/tenant/support/exit', {
                idempotencyKey: randomBytes(18).toString('base64url'),
                intent: { operation: 'exitSupport', tenantId, supportId, expectedSupportVersion: version },
              }),
            ),
        },
      };
    },
  };
}

/**
 * A client of `origin` signed in to `account`, working under a lease of `tenantId` (or `@platform`). Refuses, with
 * the server's words, when the lease is not granted.
 */
export async function tenantTestClient(
  origin: string,
  appId: string,
  account: { accountId: string; email: string; password: string },
  tenantId: string,
): Promise<TestTenantClient> {
  const session = createTestClient(origin, { app: appId });
  await session.signIn(account.email, account.password);
  const opened = await open(session, appId, account.accountId, tenantId);
  if (!opened.ok)
    throw new Error(
      `Opening ${tenantId === PLATFORM_TENANT_ID ? 'the platform realm' : `tenant "${tenantId}"`} answered ${opened.status}: ${opened.message}`,
    );
  return leased(session, origin, appId, account, opened.value);
}
