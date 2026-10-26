import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ADMINISTRATION_HTTP_HEADER as contextHeader,
  type AdministrationAttempt,
  type AdministrationSession,
  type AdministrationTenantTarget,
} from '../shared/tenantAdministration.js';
import {
  establishSessionIdentity,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
} from '../../../kit/src/client/sessionIdentity.js';
import {
  executeAdministration,
  hasUnresolvedAdministration,
  listAdministrationMemberships,
  listAdministrationTenants,
  openAdministration,
  statusAdministration,
  TenantAdministrationController,
} from './tenantAdministration.js';

let session: AdministrationSession;
const target: AdministrationTenantTarget = {
  tenantId: 'north',
  tenant: { tenantId: 'north', status: 'active', version: '9007199254740993' },
  capabilities: [
    { operation: 'grantMembership', roles: ['reader'] },
    { operation: 'replaceMembership', roles: ['editor'] },
    { operation: 'revokeMembership', roles: ['auditor'] },
  ],
};
const attempt: AdministrationAttempt = { idempotencyKey: 'attempt-1', intent: { operation: 'createTenant', tenantId: 'new' } };
function receipt(replayed = false) {
  return {
    receiptId: 'receipt',
    requestId: 'request',
    completedAt: new Date().toISOString(),
    replayed,
    change: { operation: 'createTenant', before: null, after: { tenant: { tenantId: 'new', status: 'active', version: '1' } } },
  };
}
function reply(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'x-mistri-account': 'operator', 'x-mistri-app': 'app', [contextHeader]: session.context, ...headers },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const controllers: TenantAdministrationController[] = [];
function controller() {
  const c = new TenantAdministrationController();
  controllers.push(c);
  return c;
}
beforeEach(() => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  requireTenantSelection();
  session = {
    accountId: 'operator',
    appId: 'app',
    context: 'admin-context',
    expiresAt: Date.now() + 300_000,
    maxMembershipLifetimeMs: 86_400_000,
  };
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.retire());
  lockSessionIdentity();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('open works before tenant selection with exact native ownership and no administration assertion', async () => {
  const fetcher = vi.fn(async () => reply({ session }));
  vi.stubGlobal('fetch', fetcher);
  expect(sessionIdentity().tenant).toBeUndefined();
  expect(await openAdministration(sessionIdentity())).toEqual(session);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/tenant/administration/open?app=app');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: '{}' });
  expect(init.headers).toEqual({ 'x-mistri-account': 'operator', 'x-mistri-app': 'app', 'content-type': 'application/json' });
});

test('an ordinary account gets null only when the open response has no administration assertion', async () => {
  const response = reply({ session: null });
  response.headers.delete(contextHeader);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(reply({ session: null })),
  );
  expect(await openAdministration(sessionIdentity())).toBeNull();
  await expect(openAdministration(sessionIdentity())).rejects.toMatchObject({ outcome: 'not_applied' });
});

test('bounded listings retain decimal versions and keep disjoint role ceilings separate', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ page: { items: [target], next: 'north' } }))
    .mockResolvedValueOnce(
      reply({
        page: {
          tenant: target.tenant,
          operation: 'revokeMembership',
          roles: ['auditor'],
          items: [],
          next: null,
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const tenants = await listAdministrationTenants(sessionIdentity(), session, 'earlier');
  expect(tenants.items[0]).toEqual(target);
  await listAdministrationMemberships(sessionIdentity(), session, 'north', 'revokeMembership', 'member-20');
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/administration/tenants?app=app&limit=20&after=earlier');
  const url = new URL(fetcher.mock.calls[1][0], 'http://app.test');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    app: 'app',
    tenantId: 'north',
    operation: 'revokeMembership',
    after: 'member-20',
    limit: '20',
  });
  expect(fetcher.mock.calls[1][1].headers).toEqual({
    'x-mistri-account': 'operator',
    'x-mistri-app': 'app',
    [contextHeader]: 'admin-context',
  });
});

test.each(['x-mistri-app', 'x-mistri-account', contextHeader])('execute rejects an unowned %s success as unknown', async (header) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ outcome: 'applied', result: receipt() }, 200, { [header]: 'other' })),
  );
  await expect(executeAdministration(sessionIdentity(), session, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
});

