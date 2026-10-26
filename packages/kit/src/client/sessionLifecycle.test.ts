import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let identity: typeof import('./sessionIdentity.js');
let lifecycle: typeof import('./sessionLifecycle.js');
let stop: (() => void) | undefined;
const account = (accountId = 'alice', appId = 'atlas') => ({ signedIn: true, accountId, appId });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(async () => {
  vi.resetModules();
  identity = await import('./sessionIdentity.js');
  lifecycle = await import('./sessionLifecycle.js');
  localStorage.clear();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  lifecycle.configureSessionLifecycle({ onLock: () => {} });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('anonymous and unknown sessions never dispatch automatic checks', async () => {
  const onCheck = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock: vi.fn(), onCheck });
  stop = lifecycle.startSessionMonitoring();
  window.dispatchEvent(new Event('focus'));
  await lifecycle.checkSessionIdentity();
  identity.establishSessionIdentity({ signedIn: false });
  await lifecycle.checkSessionIdentity();
  expect(onCheck).not.toHaveBeenCalled();
});

test('default check is App-scoped and bypasses browser cache, with stable identity preserved', async () => {
  const snapshot = identity.establishSessionIdentity(account());
  const fetcher = vi.fn().mockResolvedValue(response(account()));
  vi.stubGlobal('fetch', fetcher);
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock });
  await lifecycle.checkSessionIdentity();
  expect(fetcher).toHaveBeenCalledWith(
    '/api/whoami?app=atlas',
    expect.objectContaining({
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(identity.sessionIdentity()).toBe(snapshot);
  expect(onLock).not.toHaveBeenCalled();
});

const tenant = () => {
  identity.establishSessionIdentity(account());
  identity.requireTenantSelection();
  return identity.establishTenantSelection({
    appId: 'atlas',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab',
    context: 'context',
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
};

test('selected tenant monitoring verifies the captured context after the native account check', async () => {
  const owner = tenant(),
    order: string[] = [],
    onLock = vi.fn();
  const onContextCheck = vi.fn(async (snapshot, signal) => {
    expect(snapshot).toBe(owner);
    expect(signal).toBeInstanceOf(AbortSignal);
    order.push('context');
  });
  lifecycle.configureSessionLifecycle({
    onLock,
    onContextCheck,
    onCheck: async () => {
      order.push('account');
      return response(account());
    },
  });
  await lifecycle.checkSessionIdentity();
  expect(order).toEqual(['account', 'context']);
  expect(identity.sessionIdentity()).toBe(owner);
  expect(onLock).not.toHaveBeenCalled();
});

test.each(['missing verifier', 'refused context'])('unchanged account cannot preserve a tenant with %s', async (kind) => {
  tenant();
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({
    onLock,
    onCheck: async () => response(account()),
    ...(kind === 'refused context'
      ? {
          onContextCheck: async () => {
            throw new Error('Revoked');
          },
        }
      : {}),
  });
  await lifecycle.checkSessionIdentity();
  expect(onLock).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(identity.sessionIdentity().mode).toBe('locked');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
});

test('an unselected tenant account checks native identity without issuing a context request', async () => {
  tenant();
  identity.requireTenantSelection();
  const onContextCheck = vi.fn(),
    onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onContextCheck, onCheck: async () => response(account()) });
  await lifecycle.checkSessionIdentity();
  expect(onContextCheck).not.toHaveBeenCalled();
  expect(onLock).not.toHaveBeenCalled();
});

test('tenant context timeout aborts and locks without waiting for an uncooperative provider', async () => {
  vi.useFakeTimers();
  tenant();
  const onLock = vi.fn();
  let signal!: AbortSignal;
  lifecycle.configureSessionLifecycle({
    onLock,
    timeoutMs: 100,
    onCheck: async () => response(account()),
    onContextCheck: (_snapshot, current) => {
      signal = current;
      return new Promise(() => {});
    },
  });
  const checking = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(101);
  await checking;
  expect(signal.aborted).toBe(true);
  expect(onLock).toHaveBeenCalledExactlyOnceWith('unavailable');
});

test('late context refusal cannot lock a newer tenant generation for the same account', async () => {
  tenant();
  const checked = deferred<void>(),
    onLock = vi.fn(),
    onContextCheck = vi.fn(() => checked.promise);
  lifecycle.configureSessionLifecycle({ onLock, onContextCheck, onCheck: async () => response(account()) });
  const checking = lifecycle.checkSessionIdentity();
  await vi.waitFor(() => expect(onContextCheck).toHaveBeenCalledOnce());
  const next = tenant();
  checked.reject(new Error('Old context retired'));
  await checking;
  expect(identity.sessionIdentity()).toBe(next);
  expect(onLock).not.toHaveBeenCalled();
});

test.each([
  ['401', () => response({}, 401), 'expired'],
  ['signed out', () => response({ signedIn: false }), 'expired'],
  ['account changed', () => response(account('bob')), 'account-changed'],
  ['App changed', () => response(account('alice', 'finance')), 'account-changed'],
  ['malformed', () => response({ signedIn: true }), 'unavailable'],
  ['server unavailable', () => response({}, 503), 'unavailable'],
] as const)('%s locks synchronously without reloading', async (_, result, reason) => {
  identity.establishSessionIdentity(account());
  const onReload = vi.fn();
  const onLock = vi.fn(() => expect(identity.sessionIdentity().mode).toBe('locked'));
  lifecycle.configureSessionLifecycle({ onLock, onReload, onCheck: async () => result() });
  await lifecycle.checkSessionIdentity();
  expect(onLock).toHaveBeenCalledExactlyOnceWith(reason);
  expect(onReload).not.toHaveBeenCalled();
});

test('network error and timeout lock as unavailable once the retry fails too, without claiming sign-out or notifying other tabs', async () => {
  vi.useFakeTimers();
  const onLock = vi.fn();
  identity.establishSessionIdentity(account());
  const offline = vi.fn(async () => {
    throw new Error('Offline');
  });
  lifecycle.configureSessionLifecycle({ onLock, onCheck: offline });
  const first = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(0);
  expect(onLock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_250);
  await first;
  expect(offline).toHaveBeenCalledTimes(2);
  expect(onLock).toHaveBeenLastCalledWith('unavailable');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
  identity.establishSessionIdentity(account());
  const silent = vi.fn(() => new Promise<Response>(() => {}));
  lifecycle.configureSessionLifecycle({ onLock, onCheck: silent, timeoutMs: 100 });
  const check = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(101);
  expect(onLock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_250 + 101);
  await check;
  expect(silent).toHaveBeenCalledTimes(2);
  expect(onLock).toHaveBeenCalledTimes(2);
  expect(identity.sessionIdentity().mode).toBe('locked');
});

test.each([
  ['a network error', () => Promise.reject(new Error('Offline'))],
  ['a 502', () => Promise.resolve(response({}, 502))],
  ['a 503', () => Promise.resolve(response({}, 503))],
  ['a 504', () => Promise.resolve(response({}, 504))],
])('one transient failure (%s) is retried after a short pause, and a good answer keeps the session', async (_kind, failure) => {
  vi.useFakeTimers();
  const snapshot = identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const onCheck = vi.fn().mockImplementationOnce(failure).mockResolvedValueOnce(response(account()));
  lifecycle.configureSessionLifecycle({ onLock, onCheck });
  const check = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(700);
  expect(onCheck).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(600);
  await check;
  expect(onCheck).toHaveBeenCalledTimes(2);
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(snapshot);
});

test('a whoami past its deadline is asked again on a fresh deadline, and an answer in time keeps the session', async () => {
  vi.useFakeTimers();
  const snapshot = identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const signals: AbortSignal[] = [];
  const onCheck = vi.fn((_snapshot: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(response(account()));
  });
  lifecycle.configureSessionLifecycle({ onLock, onCheck, timeoutMs: 100 });
  const check = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(101);
  expect(signals[0].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1_250);
  await check;
  expect(onCheck).toHaveBeenCalledTimes(2);
  expect(signals[1].aborted).toBe(false);
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(snapshot);
});

test.each([
  ['401', () => response({}, 401), 'expired'],
  ['403', () => response({}, 403), 'unavailable'],
  ['another person', () => response(account('mallory')), 'account-changed'],
  ['signed out', () => response({ signedIn: false }), 'expired'],
  ['a 500', () => response({}, 500), 'unavailable'],
])('a definite answer (%s) locks at once, with no retry', async (_kind, answer, reason) => {
  vi.useFakeTimers();
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const onCheck = vi.fn(async () => answer());
  lifecycle.configureSessionLifecycle({ onLock, onCheck });
  await lifecycle.checkSessionIdentity();
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onLock).toHaveBeenCalledExactlyOnceWith(reason);
  expect(identity.sessionIdentity().mode).toBe('locked');
});

