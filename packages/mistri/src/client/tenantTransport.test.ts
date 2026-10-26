import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { TenantContextReply } from '../shared/tenantContext.js';

let session: typeof import('../../../kit/src/client/sessionIdentity.js');
let transport: typeof import('./tenantTransport.js');
const proof = (tenantId = 'north', context = 'context-north'): TenantContextReply => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId,
  tabId: 'tab-one',
  context,
  revision: 1,
  expiresAt: Date.now() + 60_000,
});
const headers = (value = proof()) => ({
  'x-mistri-app': value.appId,
  'x-mistri-account': value.accountId,
  'x-mistri-tenant': value.tenantId,
  'x-mistri-tab': value.tabId,
  'x-mistri-context': value.context,
  'x-mistri-lease-revision': String(value.revision),
});
const reply = (body: unknown, owner = proof(), status = 200) => new Response(JSON.stringify(body), { status, headers: headers(owner) });
/** A read that meets a slow or busy server waits and asks again (G172): run its waits out. */
async function outwait<T>(pending: Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
beforeEach(async () => {
  vi.resetModules();
  session = await import('../../../kit/src/client/sessionIdentity.js');
  transport = await import('./tenantTransport.js');
  const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
  lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
  session.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  session.requireTenantSelection();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('discovery is account-only, bounded and never auto-selects a tenant', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north' }] })),
    );
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.discoverTenants()).toEqual(['north']);
  expect(session.sessionIdentity().tenant).toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/bootstrap?app=atlas');
  expect(fetcher.mock.calls[0][1].headers).toEqual({ 'x-mistri-app': 'atlas', 'x-mistri-account': 'alice' });
});

test('mounted tenant discovery, reads and release stay under the App base path', async () => {
  const meta = document.createElement('meta');
  meta.name = 'mistri-mount';
  meta.content = JSON.stringify({ base: '/leads', apps: { atlas: '' } });
  document.head.append(meta);
  try {
    vi.resetModules();
    const identity = await import('../../../kit/src/client/sessionIdentity.js');
    const mounted = await import('./tenantTransport.js');
    const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
    lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
    identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
    identity.requireTenantSelection();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north' }] })),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await mounted.discoverTenants()).toEqual(['north']);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/bootstrap?app=atlas');
    const lease = proof();
    fetcher.mockResolvedValue(reply(lease, lease));
    await mounted.chooseTenant('north');
    identity.establishTenantSelection(lease);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/context/open?app=atlas&tenant=north');
    fetcher.mockResolvedValue(reply({ rows: [] }, lease));
    await mounted.tenantReadApi('/api/query', { table: 'item' }, 'atlas');
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/query?app=atlas&tenant=north');
    mounted.releaseTenant(lease);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/context/release?app=atlas');
  } finally {
    meta.remove();
  }
});

const platformProof = (): TenantContextReply => ({ ...proof('@platform', 'context-platform'), realm: 'platform' });
const platformReply = (body: unknown, owner = platformProof(), status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers(owner), 'x-mistri-realm': 'platform' } });

test('discovery offers the platform realm as one more choice under its reserved id', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north' }], platform: true }),
        ),
      ),
  );
  expect(await transport.discoverTenants()).toEqual(['north', '@platform']);
  for (const body of [
    { memberships: [{ tenantId: '@platform' }] },
    { memberships: [], platform: false },
    { memberships: [], realm: 'platform' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', ...body }))),
    );
    await expect(transport.discoverTenants()).rejects.toThrow();
  }
});