test('body-reader completion rechecks the UI owner even after matching response headers', async () => {
  const body = deferred<unknown>();
  const response = reply({});
  response.json = () => body.promise;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  const pending = executeAdministration(sessionIdentity(), session, attempt);
  await Promise.resolve();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  body.resolve({ outcome: 'applied', result: receipt() });
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
});

test.each([400, 401, 403, 409, 500])('status refusal %s cannot settle uncertainty even with not_applied in its body', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ outcome: 'not_applied' }, status)),
  );
  await expect(statusAdministration(sessionIdentity(), session, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
});

test('the HTTP host’s headerless definite refusal settles only a fresh execute, never status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'tenant_administration_unavailable',
            outcome: 'not_applied',
            error: 'The administration operation could not be confirmed.',
          }),
          { status: 403 },
        ),
    ),
  );
  await expect(executeAdministration(sessionIdentity(), session, attempt)).rejects.toMatchObject({ outcome: 'not_applied' });
  await expect(statusAdministration(sessionIdentity(), session, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
});

test('execute and status send the same exact frozen envelope, with no business headers', async () => {
  const fetcher = vi.fn(async () => reply({ status: 'completed', outcome: 'applied', result: receipt() }));
  vi.stubGlobal('fetch', fetcher);
  await executeAdministration(sessionIdentity(), session, attempt);
  await statusAdministration(sessionIdentity(), session, attempt);
  for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(JSON.parse(init.body as string)).toEqual(attempt);
    expect(init.headers).toEqual({
      'x-mistri-account': 'operator',
      'x-mistri-app': 'app',
      [contextHeader]: session.context,
      'content-type': 'application/json',
    });
  }
});

test('malformed success, excessive pages and a membership outside the operation ceiling fail closed', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(reply({ outcome: 'applied', result: {} }))
      .mockResolvedValueOnce(reply({ page: { items: Array(21).fill(target), next: null } }))
      .mockResolvedValueOnce(
        reply({
          page: {
            tenant: target.tenant,
            operation: 'replaceMembership',
            roles: ['editor'],
            next: null,
            items: [
              {
                membershipId: 'm',
                tenantId: 'north',
                accountId: 'a',
                status: 'active',
                version: '1',
                roles: ['auditor'],
                validUntil: Date.now() + 10000,
              },
            ],
          },
        }),
      ),
  );
  await expect(executeAdministration(sessionIdentity(), session, attempt)).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(listAdministrationTenants(sessionIdentity(), session)).rejects.toBeDefined();
  await expect(listAdministrationMemberships(sessionIdentity(), session, 'north', 'replaceMembership')).rejects.toBeDefined();
});

