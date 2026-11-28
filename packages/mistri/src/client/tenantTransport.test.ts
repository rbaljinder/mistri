import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { TenantContextReply } from '../shared/tenantContext.js';

let session: typeof import('../../../kit/src/client/sessionIdentity.js');
let transport: typeof import('./tenantTransport.js');
let boot: typeof import('./tenantBootLoad.js');
const proof = (tenantId = 'north', context = 'context-north'): TenantContextReply => ({
  appId: 'desk',
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
  boot = await import('./tenantBootLoad.js');
  const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
  lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
  session.establishSessionIdentity({ signedIn: true, appId: 'desk', accountId: 'alice' });
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
      new Response(JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }] })),
    );
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.discoverTenants()).toEqual(['north']);
  expect(session.sessionIdentity().tenant).toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/bootstrap?app=desk');
  expect(fetcher.mock.calls[0][1].headers).toEqual({ 'x-mistri-app': 'desk', 'x-mistri-account': 'alice' });
});

test('entering takes a lease only where discovery has the one tenant it would enter, and checks it attests', async () => {
  const discovery = { status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }] };
  const boot = { reads: {}, items: {} };
  const page = { path: '/desk/leads', search: '?tab=open' };
  const lease = proof();
  const fetcher = vi.fn().mockResolvedValue(reply({ ...discovery, entered: { context: lease, boot } }, lease));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.enterTenant(page)).toEqual({ tenants: ['north'], lease, boot });
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/enter?app=desk');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(page);
  /* The kept context, resumed: the same tab, at any revision. */
  const resumed = { ...proof(), revision: 3 };
  fetcher.mockResolvedValueOnce(reply({ ...discovery, entered: { context: resumed } }, resumed));
  expect(await transport.enterTenant(page, 'north', { tenantId: 'north', tabId: 'tab-one' })).toEqual({
    tenants: ['north'],
    lease: resumed,
  });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...page, tenant: 'north', kept: { tenantId: 'north', tabId: 'tab-one' } });
  /* Discovery alone is discovery, read as ever. */
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ ...discovery, memberships: [{ tenantId: 'north' }, { tenantId: 'south' }] })),
  );
  expect(await transport.enterTenant(page)).toEqual({ tenants: ['north', 'south'] });
  /* Several memberships: the tenant a link names, or this tab kept, as the person's own, is entered; another is not. */
  const both = { ...discovery, memberships: [{ tenantId: 'north' }, { tenantId: 'south' }] };
  fetcher.mockResolvedValueOnce(reply({ ...both, entered: { context: lease, boot } }, lease));
  expect(await transport.enterTenant(page, 'north')).toEqual({ tenants: ['north', 'south'], lease, boot });
  fetcher.mockResolvedValueOnce(reply({ ...both, entered: { context: resumed } }, resumed));
  expect((await transport.enterTenant(page, undefined, { tenantId: 'north', tabId: 'tab-one' })).lease).toEqual(resumed);
  fetcher.mockResolvedValueOnce(reply({ ...both, entered: { context: proof() } }, proof()));
  await expect(transport.enterTenant(page, 'east')).rejects.toThrow();
  /* A lease the chooser would not have entered, or one the reply does not attest, is never taken. */
  for (const [body, owner, requested] of [
    [{ ...discovery, memberships: [{ tenantId: 'north' }, { tenantId: 'south' }], entered: { context: proof() } }, proof(), undefined],
    [{ ...discovery, platform: true, entered: { context: proof() } }, proof(), undefined],
    [{ ...discovery, entered: { context: proof() } }, proof(), 'south'],
    [{ ...discovery, entered: { context: proof('south') } }, proof('south'), undefined],
    [{ ...discovery, entered: { context: { ...proof(), revision: 2 } } }, { ...proof(), revision: 2 }, undefined],
    [{ ...discovery, entered: { context: proof() } }, proof('north', 'another'), undefined],
    [{ ...discovery, entered: { context: proof(), boot: [] } }, proof(), undefined],
    [{ ...discovery, entered: { context: proof(), extra: 1 } }, proof(), undefined],
  ] as const) {
    fetcher.mockResolvedValueOnce(reply(body, owner));
    await expect(transport.enterTenant(page, requested)).rejects.toThrow();
  }
  expect(session.sessionIdentity().tenant).toBeUndefined();
  /* The platform realm is never entered this way. */
  await expect(transport.enterTenant(page, '@platform')).rejects.toThrow();
});