test('the platform realm is chosen, read and renewed by ?realm=platform, and its replies must attest the realm', async () => {
  const lease = platformProof(),
    fetcher = vi.fn().mockResolvedValue(platformReply(lease));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.chooseTenant('@platform')).toEqual(lease);
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/context/open?app=atlas&realm=platform');
  // A reply without the realm header, or a realm on a tenant's lease, is not this context.
  fetcher.mockResolvedValue(reply(lease, lease));
  await expect(transport.chooseTenant('@platform')).rejects.toThrow();
  fetcher.mockResolvedValue(platformReply({ ...proof(), realm: 'platform' }, proof()));
  await expect(transport.chooseTenant('north')).rejects.toThrow();
  session.establishTenantSelection(lease);
  expect(session.sessionIdentity().tenant).toMatchObject({ tenantId: '@platform', realm: 'platform' });
  fetcher.mockResolvedValue(platformReply({ rows: [] }));
  await transport.tenantReadApi('/api/query', { table: 'item' }, 'atlas');
  expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/query?app=atlas&realm=platform');
  // The platform realm saves its own rows, but a change with no platform answer, an import, never leaves the browser.
  const sent = fetcher.mock.calls.length;
  await expect(transport.tenantMutationApi('/api/import', { table: 'item', rows: [{ name: 'b' }] }, 'atlas')).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher.mock.calls.length).toBe(sent);
  const renewed = { ...lease, revision: 2 };
  fetcher.mockResolvedValue(platformReply(renewed, renewed));
  expect(await transport.renewTenant(session.captureSessionIdentity(), lease)).toEqual(renewed);
  expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/tenant/context/renew?app=atlas&realm=platform');
});

test.each([
  { status: 'ready', appId: 'other', accountId: 'alice', memberships: [] },
  { status: 'ready', appId: 'atlas', accountId: 'bob', memberships: [] },
  { status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north' }, { tenantId: 'north' }] },
  { status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north', roles: ['admin'] }] },
])('malformed discovery does not select or publish a tenant: %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await expect(transport.discoverTenants()).rejects.toThrow();
  expect(session.sessionIdentity().tenant).toBeUndefined();
});

test('open and switch verify the entire server tuple and do not mutate browser identity themselves', async () => {
  const first = proof(),
    fetcher = vi.fn().mockResolvedValue(reply(first));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.chooseTenant('north')).toEqual(first);
  expect(session.sessionIdentity().tenant).toBeUndefined();
  expect(fetcher.mock.calls[0][1].body).toBe('{}');
  const next = proof('south', 'context-south');
  fetcher.mockResolvedValue(reply(next, next));
  expect(await transport.chooseTenant('south', first)).toEqual(next);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    tabId: first.tabId,
    expectedContext: first.context,
    expectedRevision: first.revision,
  });
  expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('x-mistri-context');
});

test.each(['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'])('selection refuses a wrong %s response header', async (key) => {
  const response = reply(proof());
  response.headers.set(`x-mistri-${key}`, 'wrong');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(transport.chooseTenant('north')).rejects.toThrow();
  expect(session.sessionIdentity().tenant).toBeUndefined();
});

test('switch requires the requested tenant and original tab, including matching headers', async () => {
  const wrong = { ...proof('south', 'new'), tabId: 'other-tab' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(wrong, wrong)));
  await expect(transport.chooseTenant('south', proof())).rejects.toThrow();
});

test('lost switch acknowledgement leaves selection absent; recovery is explicit', async () => {
  const original = proof(),
    next = proof('south', 'new');
  const fetcher = vi.fn().mockRejectedValue(new Error('network'));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.chooseTenant('south', original)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(session.sessionIdentity().tenant).toBeUndefined();
  fetcher.mockResolvedValue(reply(next, next));
  expect(await transport.recoverTenant(original.tabId)).toEqual(next);
  expect(fetcher.mock.calls[1][0]).toBe('/api/tenant/context/recover?app=atlas');
});

test('inactive recovery carries no implied owner and malformed recovery refuses', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tabId: 'tab-one', status: 'inactive' })));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.recoverTenant('tab-one')).toEqual({ tabId: 'tab-one', status: 'inactive' });
  fetcher.mockResolvedValue(new Response(JSON.stringify({ tabId: 'wrong', status: 'inactive' })));
  await expect(transport.recoverTenant('tab-one')).rejects.toThrow();
});