test('one owner opens once, freezes intent and never unions role ceilings when preparing a grant', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ session }))
    .mockResolvedValueOnce(reply({ page: { items: [target], next: null } }));
  vi.stubGlobal('fetch', fetcher);
  const c = controller();
  await Promise.all([c.open(), c.open(), c.open()]);
  await c.loadTenants();
  c.select('north');
  const intent = {
    operation: 'grantMembership' as const,
    tenantId: 'north',
    expectedTenantVersion: target.tenant!.version,
    accountId: 'exact-native-account',
    roles: ['reader'],
    validUntil: Date.now() + 60_000,
  };
  expect(c.prepare({ ...intent, roles: ['reader', 'auditor'] })).toBe(false);
  expect(c.prepare(intent)).toBe(true);
  const frozen = c.snapshot().attempt!;
  intent.roles.push('auditor');
  intent.validUntil += 1000;
  expect(frozen.intent).toMatchObject({ roles: ['reader'], validUntil: intent.validUntil - 1000 });
  expect(Object.isFrozen(frozen.intent)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('unknown survives absent/refused status and expired-context recovery with the exact original attempt', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/open?')) return reply({ session });
    if (url.includes('/tenants?'))
      return reply({
        page: { items: [{ tenantId: 'new', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] }], next: null },
      });
    if (url.includes('/execute?')) throw new Error('Lost acknowledgement');
    return reply({ status: 'not_found', outcome: 'unknown', result: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const c = controller();
  await c.open();
  await c.loadTenants();
  c.select('new');
  c.prepare(attempt.intent);
  const captured = c.snapshot().attempt;
  await c.execute();
  expect(hasUnresolvedAdministration()).toBe(true);
  await c.check();
  expect(c.snapshot()).toMatchObject({ phase: 'unknown', attempt: captured });
  fetcher.mockResolvedValueOnce(reply({ outcome: 'not_applied' }, 403));
  await c.check();
  expect(c.snapshot().phase).toBe('unknown');
  now += 300_001;
  session = { ...session, context: 'fresh-context', expiresAt: now + 300_000 };
  await c.recoverContext();
  expect(c.snapshot().session?.context).toBe('fresh-context');
  expect(c.snapshot().attempt).toBe(captured);
  expect(hasUnresolvedAdministration()).toBe(true);
  await c.check();
  const mutations = fetcher.mock.calls.filter(([url]) => /\/(execute|status)\?/.test(url));
  expect(mutations.filter(([url]) => url.includes('/execute?'))).toHaveLength(1);
  for (const call of mutations) expect(JSON.parse((call as unknown as [string, RequestInit])[1].body as string)).toEqual(captured);
});

test('held membership replies cannot replace another target or operation selection', async () => {
  const held = deferred<Response>();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(reply({ session }))
      .mockResolvedValueOnce(
        reply({ page: { items: [target, { ...target, tenantId: 'south', tenant: { ...target.tenant, tenantId: 'south' } }], next: null } }),
      )
      .mockReturnValueOnce(held.promise),
  );
  const c = controller();
  await c.open();
  await c.loadTenants();
  c.select('north');
  const pending = c.loadMemberships('replaceMembership');
  c.select('south');
  held.resolve(reply({ page: { tenant: target.tenant, operation: 'replaceMembership', roles: ['editor'], items: [], next: null } }));
  await pending;
  expect(c.snapshot().target?.tenantId).toBe('south');
  expect(c.snapshot().memberships).toBeNull();
});

test('historical success loads the currently authorized list instead of painting its historical tenant image', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ session }))
    .mockResolvedValueOnce(
      reply({ page: { items: [{ tenantId: 'new', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] }], next: null } }),
    )
    .mockRejectedValueOnce(new Error('Lost'))
    .mockResolvedValueOnce(reply({ status: 'completed', outcome: 'applied', result: receipt(true) }))
    .mockResolvedValueOnce(
      reply({
        page: { items: [{ tenantId: 'new', tenant: { tenantId: 'new', status: 'closed', version: '3' }, capabilities: [] }], next: null },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const c = controller();
  await c.open();
  await c.loadTenants();
  c.select('new');
  c.prepare(attempt.intent);
  await c.execute();
  await c.check();
  expect(c.snapshot().phase).toBe('idle');
  expect(hasUnresolvedAdministration()).toBe(false);
  expect(c.snapshot().page?.items[0].tenant?.status).toBe('closed');
  expect(c.snapshot().target).toBeNull();
  expect(c.snapshot().result?.change.after.tenant.status).toBe('active');
});

test('owner retirement drops private attempt data and held success cannot publish into the new same-account UI', async () => {
  const held = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ session }))
    .mockResolvedValueOnce(
      reply({ page: { items: [{ tenantId: 'new', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] }], next: null } }),
    )
    .mockReturnValueOnce(held.promise);
  vi.stubGlobal('fetch', fetcher);
  const c = controller();
  await c.open();
  await c.loadTenants();
  c.select('new');
  c.prepare(attempt.intent);
  const pending = c.execute();
  expect(hasUnresolvedAdministration()).toBe(true);
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  const fresh = controller();
  held.resolve(reply({ outcome: 'applied', result: receipt() }));
  await pending;
  expect(c.snapshot().attempt).toBeNull();
  expect(c.snapshot().page).toBeNull();
  expect(c.snapshot().result).toBeNull();
  expect(fresh.snapshot().result).toBeNull();
  expect(hasUnresolvedAdministration()).toBe(false);
});