test("a reload in a tab that holds the person's tenants re-enters its kept context: one request, no discovery, and a refusal enters afresh", async () => {
  sessionStorage.clear();
  const discovery = {
    status: 'ready',
    appId: 'desk',
    accountId: 'alice',
    memberships: [{ tenantId: 'north', name: 'North Motors' }, { tenantId: 'south' }],
  };
  const me = { signedIn: true, accountId: 'alice', appId: 'desk', who: 'alice', header: null, tenant: true };
  const boot = { reads: {}, items: {} };
  const page = { path: '/desk/leads', search: '' };
  const kept = { tenantId: 'north', tabId: 'tab-one' };
  const lease = proof();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  /* With no tenants held, a kept context is entered through discovery, as ever: the request does not say `reenter`. */
  fetcher.mockResolvedValueOnce(reply({ ...discovery, whoami: me, entered: { context: lease, boot } }, lease));
  expect(await transport.enterFirst('desk', page, undefined, kept)).toEqual(me);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).reenter).toBeUndefined();
  /* That answer's tenants are held for the tab's next page: it asks to re-enter, and its answer names no tenants. */
  await transport.enterTenant(page, undefined, kept);
  const back = { status: 'ready', appId: 'desk', accountId: 'alice', reentered: true, whoami: me, entered: { context: lease, boot } };
  fetcher.mockResolvedValueOnce(reply(back, lease));
  expect(await transport.enterFirst('desk', page, undefined, kept)).toEqual(me);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ path: '/desk/leads', search: '', kept, reenter: true });
  expect(await transport.enterTenant(page, undefined, kept)).toEqual({ reentered: true, tenants: ['north', 'south'], lease, boot });
  expect(fetcher).toHaveBeenCalledTimes(2);
  /* Its boot refused (a member removed, roles changed, a tenant suspended): the page enters afresh, through discovery. */
  fetcher.mockResolvedValueOnce(reply({ error: 'refused' }, lease, 403));
  fetcher.mockResolvedValueOnce(reply({ ...discovery, whoami: me }, lease));
  expect(await transport.enterFirst('desk', page, undefined, kept)).toEqual(me);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(JSON.parse(fetcher.mock.calls[3][1].body).reenter).toBeUndefined();
  expect(await transport.enterTenant(page, undefined, kept)).toEqual({ tenants: ['north', 'south'] });
  /* A context the host no longer holds is entered in the same request, as any: one request, its answer taken. */
  const other = { ...lease, tabId: 'tab-two' };
  fetcher.mockResolvedValueOnce(reply({ ...discovery, whoami: me, entered: { context: other, boot } }, other));
  expect(await transport.enterFirst('desk', page, undefined, kept)).toEqual(me);
  expect(fetcher).toHaveBeenCalledTimes(5);
  /* A re-entry is taken only as that very context: another tab's, another tenant's, or one naming tenants is not. */
  for (const body of [
    { ...back, entered: { context: other, boot } },
    { ...back, entered: { context: proof('south'), boot } },
    { ...back, memberships: [] },
    { ...back, entered: { context: lease } },
  ]) {
    fetcher.mockResolvedValueOnce(reply(body, body.entered.context as TenantContextReply));
    await transport.enterFirst('desk', page, undefined, kept);
    await expect(transport.enterTenant(page, undefined, kept)).rejects.toThrow();
  }
  /* A link naming another tenant is a choice: discovery's. */
  fetcher.mockResolvedValueOnce(reply({ ...discovery, whoami: me }, lease));
  await transport.enterFirst('desk', page, 'south', kept);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).reenter).toBeUndefined();
  sessionStorage.clear();
});

test("the page's first request is entering, which says who-am-I: no who-am-I is asked, and the look takes that answer", async () => {
  const discovery = { status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }] };
  const me = { signedIn: true, accountId: 'alice', appId: 'desk', who: 'alice', header: null, tenant: true };
  const boot = { reads: {}, items: {} };
  const page = { path: '/desk/leads', search: '?tab=open' };
  const lease = proof();
  const fetcher = vi.fn().mockResolvedValue(reply({ ...discovery, whoami: me, entered: { context: lease, boot } }, lease));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.enterFirst('desk', page, undefined, undefined)).toEqual(me);
  /* One request, entering, naming no account of its own: identity is the server's session's alone. */
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/enter?app=desk');
  expect(fetcher.mock.calls[0][1].headers).toEqual({ 'x-mistri-app': 'desk', 'content-type': 'application/json' });
  /* The chooser's first look is that answer, checked as any, and asks nothing more. */
  expect(await transport.enterTenant(page)).toEqual({ tenants: ['north'], lease, boot });
  expect(fetcher).toHaveBeenCalledTimes(1);
  /* Held once: a second look asks for itself. */
  fetcher.mockResolvedValueOnce(reply({ ...discovery, entered: { context: lease, boot } }, lease));
  await transport.enterTenant(page);
  expect(fetcher).toHaveBeenCalledTimes(2);
  /* A look that is not the one asked is asked afresh. */
  for (const [again, requested] of [
    [{ path: '/desk/other', search: '' }, undefined],
    [page, 'north'],
  ] as const) {
    fetcher.mockResolvedValueOnce(reply({ ...discovery, whoami: me, entered: { context: lease, boot } }, lease));
    await transport.enterFirst('desk', page);
    fetcher.mockResolvedValueOnce(reply({ ...discovery, entered: { context: lease, boot } }, lease));
    const before = fetcher.mock.calls.length;
    await transport.enterTenant(again, requested);
    expect(fetcher.mock.calls.length, `${again.path} ${requested}`).toBe(before + 1);
  }
  /* An answer that does not attest the account, says no who-am-I, or is not the App's is not taken as who-am-I. */
  for (const [body, owner] of [
    [{ ...discovery, whoami: { ...me, accountId: 'mallory' }, entered: { context: lease } }, lease],
    [{ ...discovery, whoami: { ...me, appId: 'other' } }, lease],
    [{ ...discovery, whoami: { ...me, tenant: undefined } }, lease],
    [{ ...discovery }, lease],
  ] as const) {
    fetcher.mockResolvedValueOnce(reply(body, owner));
    expect(await transport.enterFirst('desk', page)).toBeUndefined();
  }
  fetcher.mockResolvedValueOnce(reply({ error: 'busy' }, lease, 503));
  expect(await transport.enterFirst('desk', page)).toBeUndefined();
  fetcher.mockRejectedValueOnce(new Error('offline'));
  expect(await transport.enterFirst('desk', page)).toBeUndefined();
  /* Signed out, it is who-am-I's own answer, which the page draws the sign-in from as ever. */
  const out = { signedIn: false, accountId: null, appId: 'desk', who: null, header: null, signIn: { providers: ['email'] }, tenant: true };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'signed_out', whoami: out })));
  expect(await transport.enterFirst('desk', page)).toEqual(out);
  /* The platform realm is never entered this way. */
  expect(await transport.enterFirst('desk', page, '@platform')).toBeUndefined();
});