test('selected reads carry canonical URL selectors and tab/context assertions, never a tenant header', async () => {
  session.establishTenantSelection(proof());
  const fetcher = vi.fn().mockResolvedValue(reply({ rows: [{ id: 'same', name: 'North' }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.tenantReadApi('/api/query', { table: 'item', app: 'atlas' }, 'atlas')).toEqual({
    rows: [{ id: 'same', name: 'North' }],
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/query?app=atlas&tenant=north');
  expect(JSON.parse(init.body)).toEqual({ table: 'item' });
  expect(init.headers).not.toHaveProperty('x-mistri-tenant');
  expect(init.headers['x-mistri-tab']).toBe('tab-one');
  expect(init.headers['x-mistri-context']).toBe('context-north');
});

test('command availability is an owned tenant read, never an unscoped or mutation fallback', async () => {
  const payload = { checks: [{ command: 'assignReviewer', commandVersion: 1, keys: [{ id: 'same' }] }] };
  const result = { availability: [{ available: true }] };
  const fetcher = vi.fn().mockResolvedValue(reply(result));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/commands/availability', payload, 'atlas')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  session.establishTenantSelection(proof());
  expect(await transport.tenantReadApi('/api/commands/availability', payload, 'atlas')).toEqual(result);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/commands/availability?app=atlas&tenant=north');
  expect(init.headers).toMatchObject({
    'x-mistri-app': 'atlas',
    'x-mistri-account': 'alice',
    'x-mistri-context': 'context-north',
    'x-mistri-tab': 'tab-one',
    'x-mistri-lease-revision': '1',
  });
  expect(JSON.parse(init.body)).toEqual(payload);
  expect(transport.isTenantMutationPath('/api/commands/availability')).toBe(false);
  fetcher.mockResolvedValue(reply(result, proof('south', 'context-south')));
  await expect(transport.tenantReadApi('/api/commands/availability', payload, 'atlas')).rejects.toThrow();
});

test('availability refuses a suspended lease before sending a request', async () => {
  session.establishTenantSelection(proof());
  session.suspendTenantLease(session.captureSessionIdentity());
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/commands/availability', { checks: [] }, 'atlas')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('context monitoring forwards its abort signal without dropping owner assertions', async () => {
  session.establishTenantSelection(proof());
  const controller = new AbortController(),
    fetcher = vi.fn().mockResolvedValue(reply({ app: true }));
  vi.stubGlobal('fetch', fetcher);
  await transport.tenantReadApi('/api/runtime', undefined, 'atlas', controller.signal);
  expect(fetcher.mock.calls[0][0]).toBe('/api/runtime?app=atlas&tenant=north');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    signal: controller.signal,
    cache: 'no-store',
    headers: { 'x-mistri-context': 'context-north', 'x-mistri-tab': 'tab-one' },
  });
});

test.each([
  '/api/update',
  '/api/revert',
  '/api/sql',
  '/api/export',
  '/api/pages/save',
  '/api/connections',
  '/api/../query',
  '/api/query#hidden',
  '/api/query?tenant=south',
  '/api/query?app=other',
  '/api/query?x=1',
])('tenant browser never falls through for unsupported/competing route %s', async (path) => {
  session.establishTenantSelection(proof());
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi(path, { table: 'item' }, 'atlas')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'])(
  'read success with wrong %s cannot expose equal-key records',
  async (key) => {
    session.establishTenantSelection(proof());
    const response = reply({ rows: [{ id: 'same', name: 'Private' }] });
    response.headers.set(`x-mistri-${key}`, 'wrong');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(transport.tenantReadApi('/api/query', { table: 'item' })).rejects.toThrow();
    expect(session.sessionIdentity().mode).toBe('locked');
  },
);

test('late old-tenant response cannot publish or lock a newer same-account selection', async () => {
  session.establishTenantSelection(proof());
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = transport.tenantReadApi('/api/schema');
  session.requireTenantSelection();
  session.establishTenantSelection(proof('south', 'south-context'));
  finish(reply({ rows: ['North private'] }, proof(), 403));
  await expect(pending).rejects.toThrow('previous session');
  expect(session.sessionIdentity().tenant?.tenantId).toBe('south');
});

test('ownership is checked after JSON decoding and parse-error bodies cannot smuggle row results', async () => {
  session.establishTenantSelection(proof());
  let finish!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(headers()),
      json: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  );
  const pending = transport.tenantReadApi('/api/schema');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  session.requireTenantSelection();
  session.establishTenantSelection(proof('south', 'south-context'));
  finish({ rows: ['private'] });
  await expect(pending).rejects.toThrow('previous session');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'Invalid query' }], rows: ['unowned'] }))),
  );
  expect(await transport.tenantReadApi('/api/run', { q: 'bad' })).toEqual({ errors: [{ message: 'Invalid query' }] });
});

