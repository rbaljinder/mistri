import { beforeEach, afterEach, expect, test, vi } from 'vitest';

let identity: typeof import('../../../kit/src/client/sessionIdentity.js');
let navigation: typeof import('./tenantNavigation.js');
let lifecycle: typeof import('../../../kit/src/client/sessionLifecycle.js');
const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const selected = (tenantId = 'north') => {
  identity.establishSessionIdentity({ signedIn: true, appId: 'app', accountId: 'alice' });
  identity.requireTenantSelection();
  return identity.establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId,
    tabId: 'tab',
    context: `context-${tenantId}`,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
};
const host = () => ({
  currentHref: () => '/app/item/~1?tenant=north',
  replace: vi.fn(),
  apply: vi.fn(),
  canLeave: vi.fn(async () => true),
  reload: vi.fn(),
  invalid: vi.fn(),
});
beforeEach(async () => {
  vi.resetModules();
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
  lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
  navigation = await import('./tenantNavigation.js');
  localStorage.clear();
  selected();
});
afterEach(() => {
  lifecycle.configureSessionLifecycle({ onLock: () => {} });
});

test('same-tenant history applies the qualified link without changing context or reopening selection', async () => {
  const owner = identity.sessionIdentity(),
    h = host();
  await navigation.followTenantHistory('/app/item/~2?tenant=north', h);
  expect(h.apply).toHaveBeenCalledExactlyOnceWith('/app/item/~2?tenant=north');
  expect(h.canLeave).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
});

/* An App parameter with no selector (`?context=stale`) is an unqualified App
   address since the link grammar keeps the App's own parameters (tenantLink.ts):
   it is never read as a context, and like any unqualified link it needs a fresh entry. */
test.each(['/app/item/~2?tenant=south', '/app/item/~2', '/app/item?context=stale'])(
  'foreign or unqualified %s requires locked fresh entry, never old-owner parsing',
  async (href) => {
    const h = host(),
      allowed = deferred(),
      owner = identity.sessionIdentity();
    h.canLeave.mockReturnValueOnce(allowed.promise);
    const follow = navigation.followTenantHistory(href, h);
    expect(h.replace).toHaveBeenCalledExactlyOnceWith(h.currentHref());
    expect(identity.sessionIdentity()).toBe(owner);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    h.reload.mockImplementation(() => expect(identity.sessionIdentity().mode).toBe('locked'));
    allowed.resolve(true);
    await follow;
    expect(h.replace).toHaveBeenLastCalledWith(href);
    expect(h.reload).toHaveBeenCalledOnce();
    expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
    expect(h.apply).not.toHaveBeenCalled();
  },
);

test.each(['cancel', 'refuse'])('%s editing exit retains current URL and context without reload', async (outcome) => {
  const h = host(),
    owner = identity.sessionIdentity();
  if (outcome === 'cancel') h.canLeave.mockResolvedValue(false);
  else h.canLeave.mockRejectedValue(new Error('Pending write'));
  await navigation.followTenantHistory('/app/item/~2?tenant=south', h);
  expect(h.replace).toHaveBeenCalledExactlyOnceWith(h.currentHref());
  expect(h.reload).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
});

test.each([
  '/app/item?tenant=south&tenant=north',
  '/other/item?tenant=south',
  '//evil.test/app?tenant=north',
  '/app/item?tab=open&tenant=north&tab=done',
])('invalid link %s refuses navigation and restores known URL without acquiring data', async (href) => {
  const h = host(),
    owner = identity.sessionIdentity();
  await navigation.followTenantHistory(href, h);
  expect(h.invalid).toHaveBeenCalledOnce();
  expect(h.replace).toHaveBeenCalledExactlyOnceWith(h.currentHref());
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.canLeave).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
});

test('late editing exit cannot reload after an independently replaced same-account context', async () => {
  const h = host(),
    allowed = deferred();
  h.canLeave.mockReturnValueOnce(allowed.promise);
  const follow = navigation.followTenantHistory('/app/item?tenant=south', h);
  const owner = selected('south');
  allowed.resolve(true);
  await follow;
  expect(identity.sessionIdentity()).toBe(owner);
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.replace).toHaveBeenCalledTimes(1);
});

test('a later history event supersedes a pending navigation even with the same owner', async () => {
  const h = host(),
    allowed = deferred();
  h.canLeave.mockReturnValueOnce(allowed.promise);
  const follow = navigation.followTenantHistory('/app/item?tenant=south', h);
  await navigation.followTenantHistory('/app/item/~3?tenant=north', h);
  allowed.resolve(true);
  await follow;
  expect(h.apply).toHaveBeenCalledExactlyOnceWith('/app/item/~3?tenant=north');
  expect(h.reload).not.toHaveBeenCalled();
});

test.each(['selection', 'metadata'])('history during pending %s retires callbacks and requires fresh document selection', async (stage) => {
  if (stage === 'selection') identity.requireTenantSelection();
  const h = host();
  await navigation.followTenantHistory('/app/item?tenant=south', h, stage !== 'metadata');
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.replace).not.toHaveBeenCalled();
  expect(h.canLeave).not.toHaveBeenCalled();
  expect(h.reload).toHaveBeenCalledOnce();
  expect(identity.sessionIdentity().mode).toBe('locked');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
});

test('locked identity cannot apply history or acquire a new context', async () => {
  identity.lockSessionIdentity();
  const h = host();
  await navigation.followTenantHistory('/app/item?tenant=south', h);
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
});