test('mounted tenant discovery, reads and release stay under the App base path', async () => {
  const meta = document.createElement('meta');
  meta.name = 'mistri-mount';
  meta.content = JSON.stringify({ base: '/leads', apps: { desk: '' } });
  document.head.append(meta);
  try {
    vi.resetModules();
    const identity = await import('../../../kit/src/client/sessionIdentity.js');
    const mounted = await import('./tenantTransport.js');
    const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
    lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
    identity.establishSessionIdentity({ signedIn: true, appId: 'desk', accountId: 'alice' });
    identity.requireTenantSelection();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }] })),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await mounted.discoverTenants()).toEqual(['north']);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/bootstrap?app=desk');
    const lease = proof();
    fetcher.mockResolvedValue(reply(lease, lease));
    await mounted.chooseTenant('north');
    identity.establishTenantSelection(lease);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/context/open?app=desk&tenant=north');
    fetcher.mockResolvedValue(reply({ rows: [] }, lease));
    await mounted.tenantReadApi('/api/query', { table: 'item' }, 'desk');
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/query?app=desk&tenant=north');
    mounted.releaseTenant(lease);
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/leads/api/tenant/context/release?app=desk');
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
          JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }], platform: true }),
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
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', ...body }))),
    );
    await expect(transport.discoverTenants()).rejects.toThrow();
  }
});

test('the platform realm is chosen, read and renewed by ?realm=platform, and its replies must attest the realm', async () => {
  const lease = platformProof(),
    fetcher = vi.fn().mockResolvedValue(platformReply(lease));
  vi.stubGlobal('fetch', fetcher);
  expect(await transport.chooseTenant('@platform')).toEqual(lease);
  expect(fetcher.mock.calls[0][0]).toBe('/api/tenant/context/open?app=desk&realm=platform');
  // A reply without the realm header, or a realm on a tenant's lease, is not this context.
  fetcher.mockResolvedValue(reply(lease, lease));
  await expect(transport.chooseTenant('@platform')).rejects.toThrow();
  fetcher.mockResolvedValue(platformReply({ ...proof(), realm: 'platform' }, proof()));
  await expect(transport.chooseTenant('north')).rejects.toThrow();
  session.establishTenantSelection(lease);
  expect(session.sessionIdentity().tenant).toMatchObject({ tenantId: '@platform', realm: 'platform' });
  fetcher.mockResolvedValue(platformReply({ rows: [] }));
  await transport.tenantReadApi('/api/query', { table: 'item' }, 'desk');
  expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/query?app=desk&realm=platform');
  // The platform realm saves its own rows, but a change with no platform answer, an import, never leaves the browser.
  const sent = fetcher.mock.calls.length;
  await expect(transport.tenantMutationApi('/api/import', { table: 'item', rows: [{ name: 'b' }] }, 'desk')).rejects.toMatchObject({
    outcome: 'not_applied',
  });
  expect(fetcher.mock.calls.length).toBe(sent);
  const renewed = { ...lease, revision: 2 };
  fetcher.mockResolvedValue(platformReply(renewed, renewed));
  expect(await transport.renewTenant(session.captureSessionIdentity(), lease)).toEqual(renewed);
  expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/tenant/context/renew?app=desk&realm=platform');
});