test('known context refusal removes mounted access while raw response diagnostics stay hidden', async () => {
  session.establishTenantSelection(proof());
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'tenant_context_unavailable', error: 'Unavailable' }), { status: 403 })),
  );
  await expect(transport.tenantReadApi('/api/schema')).rejects.toThrow();
  expect(session.sessionIdentity().mode).toBe('locked');
});

test.each([
  [404, 'not_found'],
  [400, 'invalid_read'],
])("a %i %s is the request's own refusal: the read fails and the tenant session stays", async (status, code) => {
  session.establishTenantSelection(proof());
  const held = session.sessionIdentity().mode;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, error: 'No such record.' }), { status })));
  await expect(transport.tenantReadApi('/api/pages/compose', { page: 'ticket', key: { id: 'south-1' } })).rejects.toThrow();
  expect(session.sessionIdentity().mode).toBe(held);
  expect(held).not.toBe('locked');
});

test('renewal uses only control assertions, returns a frozen receipt and leaves adoption to the caller', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original),
    next = { ...original, revision: 2 };
  const controller = new AbortController(),
    fetcher = vi.fn().mockResolvedValue(reply(next, next));
  vi.stubGlobal('fetch', fetcher);
  session.suspendTenantLease(owner);
  const received = await transport.renewTenant(owner, original, controller.signal);
  expect(received).toEqual(next);
  expect(Object.isFrozen(received)).toBe(true);
  expect(session.captureTenantLease()?.revision).toBe(1);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]).toEqual([
    '/api/tenant/context/renew?app=atlas&tenant=north',
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'x-mistri-app': 'atlas', 'x-mistri-account': 'alice', 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: original.tabId, expectedContext: original.context, expectedRevision: 1 }),
    },
  ]);
});

test('lost renewal acknowledgement is left to the renewal loop without retry; exact expired receipt can be recovered', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original),
    fetcher = vi.fn().mockRejectedValue(new Error('Offline'));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.renewTenant(owner, original)).rejects.toMatchObject({ message: 'Offline', transient: true });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(session.captureSessionIdentity()).toBe(owner);
  // A lost reply decides nothing about the context; tenantRenewal.ts retries while the lease runs.
  expect(session.tenantLeaseActive()).toBe(true);
  expect(session.captureTenantLease()).toEqual(original);
  vi.spyOn(Date, 'now').mockReturnValue(original.expiresAt + 1);
  const expired = { ...original, revision: 2 };
  fetcher.mockResolvedValue(reply(expired, expired));
  const recovered = await transport.renewTenant(owner, original);
  session.acceptTenantRenewal(owner, 1, recovered);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()?.revision).toBe(2);
  expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
});

test.each(['appId', 'accountId', 'tenantId', 'tabId', 'context', 'revision', 'extra', 'header'])(
  'renewal refuses malformed or mismatched %s',
  async (field) => {
    const original = proof(),
      owner = session.establishTenantSelection(original);
    const next = { ...original, revision: 2, ...(field === 'header' ? {} : { [field]: field === 'revision' ? 3 : 'wrong' }) };
    const response = reply(next, next);
    if (field === 'header') response.headers.delete('x-mistri-lease-revision');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(transport.renewTenant(owner, original)).rejects.toThrow();
    expect(session.sessionIdentity().mode).toBe('locked');
  },
);

test('renewal cannot dispatch using another lease or adopt a late receipt after reselection', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.renewTenant(owner, { ...original, tenantId: 'south' })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const pending = transport.renewTenant(owner, original);
  session.requireTenantSelection();
  const newer = session.establishTenantSelection(proof('south', 'new'));
  const next = { ...original, revision: 2 };
  finish(reply(next, next));
  await expect(pending).rejects.toThrow('previous session');
  expect(session.captureSessionIdentity()).toBe(newer);
});