test('a newer account during the pause cancels the retry, and nothing is locked', async () => {
  vi.useFakeTimers();
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const onCheck = vi.fn(async () => response({}, 503));
  lifecycle.configureSessionLifecycle({ onLock, onCheck });
  const check = lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(10);
  identity.establishSessionIdentity(account('bob'));
  await vi.advanceTimersByTimeAsync(1_300);
  await check;
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity().accountId).toBe('bob');
});

test('overlapping focus checks coalesce and stale responses cannot lock a newer account', async () => {
  identity.establishSessionIdentity(account());
  const first = deferred<Response>();
  const onCheck = vi.fn().mockReturnValue(first.promise);
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onCheck });
  const check = lifecycle.checkSessionIdentity();
  expect(lifecycle.checkSessionIdentity()).toBe(check);
  identity.establishSessionIdentity(account('bob'));
  first.resolve(response({}, 401));
  await check;
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity().accountId).toBe('bob');
});

test('stale body parsing and network errors cannot affect a newer identity', async () => {
  identity.establishSessionIdentity(account());
  const body = deferred<unknown>();
  const result = response(account());
  const parsing = vi.spyOn(result, 'json').mockReturnValue(body.promise);
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onCheck: async () => result });
  const check = lifecycle.checkSessionIdentity();
  // The body is being read when the identity changes.
  await vi.waitFor(() => expect(parsing).toHaveBeenCalled());
  identity.establishSessionIdentity(account('bob'));
  body.reject(new Error('Disconnected'));
  await check;
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity().accountId).toBe('bob');
});