test.each([
  { status: 'ready', appId: 'other', accountId: 'alice', memberships: [] },
  { status: 'ready', appId: 'desk', accountId: 'bob', memberships: [] },
  { status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north' }, { tenantId: 'north' }] },
  { status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north', roles: ['admin'] }] },
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
  expect(fetcher.mock.calls[1][0]).toBe('/api/tenant/context/recover?app=desk');
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
  expect(await transport.tenantReadApi('/api/query', { table: 'item', app: 'desk' }, 'desk')).toEqual({
    rows: [{ id: 'same', name: 'North' }],
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/query?app=desk&tenant=north');
  expect(JSON.parse(init.body)).toEqual({ table: 'item' });
  expect(init.headers).not.toHaveProperty('x-mistri-tenant');
  expect(init.headers['x-mistri-tab']).toBe('tab-one');
  expect(init.headers['x-mistri-context']).toBe('context-north');
});

test('a picker’s and a related list’s reads say what they are on the lease, as the server audits them (readAudit.ts)', async () => {
  session.establishTenantSelection(proof());
  const fetcher = vi.fn().mockImplementation(async () => reply({ rows: [] }));
  vi.stubGlobal('fetch', fetcher);
  const { installShell } = await import('../../../kit/src/client/shellMode.js');
  installShell((await import('./surfaceShell.js')).surfaceShell);
  const core = await import('../../../kit/src/client/core.js');
  core.state.activeConnection = 'desk';
  await core.pickerApi('/api/query', { table: 'item' });
  await core.relatedApi('/api/query', { table: 'item' });
  await core.api('/api/query', { table: 'item' });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(3).fill('/api/query?app=desk&tenant=north'));
  expect(fetcher.mock.calls.map(([, init]) => init.headers['x-mistri-read'])).toEqual(['picker', 'related', undefined]);
  // What a read says it is never speaks for the lease: only those headers ride, and the lease's own win.
  await transport.tenantReadApi('/api/query', { table: 'item' }, 'desk', undefined, {
    'x-mistri-read': 'picker',
    'x-mistri-tenant': 'south',
    'x-mistri-context': 'context-south',
  });
  const [, init] = fetcher.mock.calls.at(-1)!;
  expect(init.headers['x-mistri-read']).toBe('picker');
  expect(init.headers).not.toHaveProperty('x-mistri-tenant');
  expect(init.headers['x-mistri-context']).toBe('context-north');
});

test('command availability is an owned tenant read, never an unscoped or mutation fallback', async () => {
  const payload = { checks: [{ command: 'assignReviewer', commandVersion: 1, keys: [{ id: 'same' }] }] };
  const result = { availability: [{ available: true }] };
  const fetcher = vi.fn().mockResolvedValue(reply(result));
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/commands/availability', payload, 'desk')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  session.establishTenantSelection(proof());
  expect(await transport.tenantReadApi('/api/commands/availability', payload, 'desk')).toEqual(result);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/commands/availability?app=desk&tenant=north');
  expect(init.headers).toMatchObject({
    'x-mistri-app': 'desk',
    'x-mistri-account': 'alice',
    'x-mistri-context': 'context-north',
    'x-mistri-tab': 'tab-one',
    'x-mistri-lease-revision': '1',
  });
  expect(JSON.parse(init.body)).toEqual(payload);
  expect(transport.isTenantMutationPath('/api/commands/availability')).toBe(false);
  fetcher.mockResolvedValue(reply(result, proof('south', 'context-south')));
  await expect(transport.tenantReadApi('/api/commands/availability', payload, 'desk')).rejects.toThrow();
});

test('availability refuses a suspended lease before sending a request', async () => {
  session.establishTenantSelection(proof());
  session.suspendTenantLease(session.captureSessionIdentity());
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/commands/availability', { checks: [] }, 'desk')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('the streamed export is asked on the lease, and a file is kept only where it names that lease', async () => {
  session.establishTenantSelection(proof());
  const file = (owner = proof()) =>
    new Response('id\r\n1\r\n', {
      status: 200,
      headers: { ...headers(owner), 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="lead.csv"' },
    });
  const fetcher = vi.fn().mockResolvedValue(file());
  vi.stubGlobal('fetch', fetcher);
  const answer = await transport.tenantExport({ q: 'lead', format: 'csv', columns: ['id'] });
  expect(await answer.text()).toBe('id\r\n1\r\n');
  expect(fetcher.mock.calls[0][0]).toBe('/api/export?app=desk&tenant=north');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    headers: { 'x-mistri-tab': 'tab-one', 'x-mistri-context': 'context-north', 'x-mistri-lease-revision': '1' },
  });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ q: 'lead', format: 'csv', columns: ['id'] });
  // An answer that is not a file is the caller's to read: a refusal it falls back from.
  fetcher.mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status: 403 }));
  expect((await transport.tenantExport({ q: 'lead', format: 'csv', columns: ['id'] })).status).toBe(403);
  // Another lease's file is not this one's, and leaves the session to be verified again.
  fetcher.mockResolvedValueOnce(file(proof('south', 'context-south')));
  await expect(transport.tenantExport({ q: 'lead', format: 'csv', columns: ['id'] })).rejects.toThrow();
});