test('an admitted old-revision read publishes under its captured header after renewal', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const pending = transport.tenantReadApi('/api/schema');
  session.acceptTenantRenewal(owner, 1, { ...original, revision: 2, expiresAt: original.expiresAt + 60_000 });
  finish(reply({ tables: ['item'] }, original));
  expect(await pending).toEqual({ tables: ['item'] });
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-mistri-lease-revision')).toBe('1');
  expect(session.captureTenantLease()?.revision).toBe(2);
  expect(session.tenantLeaseActive()).toBe(true);
});

test('renewal does not extend a read deadline through delayed JSON decoding', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  let decode!: (value: unknown) => void;
  const response = reply({}),
    decoding = vi.spyOn(response, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          decode = resolve;
        }),
    );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const pending = transport.tenantReadApi('/api/schema');
  await vi.waitFor(() => expect(decoding).toHaveBeenCalledOnce());
  session.acceptTenantRenewal(owner, 1, { ...original, revision: 2, expiresAt: original.expiresAt + 60_000 });
  vi.spyOn(Date, 'now').mockReturnValue(original.expiresAt);
  decode({ tables: ['DO_NOT_PUBLISH'] });
  await expect(pending).rejects.toThrow();
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(true);
});

test.each(['tenant_lease_stale', 'tenant_lease_expired', 'tenant_context_unavailable', '401', 'network', 'malformed', 'wrong-revision'])(
  'delayed old-revision %s cannot lock or suspend a renewed lease',
  async (kind) => {
    const original = proof(),
      owner = session.establishTenantSelection(original);
    let finish!: (value: Response) => void, fail!: (error: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      ),
    );
    const pending = transport.tenantReadApi('/api/schema');
    session.acceptTenantRenewal(owner, 1, { ...original, revision: 2 });
    if (kind === 'network') fail(new Error('Offline'));
    else if (kind === 'malformed') finish(new Response('invalid-json'));
    else if (kind === 'wrong-revision') finish(reply({ rows: ['private'] }, { ...original, revision: 2 }));
    else finish(new Response(JSON.stringify({ error: 'Refused', code: kind }), { status: kind === '401' ? 401 : 409 }));
    await expect(pending).rejects.toThrow();
    expect(session.captureSessionIdentity()).toBe(owner);
    expect(session.tenantLeaseActive()).toBe(true);
  },
);

test.each(['tenant_lease_stale', 'tenant_lease_expired'])('current %s suspends the same read owner without retries', async (kind) => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unavailable', code: kind }), { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/schema')).rejects.toThrow();
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toEqual(original);
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(transport.tenantReadApi('/api/schema')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each(['503', '429', 'network'])('a current %s is asked again with backoff before it suspends the read owner', async (kind) => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const fetcher =
    kind === 'network'
      ? vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
      : vi.fn(async () => new Response(JSON.stringify({ error: 'Unavailable', code: 'tenant_unavailable' }), { status: Number(kind) }));
  vi.stubGlobal('fetch', fetcher);
  await expect(outwait(transport.tenantReadApi('/api/schema'))).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toEqual(original);
});

