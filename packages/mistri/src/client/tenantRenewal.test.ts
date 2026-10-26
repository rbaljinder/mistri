import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TenantContextReply } from '../shared/tenantContext.js';
import type { TenantRenewalOptions } from './tenantRenewal.js';

let identity: typeof import('../../../kit/src/client/sessionIdentity.js');
let renewal: typeof import('./tenantRenewal.js');
let controller: ReturnType<typeof renewal.startTenantRenewal> | undefined;
const renew = vi.fn<NonNullable<TenantRenewalOptions['renew']>>();
const reply = (revision = 1, lifetime = 10000): TenantContextReply => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId: 'north',
  tabId: 'tab',
  context: 'context',
  revision,
  expiresAt: Date.now() + lifetime,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function select(value = reply()) {
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  identity.requireTenantSelection();
  return identity.establishTenantSelection(value);
}
function start(options: TenantRenewalOptions = {}) {
  controller = renewal.startTenantRenewal({ renew, timeoutMs: 100, retryMs: 1000, ...options });
  return controller;
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  renew.mockReset();
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  renewal = await import('./tenantRenewal.js');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  select();
});
afterEach(() => {
  controller?.stop();
  controller = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('proactive renewal preserves owner, epoch, scoped storage and identity listeners', async () => {
  const owner = identity.sessionIdentity(),
    key = identity.sessionStorageKey('draft'),
    listener = vi.fn();
  const unsubscribe = identity.subscribeSessionIdentity(listener);
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1));
  start();
  await vi.advanceTimersByTimeAsync(7999);
  expect(renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ revision: 1 }), expect.any(AbortSignal));
  expect(identity.captureTenantLease()?.revision).toBe(2);
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.sessionStorageKey('draft')).toBe(key);
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
  await vi.advanceTimersByTimeAsync(2000);
  expect(identity.tenantLeaseActive()).toBe(true);
});

test('overlapping checks share one request and recover the identical retained attempt after a lost acknowledgement', async () => {
  const lost = deferred<TenantContextReply>(),
    recovered = deferred<TenantContextReply>();
  renew.mockReturnValueOnce(lost.promise).mockReturnValueOnce(recovered.promise);
  const c = start(),
    first = c.check(),
    handled = first.catch(() => {});
  expect(c.check()).toBe(first);
  await vi.advanceTimersByTimeAsync(0);
  const exact = renew.mock.calls[0][1];
  lost.reject(new Error('Lost ack'));
  await handled;
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(identity.captureTenantLease()).toBe(exact);
  const retry = c.check();
  expect(c.check()).toBe(retry);
  await vi.advanceTimersByTimeAsync(0);
  expect(renew.mock.calls[1][1]).toBe(exact);
  recovered.resolve(reply(2));
  await retry;
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(renew).toHaveBeenCalledTimes(2);
});

test('timeout is bounded even for an uncooperative provider; late success cannot publish', async () => {
  const late = deferred<TenantContextReply>(),
    onState = vi.fn();
  renew.mockReturnValueOnce(late.promise).mockReturnValue(new Promise(() => {}));
  const c = start({ onState }),
    checking = c.check().catch(() => {});
  await vi.advanceTimersByTimeAsync(101);
  await checking;
  expect(renew.mock.calls[0][2]?.aborted).toBe(true);
  // A server too slow to renew is not a revocation: the running lease keeps the page open (G172).
  expect(onState).toHaveBeenLastCalledWith({
    suspended: false,
    busy: false,
    offline: false,
  });
  late.resolve(reply(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(identity.captureTenantLease()?.revision).toBe(1);
  expect(identity.tenantLeaseActive()).toBe(true);
});

test('a slow or busy renewal retries the same attempt on the backoff while the lease runs, and fences only at its deadline (G172)', async () => {
  const onState = vi.fn();
  renew.mockRejectedValue(Object.assign(new Error('Unavailable'), { transient: true }));
  const c = start({ onState, retryMs: 1000, maxRetryMs: 2000 });
  await c.check().catch(() => {});
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ suspended: true }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(new Set(renew.mock.calls.map((call) => call[1])).size).toBe(1);
  // The lease's own deadline still fences, however patient the retries are.
  await vi.advanceTimersByTimeAsync(9000);
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ suspended: true }));
  // Once a slow renewal answers, the page resumes.
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1));
  await c.check();
  expect(identity.tenantLeaseActive()).toBe(true);
});

test.each(['refusal', 'unverified receipt'])('an explicit renewal %s still suspends at once', async (kind) => {
  const onState = vi.fn();
  renew.mockRejectedValue(
    kind === 'refusal'
      ? Object.assign(new Error('Refused'), {
          status: 409,
          code: 'tenant_lease_stale',
        })
      : new Error('The tenant context is unavailable.'),
  );
  const c = start({ onState });
  await c.check().catch(() => {});
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(onState).toHaveBeenLastCalledWith({
    suspended: true,
    busy: false,
    offline: false,
  });
});

test('automatic retries back off to a cap and manual retry can run immediately', async () => {
  renew.mockRejectedValue(new Error('Offline'));
  const c = start({ maxRetryMs: 2000 });
  await c.check().catch(() => {});
  expect(renew).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(renew).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(renew).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2001);
  expect(renew).toHaveBeenCalledTimes(4);
  await c.check().catch(() => {});
  expect(renew).toHaveBeenCalledTimes(5);
  expect(new Set(renew.mock.calls.map((call) => call[1])).size).toBe(1);
});