test('sign-out locks once and broadcasts an opaque nonce, while reload remains explicit', () => {
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const onReload = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onReload });
  lifecycle.beginSessionSignOut();
  const notice = localStorage.getItem(lifecycle.SESSION_CHANGE_KEY);
  expect(notice).toMatch(/^[\da-f-]{36}$/);
  expect(notice).not.toContain('alice');
  lifecycle.beginSessionSignOut();
  expect(onLock).toHaveBeenCalledExactlyOnceWith('signed-out');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBe(notice);
  expect(onReload).not.toHaveBeenCalled();
  lifecycle.reloadSession();
  expect(onReload).toHaveBeenCalledOnce();
});

test('cross-tab notices lock without echo and ignore unrelated/sessionStorage notices', () => {
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock });
  stop = lifecycle.startSessionMonitoring();
  window.dispatchEvent(new StorageEvent('storage', { key: 'mistri.theme', newValue: 'dark' }));
  window.dispatchEvent(new StorageEvent('storage', { key: lifecycle.SESSION_CHANGE_KEY, newValue: 'nonce', storageArea: sessionStorage }));
  expect(onLock).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent('storage', { key: lifecycle.SESSION_CHANGE_KEY, newValue: 'nonce', storageArea: localStorage }));
  expect(onLock).toHaveBeenCalledExactlyOnceWith('other-tab');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
});

test('foreground/resume and visible periodic checks run; cleanup cancels and discards pending work', async () => {
  vi.useFakeTimers();
  identity.establishSessionIdentity(account());
  const onCheck = vi.fn().mockImplementation(async () => response(account()));
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onCheck, intervalMs: 100 });
  stop = lifecycle.startSessionMonitoring();
  expect(lifecycle.startSessionMonitoring()).toBe(stop);
  window.dispatchEvent(new Event('pageshow'));
  await lifecycle.checkSessionIdentity();
  expect(onCheck).toHaveBeenCalledTimes(1);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await vi.advanceTimersByTimeAsync(100);
  expect(onCheck).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await lifecycle.checkSessionIdentity();
  await vi.advanceTimersByTimeAsync(100);
  expect(onCheck).toHaveBeenCalledTimes(3);
  const delayed = deferred<Response>();
  onCheck.mockReturnValue(delayed.promise);
  const check = lifecycle.checkSessionIdentity();
  stop();
  delayed.resolve(response({}, 401));
  await check;
  await vi.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event('focus'));
  expect(onCheck).toHaveBeenCalledTimes(4);
  expect(onLock).not.toHaveBeenCalled();
});

test('disabled storage does not prevent the local lock callback', () => {
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock });
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Disabled');
  });
  expect(() => lifecycle.beginSessionSignOut()).not.toThrow();
  expect(onLock).toHaveBeenCalledExactlyOnceWith('signed-out');
});

test('BFCache parking locks the captured surface without broadcasting or reloading', () => {
  const pageEvent = (name: string, persisted: boolean) => {
    const event = new Event(name);
    Object.defineProperty(event, 'persisted', { value: persisted });
    return event;
  };
  identity.establishSessionIdentity(account());
  const onLock = vi.fn();
  const onReload = vi.fn();
  const onCheck = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock, onReload, onCheck });
  stop = lifecycle.startSessionMonitoring();
  window.dispatchEvent(pageEvent('pagehide', false));
  expect(onLock).not.toHaveBeenCalled();
  window.dispatchEvent(pageEvent('pagehide', true));
  expect(onLock).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(identity.sessionIdentity().mode).toBe('locked');
  expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
  window.dispatchEvent(pageEvent('pageshow', true));
  expect(onCheck).not.toHaveBeenCalled();
  expect(onReload).not.toHaveBeenCalled();
  stop();
  identity.establishSessionIdentity(account());
  window.dispatchEvent(pageEvent('pagehide', true));
  expect(onLock).toHaveBeenCalledTimes(1);
  expect(identity.sessionIdentity().mode).toBe('authenticated');
});