test.each(['503', 'network', 'broken body'])('a %s that passes leaves the lease open and answers the read (G172)', async (kind) => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const broken = reply({});
  vi.spyOn(broken, 'json').mockRejectedValue(new TypeError('Connection lost while reading body'));
  const fetcher = vi.fn();
  if (kind === 'network') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  else if (kind === 'broken body') fetcher.mockResolvedValueOnce(broken);
  else fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable', code: 'tenant_unavailable' }), { status: 503 }));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 502 }));
  fetcher.mockResolvedValueOnce(reply({ tables: ['item'] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(outwait(transport.tenantReadApi('/api/schema'))).resolves.toEqual({ tables: ['item'] });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(true);
  // Every attempt asserts the same captured context.
  expect(new Set(fetcher.mock.calls.map((call) => call[1].headers['x-mistri-lease-revision']))).toEqual(new Set(['1']));
});

test('a read waiting to ask again is refused, not resent, once the lease is suspended meanwhile', async () => {
  const owner = session.establishTenantSelection(proof());
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = transport.tenantReadApi('/api/schema');
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    session.suspendTenantLease(owner);
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow('The tenant context is unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test('suspension while a read is pending prevents result publication without retiring the owner', async () => {
  const owner = session.establishTenantSelection(proof());
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = transport.tenantReadApi('/api/schema');
  session.suspendTenantLease(owner);
  finish(reply({ tables: ['DO_NOT_PUBLISH'] }));
  await expect(pending).rejects.toThrow();
  expect(session.captureSessionIdentity()).toBe(owner);
});

test.each(['read', 'renew', 'mutation'] as const)(
  'body-stream network failure fences %s as its retry rule says, without retiring stable identity',
  async (operation) => {
    const lease = proof(),
      owner = session.establishTenantSelection(lease),
      response = reply({});
    vi.spyOn(response, 'json').mockRejectedValue(new TypeError('Connection lost while reading body'));
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    const pending =
      operation === 'read'
        ? outwait(transport.tenantReadApi('/api/schema'))
        : operation === 'renew'
          ? transport.renewTenant(owner, lease)
          : transport.tenantMutationApi('/api/update', { table: 'item', key: { id: 'same' }, values: { name: 'Updated' } });
    await expect(pending).rejects.toThrow();
    if (operation === 'mutation') await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    expect(session.captureSessionIdentity()).toBe(owner);
    // A read fences once its retries are spent and a write at once; a renewal's own loop decides (tenantRenewal.ts).
    expect(session.tenantLeaseActive()).toBe(operation === 'renew');
    expect(fetcher).toHaveBeenCalledTimes(operation === 'read' ? 4 : 1);
  },
);

test.each(['duplicate', '401', 'refusal', 'network', 'malformed'] as const)(
  'a competing renewal %s cannot undo the adopted winner',
  async (kind) => {
    const lease = proof(),
      owner = session.establishTenantSelection(lease),
      next = { ...lease, revision: 2 };
    let finish!: (value: Response) => void, fail!: (error: Error) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(next, next))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
    vi.stubGlobal('fetch', fetcher);
    const winning = transport.renewTenant(owner, lease),
      losing = transport.renewTenant(owner, lease);
    session.acceptTenantRenewal(owner, 1, await winning);
    if (kind === 'network') fail(new Error('Offline'));
    else if (kind === 'malformed') finish(new Response('invalid-json'));
    else if (kind === 'duplicate') finish(reply(next, next));
    else
      finish(
        new Response(JSON.stringify({ error: 'Refused', code: 'tenant_context_unavailable' }), { status: kind === '401' ? 401 : 403 }),
      );
    if (kind === 'duplicate') expect(() => session.acceptTenantRenewal(owner, 1, next)).toThrow();
    if (kind === 'duplicate') expect(await losing).toEqual(next);
    else await expect(losing).rejects.toThrow();
    expect(session.captureSessionIdentity()).toBe(owner);
    expect(session.captureTenantLease()).toEqual(next);
    expect(session.tenantLeaseActive()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test.each([408, 429, 503])('non-JSON HTTP %s remains a recoverable suspension', async (status) => {
  const owner = session.establishTenantSelection(proof());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Temporarily unavailable', { status })));
  await expect(outwait(transport.tenantReadApi('/api/schema'))).rejects.toThrow();
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(false);
});

test('discovery keeps what each tenant is called beside its id, and refuses a name that is not words', async () => {
  const names = await import('./tenantNames.js');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ready',
          appId: 'atlas',
          accountId: 'alice',
          memberships: [{ tenantId: 'north', name: 'North Motors' }, { tenantId: 'south' }],
        }),
      ),
    ),
  );
  expect(await transport.discoverTenants()).toEqual(['north', 'south']);
  expect(names.tenantNames()).toEqual({ north: 'North Motors' });
  for (const name of ['', ' padded ', 'a\u0000b', 42, 'x'.repeat(201)]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north', name }] })),
        ),
    );
    await expect(transport.discoverTenants()).rejects.toThrow();
  }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'ready', appId: 'atlas', accountId: 'alice', memberships: [{ tenantId: 'north', label: 'North' }] }),
        ),
      ),
  );
  await expect(transport.discoverTenants()).rejects.toThrow();
});