test('expired exact receipt remains suspended and issues one fresh next-revision renewal before resume', async () => {
  const owner = identity.sessionIdentity(),
    followup = deferred<TenantContextReply>();
  const expired = reply(2, -1),
    states: boolean[] = [],
    onResume = vi.fn();
  identity.suspendTenantLease(owner);
  renew.mockResolvedValueOnce(expired).mockReturnValueOnce(followup.promise);
  const c = start({ onState: (state) => states.push(state.suspended), onResume }),
    checking = c.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(renew.mock.calls[1][1]).toEqual(expired);
  expect(identity.captureTenantLease()?.revision).toBe(2);
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(states.every(Boolean)).toBe(true);
  expect(onResume).not.toHaveBeenCalled();
  followup.resolve(reply(3));
  await checking;
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(onResume).toHaveBeenCalledExactlyOnceWith(owner);
});

test('an expired fresh follow-up is bounded and does not spin or expose data', async () => {
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1, -1));
  const c = start();
  await expect(c.check()).rejects.toThrow(/expired/);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(identity.tenantLeaseActive()).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(renew).toHaveBeenCalledTimes(2);
});

test.each(['offline', 'pagehide'])('%s immediately suspends without changing the owner', async (event) => {
  const owner = identity.sessionIdentity(),
    onResume = vi.fn();
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1));
  start({ onResume });
  if (event === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  window.dispatchEvent(new Event(event));
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(false);
  if (event === 'offline') {
    await vi.advanceTimersByTimeAsync(20000);
    expect(renew).not.toHaveBeenCalled();
  }
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(onResume).toHaveBeenCalledOnce();
});

test('pagehide parks before suspension so its lease listener cannot renew until pageshow', async () => {
  const owner = identity.sessionIdentity();
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1));
  start();
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(0);
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(renew).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('pageshow'));
  await vi.advanceTimersByTimeAsync(0);
  expect(renew).toHaveBeenCalledOnce();
  expect(identity.tenantLeaseActive()).toBe(true);
});

test('ordinary blur and a short hidden interval keep an unexpired lease active until foreground verification', async () => {
  const owner = identity.sessionIdentity();
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1));
  start();
  window.dispatchEvent(new Event('blur'));
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(true);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(renew).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(renew).toHaveBeenCalledOnce();
});

test('a hidden page still blocks data at expiry and rejects a late renewal after pagehide interruption', async () => {
  select(reply(1, 100));
  const late = deferred<TenantContextReply>();
  renew.mockReturnValue(late.promise);
  start({ timeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(80);
  expect(renew).toHaveBeenCalledOnce();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(20);
  expect(identity.tenantLeaseActive()).toBe(false);
  window.dispatchEvent(new Event('pagehide'));
  late.resolve(reply(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(identity.captureTenantLease()?.revision).toBe(1);
  expect(identity.tenantLeaseActive()).toBe(false);
  visibility.mockRestore();
});

test('lease expiry covers private data at equality while a renewal reply is held', async () => {
  select(reply(1, 100));
  renew.mockReturnValue(new Promise(() => {}));
  const onState = vi.fn();
  start({ timeoutMs: 1000, onState });
  await vi.advanceTimersByTimeAsync(99);
  expect(identity.tenantLeaseActive()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(onState.mock.calls.at(-1)?.[0].suspended).toBe(true);
  expect(identity.sessionIdentity().mode).toBe('authenticated');
});

test.each(['switch', 'logout', 'A to B to A'])('late renewal and timers cannot revive ownership after %s', async (change) => {
  const old = deferred<TenantContextReply>();
  renew.mockReturnValue(old.promise);
  const c = start();
  const checking = c.check().catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  if (change === 'logout') identity.lockSessionIdentity();
  else {
    select({ ...reply(), tenantId: 'south', context: 'south' });
    if (change === 'A to B to A') select();
  }
  const owner = identity.sessionIdentity();
  old.resolve(reply(2));
  await checking;
  await vi.advanceTimersByTimeAsync(60000);
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.captureTenantLease()?.revision).not.toBe(2);
  expect(renew).toHaveBeenCalledOnce();
});

test('an unavailable account check aborts renewal and cannot be undone by a racing reply', async () => {
  const replyPending = deferred<TenantContextReply>();
  renew.mockReturnValue(replyPending.promise);
  const c = start(),
    checking = c.check().catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  replyPending.resolve(reply(2));
  c.suspend();
  await checking;
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(identity.captureTenantLease()?.revision).toBe(1);
});

test('transport suspension triggers immediate foreground renewal instead of waiting for the proactive window', async () => {
  select(reply(1, 300000));
  renew.mockImplementation(async (_owner, expected) => reply(expected.revision + 1, 300000));
  const onResume = vi.fn();
  start({ onResume });
  identity.suspendTenantLease();
  await vi.advanceTimersByTimeAsync(0);
  expect(renew).toHaveBeenCalledOnce();
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(onResume).toHaveBeenCalledOnce();
});

test('duplicate wake listeners join a started context check without aborting or renewing twice', async () => {
  const answer = deferred<TenantContextReply>();
  renew.mockReturnValue(answer.promise);
  const c = start();
  const checking = c.check();
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  expect(renew.mock.calls[0][2]?.aborted).toBe(false);
  expect(c.check()).toBe(checking);
  answer.resolve(reply(2));
  await checking;
  expect(renew).toHaveBeenCalledOnce();
  expect(identity.tenantLeaseActive()).toBe(true);
});

test.each(['backward', 'invalid'])('%s clock suspends conservatively without dispatching', async (clock) => {
  const c = start();
  vi.spyOn(Date, 'now').mockReturnValue(clock === 'invalid' ? NaN : Date.now() - 1);
  await expect(c.check()).rejects.toThrow();
  expect(renew).not.toHaveBeenCalled();
  expect(identity.sessionIdentity().mode).toBe('authenticated');
  expect(identity.tenantLeaseActive()).toBe(false);
});