test('context monitoring forwards its abort signal without dropping owner assertions', async () => {
  session.establishTenantSelection(proof());
  const controller = new AbortController(),
    fetcher = vi.fn().mockResolvedValue(reply({ app: true }));
  vi.stubGlobal('fetch', fetcher);
  await transport.tenantReadApi('/api/runtime', undefined, 'desk', controller.signal);
  expect(fetcher.mock.calls[0][0]).toBe('/api/runtime?app=desk&tenant=north');
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
  await expect(transport.tenantReadApi(path, { table: 'item' }, 'desk')).rejects.toThrow();
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
    '/api/tenant/context/renew?app=desk&tenant=north',
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'x-mistri-app': 'desk', 'x-mistri-account': 'alice', 'content-type': 'application/json' },
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

test.each(['tenant_context_unavailable', '401', 'network', 'malformed', 'wrong-revision'])(
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

test.each(['tenant_lease_stale', 'tenant_lease_expired'])(
  'a delayed old-revision read refused %s is asked again under the lease renewed meanwhile',
  async (kind) => {
    const original = proof(),
      owner = session.establishTenantSelection(original),
      renewed = { ...original, revision: 2 };
    let finish!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(reply({ tables: ['item'] }, renewed));
    vi.stubGlobal('fetch', fetcher);
    const pending = transport.tenantReadApi('/api/schema');
    session.acceptTenantRenewal(owner, 1, renewed);
    finish(new Response(JSON.stringify({ error: 'Refused', code: kind }), { status: 409 }));
    expect(await pending).toEqual({ tables: ['item'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('x-mistri-lease-revision')).toBe('2');
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

/* A host that restarted (mistri dev respawning) forgot the context: the page enters the same tenant again, once, and asks again. */
const unavailableContext = () =>
  new Response(JSON.stringify({ error: 'The tenant context could not be verified.', code: 'tenant_context_unavailable' }), {
    status: 403,
  });
test('reads refused because the server forgot the context enter the same tenant once and are asked again under it', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original),
    entered = { ...original, tabId: 'tab-two', context: 'context-entered' };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/tenant/context/open')) return reply(entered, entered);
    const sent = new Headers(init.headers);
    if (sent.get('x-mistri-context') === original.context) return unavailableContext();
    return reply({ asked: url }, entered);
  });
  vi.stubGlobal('fetch', fetcher);
  const [schema, rows] = await Promise.all([transport.tenantReadApi('/api/schema'), transport.tenantReadApi('/api/run', { q: 'item' })]);
  expect(schema).toEqual({ asked: '/api/schema?app=desk&tenant=north' });
  expect(rows).toEqual({ asked: '/api/run?app=desk&tenant=north' });
  /* Two refused, one entry, two asked again. */
  const opened = fetcher.mock.calls.filter(([url]) => url.startsWith('/api/tenant/context/open'));
  expect(opened).toHaveLength(1);
  expect(opened[0][0]).toBe('/api/tenant/context/open?app=desk&tenant=north');
  expect(opened[0][1].method).toBe('POST');
  expect(fetcher).toHaveBeenCalledTimes(5);
  for (const [, init] of fetcher.mock.calls.slice(-2)) {
    expect(new Headers(init.headers).get('x-mistri-tab')).toBe('tab-two');
    expect(new Headers(init.headers).get('x-mistri-context')).toBe('context-entered');
  }
  /* The selection stands: the same snapshot, now carrying the new lease. */
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.captureTenantLease()).toEqual(entered);
  expect(session.tenantLeaseActive()).toBe(true);
});

test('a read still refused after entering again is not asked a third time, and says the page needs a reload', async () => {
  const original = proof(),
    entered = { ...original, tabId: 'tab-two', context: 'context-entered' };
  session.establishTenantSelection(original);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(unavailableContext())
    .mockResolvedValueOnce(reply(entered, entered))
    .mockResolvedValue(unavailableContext());
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/schema')).rejects.toThrow(/Reload the page/);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(session.sessionIdentity().mode).toBe('locked');
});

test.each(['refused', 'another tenant'])(
  'a read whose entry again fails (%s) is refused as before, never sent again, and does not blame the role',
  async (kind) => {
    session.establishTenantSelection(proof());
    const fetcher = vi.fn().mockResolvedValueOnce(unavailableContext());
    if (kind === 'refused')
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'forbidden', error: 'No' }), { status: 403 }));
    else {
      const other = { ...proof('south', 'context-south'), tabId: 'tab-two' };
      fetcher.mockResolvedValueOnce(reply(other, other));
    }
    fetcher.mockResolvedValue(reply({ tables: ['DO_NOT_PUBLISH'] }));
    vi.stubGlobal('fetch', fetcher);
    const refused = transport.tenantReadApi('/api/schema');
    await expect(refused).rejects.toThrow(/Reload the page/);
    await expect(refused).rejects.toMatchObject({ status: 403, code: 'tenant_context_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session.sessionIdentity().mode).toBe('locked');
  },
);

test.each(['network', '503'])(
  'a read whose entry again hits a transient %s suspends the lease instead of locking the session',
  async (kind) => {
    session.establishTenantSelection(proof());
    const fetcher = vi.fn().mockResolvedValueOnce(unavailableContext());
    if (kind === 'network') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else
      fetcher.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'tenant_temporarily_unavailable', error: 'Busy' }), { status: 503 }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(transport.tenantReadApi('/api/schema')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session.sessionIdentity().mode).toBe('authenticated');
    expect(session.tenantLeaseActive()).toBe(false);
  },
);