test.each(['network', '503', 'timeout', 'context network', 'context timeout'])(
  'tenant %s suspends through the seam without retiring drafts',
  async (failure) => {
    vi.useFakeTimers();
    const owner = tenant(),
      onLock = vi.fn();
    const onTenantSuspend = vi.fn((snapshot) => identity.suspendTenantLease(snapshot));
    lifecycle.configureSessionLifecycle({
      onLock,
      onTenantSuspend,
      timeoutMs: 100,
      onCheck: async () => {
        if (failure === 'network') throw new Error('Offline');
        if (failure === 'timeout') return new Promise(() => {});
        return response(account(), failure === '503' ? 503 : 200);
      },
      onContextCheck: async () => {
        if (failure === 'context timeout') return new Promise(() => {});
        if (failure === 'context network') throw new Error('Offline');
      },
    });
    const checking = lifecycle.checkSessionIdentity();
    // A network error, a 503 and a timeout are each asked once more after the pause before the tenant is suspended.
    await vi.advanceTimersByTimeAsync(101 + 1_250 + 101);
    await checking;
    expect(onTenantSuspend).toHaveBeenCalledExactlyOnceWith(owner);
    expect(onLock).not.toHaveBeenCalled();
    expect(identity.sessionIdentity()).toBe(owner);
    expect(identity.tenantLeaseActive()).toBe(false);
    expect(localStorage.getItem(lifecycle.SESSION_CHANGE_KEY)).toBeNull();
  },
);

test.each(['401', 'signed out', 'changed account', 'context denied'])(
  'tenant suspension never bypasses a confirmed %s',
  async (failure) => {
    tenant();
    const onLock = vi.fn(),
      onTenantSuspend = vi.fn();
    lifecycle.configureSessionLifecycle({
      onLock,
      onTenantSuspend,
      onCheck: async () =>
        failure === '401'
          ? response({}, 401)
          : failure === 'signed out'
            ? response({ signedIn: false })
            : response(account(failure === 'changed account' ? 'bob' : 'alice')),
      onContextCheck: async () => {
        throw Object.assign(new Error('Denied'), { code: 'tenant_context_unavailable' });
      },
    });
    await lifecycle.checkSessionIdentity();
    expect(onLock).toHaveBeenCalledOnce();
    expect(onTenantSuspend).not.toHaveBeenCalled();
    expect(identity.sessionIdentity().mode).toBe('locked');
  },
);

test('tenant BFCache parking suspends and resume verifies both account and context', async () => {
  const owner = tenant(),
    onLock = vi.fn(),
    onContextCheck = vi.fn(async () => {});
  const onTenantSuspend = vi.fn((snapshot) => identity.suspendTenantLease(snapshot));
  lifecycle.configureSessionLifecycle({ onLock, onTenantSuspend, onContextCheck, onCheck: async () => response(account()) });
  stop = lifecycle.startSessionMonitoring();
  const parking = new Event('pagehide');
  Object.defineProperty(parking, 'persisted', { value: true });
  window.dispatchEvent(parking);
  expect(onTenantSuspend).toHaveBeenCalledExactlyOnceWith(owner);
  expect(onLock).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
  window.dispatchEvent(new Event('pageshow'));
  await lifecycle.checkSessionIdentity();
  expect(onContextCheck).toHaveBeenCalledOnce();
  expect(onLock).not.toHaveBeenCalled();
});

test('unavailable old checks cannot suspend a newly selected context', async () => {
  tenant();
  const result = deferred<Response>(),
    onTenantSuspend = vi.fn();
  lifecycle.configureSessionLifecycle({ onLock: vi.fn(), onTenantSuspend, onCheck: () => result.promise });
  const checking = lifecycle.checkSessionIdentity();
  const owner = tenant();
  result.reject(new Error('Offline'));
  await checking;
  expect(onTenantSuspend).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(true);
});

test('ordinary Apps retain unavailable retirement even with a tenant suspension callback', async () => {
  identity.establishSessionIdentity(account());
  const onLock = vi.fn(),
    onTenantSuspend = vi.fn();
  lifecycle.configureSessionLifecycle({
    onLock,
    onTenantSuspend,
    retryDelayMs: 0,
    onCheck: async () => {
      throw new Error('Offline');
    },
  });
  await lifecycle.checkSessionIdentity();
  expect(onLock).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(onTenantSuspend).not.toHaveBeenCalled();
});