test('renewTenant automatically re-enters when the server restarted and forgot the context', async () => {
  const original = proof(),
    entered = { ...original, tabId: 'tab-reentered', context: 'context-reentered' },
    owner = session.establishTenantSelection(original);
  const fetcher = vi.fn().mockResolvedValueOnce(unavailableContext()).mockResolvedValueOnce(reply(entered, entered));
  vi.stubGlobal('fetch', fetcher);
  const next = await transport.renewTenant(owner, original);
  expect(next).toEqual(entered);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0][0])).toMatch(/^\/api\/tenant\/context\/renew\?/);
  expect(String(fetcher.mock.calls[1][0])).toMatch(/^\/api\/tenant\/context\/open\?/);
  expect(session.sessionIdentity().mode).toBe('authenticated');
  expect(session.captureTenantLease()).toEqual(entered);
  expect(session.tenantLeaseActive()).toBe(true);
});

test('renewTenant locks only when re-entry is refused, and keeps transient errors recoverable', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const transientFetcher = vi
    .fn()
    .mockResolvedValueOnce(unavailableContext())
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Failover', code: 'tenant_temporarily_unavailable' }), { status: 503 }));
  vi.stubGlobal('fetch', transientFetcher);
  const transientError = await transport.renewTenant(owner, original).catch((error) => error);
  expect(transport.isTransientTenantFailure(transientError)).toBe(true);
  expect(session.sessionIdentity().mode).toBe('authenticated');

  const refusedFetcher = vi
    .fn()
    .mockResolvedValueOnce(unavailableContext())
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Denied', code: 'forbidden' }), { status: 403 }));
  vi.stubGlobal('fetch', refusedFetcher);
  await expect(transport.renewTenant(owner, original)).rejects.toMatchObject({ status: 403, code: 'tenant_context_unavailable' });
  expect(session.sessionIdentity().mode).toBe('locked');
});

test.each(['loader_failed', 'loader_timeout'])('a page loader %s error does not retry or suspend the tenant lease', async (code) => {
  const original = proof();
  session.establishTenantSelection(original);
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'This page could not load.', code }), { status: code === 'loader_timeout' ? 504 : 500 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(transport.tenantReadApi('/api/pages/load', { page: 'huddle' })).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(session.sessionIdentity().mode).toBe('authenticated');
  expect(session.tenantLeaseActive()).toBe(true);
});

test.each(['503', '429', 'network'])('a current %s is asked again with backoff before it suspends the read owner', async (kind) => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const fetcher =
    kind === 'network'
      ? vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
      : vi.fn(
          async () =>
            new Response(JSON.stringify({ error: 'Unavailable', code: 'tenant_temporarily_unavailable' }), { status: Number(kind) }),
        );
  vi.stubGlobal('fetch', fetcher);
  await expect(outwait(transport.tenantReadApi('/api/schema'))).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toEqual(original);
});

test('a read the audit could not record fails that read alone: asked once, the lease and the session left as they were', async () => {
  const original = proof(),
    owner = session.establishTenantSelection(original);
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'The read could not be recorded. Try again.', code: 'read_not_recorded' }), { status: 503 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const refused = transport.tenantReadApi('/api/query');
  await expect(refused).rejects.toMatchObject({ status: 503, code: 'read_not_recorded' });
  await expect(refused).rejects.not.toHaveProperty('transient');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(session.tenantLeaseActive()).toBe(true);
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
  else
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unavailable', code: 'tenant_temporarily_unavailable' }), { status: 503 }),
    );
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
          appId: 'desk',
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
          new Response(JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north', name }] })),
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
          JSON.stringify({ status: 'ready', appId: 'desk', accountId: 'alice', memberships: [{ tenantId: 'north', label: 'North' }] }),
        ),
      ),
  );
  await expect(transport.discoverTenants()).rejects.toThrow();
});

test("the page's boot answers each read it carries once, on the context it was read on", async () => {
  session.establishTenantSelection(proof());
  const { readKey } = await import('@mistriwork/engine/shared/firstPaint.js');
  const carried = {
    reads: {
      [readKey('GET', '/api/app?app=desk&tenant=north')]: { body: { appId: 'desk', app: { name: 'Desk' } } },
      [readKey('POST', '/api/run?app=desk&tenant=north', { q: 'item', limit: 50 })]: {
        body: { rows: [{ id: 'carried' }] },
        reads: 'item',
      },
    },
    items: {},
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(carried))
    .mockImplementation(async () => reply({ rows: [{ id: 'asked' }] }));
  vi.stubGlobal('fetch', fetcher);
  await boot.loadTenantBoot('/desk/items', '');
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/boot?app=desk&tenant=north');
  expect(JSON.parse(init.body)).toEqual({ path: '/desk/items', search: '' });
  expect(init.headers['x-mistri-context']).toBe('context-north');
  /* Each as the shell asks it, the App named or not: answered from the boot, with no request. */
  expect(await transport.tenantReadApi('/api/app?app=desk', undefined, 'desk')).toEqual({ appId: 'desk', app: { name: 'Desk' } });
  expect(await transport.tenantReadApi('/api/run', { q: 'item', limit: 50, app: 'desk' }, 'desk')).toEqual({ rows: [{ id: 'carried' }] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  /* Once: the same read again, and a read it did not carry, are asked. */
  expect(await transport.tenantReadApi('/api/run', { q: 'item', limit: 50 }, 'desk')).toEqual({ rows: [{ id: 'asked' }] });
  expect(await transport.tenantReadApi('/api/run', { q: 'item', limit: 25 }, 'desk')).toEqual({ rows: [{ id: 'asked' }] });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("a page's load comes with its entry: one request where the entry and then the load were two, and a held loader is not asked for", async () => {
  session.establishTenantSelection(proof());
  const { readKey } = await import('@mistriwork/engine/shared/firstPaint.js');
  const hints = await import('./pageLoadHints.js');
  localStorage.clear();
  /* As the page was last drawn there: `figure` asked as it opened, `office` held back until a parameter settled. */
  hints.notePageLoad('/desk/today', 'figure', true);
  hints.notePageLoad('/desk/today', 'office', true);
  hints.notePageLoad('/desk/today', 'office', false);
  const load = (loader: string) => ({ page: 'today', params: {}, loader });
  const carried = {
    reads: {
      [readKey('POST', '/api/pages/load?app=desk&tenant=north', load('today'))]: { body: { data: { lines: 2 } }, reads: 'item' },
      [readKey('POST', '/api/pages/load?app=desk&tenant=north', load('figure'))]: { body: { data: { n: 3 } } },
    },
    items: {},
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(carried))
    .mockImplementation(async () => reply({ data: 'asked' }));
  vi.stubGlobal('fetch', fetcher);
  await boot.loadTenantBoot('/desk/today', '');
  /* The page's `loader` is the host's to read unasked; of the others, only the one the page asked as it opened is named. */
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ path: '/desk/today', search: '', loaders: ['figure'] });
  /* The page draws, and asks its loads as it always did (sdk/host.tsx `load`): answered with no request, one wait in all. */
  expect(await transport.tenantReadApi('/api/pages/load', load('today'), 'desk')).toEqual({ data: { lines: 2 } });
  expect(await transport.tenantReadApi('/api/pages/load', load('figure'), 'desk')).toEqual({ data: { n: 3 } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  /* The held loader, once the page lets it go, and a load at another place, are asked: a second wait, theirs alone. */
  expect(await transport.tenantReadApi('/api/pages/load', load('office'), 'desk')).toEqual({ data: 'asked' });
  expect(await transport.tenantReadApi('/api/pages/load', { ...load('figure'), params: { who: 'ada' } }, 'desk')).toEqual({
    data: 'asked',
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  /* An address with nothing noted says no loaders, as before. */
  await boot.loadTenantBoot('/desk/items', '');
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ path: '/desk/items', search: '' });
  localStorage.clear();
});

test('a boot that does not attest the lease, or is refused, carries nothing and fences nothing', async () => {
  session.establishTenantSelection(proof());
  const { readKey } = await import('@mistriwork/engine/shared/firstPaint.js');
  const carried = {
    reads: { [readKey('GET', '/api/app?app=desk&tenant=north')]: { body: { appId: 'desk', app: { name: 'Stale' } } } },
    items: {},
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(carried, proof('north', 'context-other')))
    .mockResolvedValueOnce(reply({ error: 'The tenant context could not be verified.', code: 'tenant_context_unavailable' }, proof(), 403))
    .mockResolvedValue(reply({ appId: 'desk', app: { name: 'Asked' } }));
  vi.stubGlobal('fetch', fetcher);
  await boot.loadTenantBoot('/desk/items', '');
  await boot.loadTenantBoot('/desk/items', '');
  expect(session.tenantLeaseActive()).toBe(true);
  expect(await transport.tenantReadApi('/api/app', undefined, 'desk')).toEqual({ appId: 'desk', app: { name: 'Asked' } });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('reads asked in one moment go as one request on the lease, each taking its own answer', async () => {
  session.establishTenantSelection(proof());
  const { readKey } = await import('@mistriwork/engine/shared/firstPaint.js');
  const batch = {
    reads: {
      [readKey('POST', '/api/pages/compose?app=desk&tenant=north', { table: 'item', key: { id: 'n1' } })]: { body: { plan: 'composed' } },
      [readKey('POST', '/api/run?app=desk&tenant=north', { q: 'item', limit: 50 })]: {
        body: { rows: [{ id: 'batched' }] },
        reads: 'item',
      },
    },
    items: {},
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(batch))
    .mockImplementation(async () => reply({ counts: [3] }));
  vi.stubGlobal('fetch', fetcher);
  const { gatherReads } = await import('../../../kit/src/client/readGathering.js');
  /* A write's refresh: its reads belong together (kit client/readGathering.ts). */
  gatherReads();
  const [composed, rows, counts] = await Promise.all([
    transport.tenantReadApi('/api/pages/compose', { table: 'item', key: { id: 'n1' }, app: 'desk' }, 'desk'),
    transport.tenantReadApi('/api/run', { q: 'item', limit: 50 }, 'desk'),
    transport.tenantReadApi('/api/counts', { items: [] }, 'desk'),
  ]);
  expect(composed).toEqual({ plan: 'composed' });
  expect(rows).toEqual({ rows: [{ id: 'batched' }] });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/boot?app=desk&tenant=north');
  expect(init.headers['x-mistri-context']).toBe('context-north');
  expect(JSON.parse(init.body)).toEqual({
    reads: [
      { method: 'POST', path: '/api/pages/compose', body: { table: 'item', key: { id: 'n1' } } },
      { method: 'POST', path: '/api/run', body: { q: 'item', limit: 50 } },
      { method: 'POST', path: '/api/counts', body: { items: [] } },
    ],
  });
  /* The one the batch did not answer is asked alone, as ever. */
  expect(counts).toEqual({ counts: [3] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe('/api/counts?app=desk&tenant=north');
  /* Outside such a moment, reads asked together go as they always did, each alone. */
  await Promise.all([
    transport.tenantReadApi('/api/counts', { items: [] }, 'desk'),
    transport.tenantReadApi('/api/run', { q: 'x' }, 'desk'),
  ]);
  expect(fetcher.mock.calls.slice(2).map(([url]) => url)).toEqual(['/api/counts?app=desk&tenant=north', '/api/run?app=desk&tenant=north']);
  /* Alone in its moment, a read goes alone. */
  gatherReads();
  await transport.tenantReadApi('/api/counts', { items: [] }, 'desk');
  expect(fetcher.mock.calls[4][0]).toBe('/api/counts?app=desk&tenant=north');
});

/* A picker's and a related list's read can be gathered with a write's refresh, and a batch is one request: what each
   read is rides on its item, and a free-form page's own read, which says it by a header, is asked alone. */
test('a gathered picker or related read says what it is on its item, and a page read is not gathered', async () => {
  session.establishTenantSelection(proof());
  const { readKey } = await import('@mistriwork/engine/shared/firstPaint.js');
  const fetcher = vi.fn().mockImplementation(async (url: string, init: { body?: string }) =>
    url.startsWith('/api/boot')
      ? reply({
          reads: Object.fromEntries(
            JSON.parse(init.body!).reads.map((read: { path: string; body: object }) => [
              readKey('POST', `${read.path}?app=desk&tenant=north`, read.body),
              { body: { rows: [] } },
            ]),
          ),
          items: {},
        })
      : reply({ rows: [] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const { gatherReads } = await import('../../../kit/src/client/readGathering.js');
  gatherReads();
  await Promise.all([
    transport.tenantReadApi('/api/view/run', { view: { base: 'item' } }, 'desk', undefined, { 'x-mistri-read': 'picker' }),
    transport.tenantReadApi('/api/view/run', { view: { base: 'note' } }, 'desk', undefined, { 'x-mistri-read': 'related' }),
    transport.tenantReadApi('/api/run', { q: 'item' }, 'desk'),
    transport.tenantReadApi('/api/view/run', { view: { base: 'page' } }, 'desk', undefined, { 'x-mistri-page': 'board' }),
  ]);
  const boots = fetcher.mock.calls.filter(([url]) => url.startsWith('/api/boot'));
  expect(boots).toHaveLength(1);
  expect(JSON.parse(boots[0][1].body).reads).toEqual([
    { method: 'POST', path: '/api/view/run', body: { view: { base: 'item' } }, read: 'picker' },
    { method: 'POST', path: '/api/view/run', body: { view: { base: 'note' } }, read: 'related' },
    { method: 'POST', path: '/api/run', body: { q: 'item' } },
  ]);
  const alone = fetcher.mock.calls.find(([url]) => !url.startsWith('/api/boot'))!;
  expect(alone[1].headers['x-mistri-page']).toBe('board');
});

test('a host that will not batch for a lease is asked read by read from then on', async () => {
  session.establishTenantSelection(proof());
  const fetcher = vi.fn(async (url: string) =>
    url.startsWith('/api/boot') ? reply({ error: 'Not found.' }, proof(), 404) : reply({ rows: [{ id: url }] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const { gatherReads } = await import('../../../kit/src/client/readGathering.js');
  const both = () => {
    gatherReads();
    return Promise.all([
      transport.tenantReadApi('/api/run', { q: 'item' }, 'desk'),
      transport.tenantReadApi('/api/run', { q: 'other' }, 'desk'),
    ]);
  };
  expect(await both()).toEqual([
    { rows: [{ id: '/api/run?app=desk&tenant=north' }] },
    { rows: [{ id: '/api/run?app=desk&tenant=north' }] },
  ]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/boot?app=desk&tenant=north',
    '/api/run?app=desk&tenant=north',
    '/api/run?app=desk&tenant=north',
  ]);
  await both();
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith('/api/boot'))).toHaveLength(1);
  expect(session.tenantLeaseActive()).toBe(true);
});
