import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TenantContextReply } from '../shared/tenantContext.js';
import type { TenantMutationAttempt, TenantMutationKind } from './tenantMutationState.js';

let session: typeof import('../../../kit/src/client/sessionIdentity.js');
let state: (typeof import('./tenantMutationState.js'))['tenantMutationState'];
const account = (accountId = 'alice', appId = 'atlas') => ({ signedIn: true, accountId, appId });
const proof = (overrides: Partial<TenantContextReply> = {}): TenantContextReply => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId: 'north',
  tabId: 'tab-one',
  context: 'context-north',
  revision: 1,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});
function select(overrides: Partial<TenantContextReply> = {}) {
  const value = proof(overrides);
  session.establishSessionIdentity(account(value.accountId, value.appId));
  session.requireTenantSelection();
  return session.establishTenantSelection(value);
}
function start(kind: TenantMutationKind = 'update'): TenantMutationAttempt {
  const attempt = state.start(kind);
  expect(attempt).toBeDefined();
  return attempt!;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  session = await import('../../../kit/src/client/sessionIdentity.js');
  ({ tenantMutationState: state } = await import('./tenantMutationState.js'));
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

test.each(['update', 'insert', 'delete', 'command'] as const)('%s captures exact selected owner with a unique frozen handle', (kind) => {
  const owner = select();
  const first = start(kind),
    second = start(kind);
  expect(first.identity).toBe(owner);
  expect(second.identity).toBe(owner);
  expect(first.kind).toBe(kind);
  expect(typeof first.id).toBe('symbol');
  expect(first).not.toBe(second);
  expect(first.id).not.toBe(second.id);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.keys(first).sort()).toEqual(['id', 'identity', 'kind']);
  expect(state.hasUnresolved()).toBe(true);
});

test.each(['unknown', 'anonymous', 'ordinary', 'unselected', 'locked', 'expired'] as const)(
  '%s identity does not create tenant tracking or affect ordinary Apps',
  (mode) => {
    if (mode === 'anonymous') session.establishSessionIdentity({ signedIn: false });
    if (mode === 'ordinary' || mode === 'unselected') session.establishSessionIdentity(account());
    if (mode === 'unselected') session.requireTenantSelection();
    if (mode === 'locked') {
      select();
      session.lockSessionIdentity();
    }
    if (mode === 'expired') {
      const owner = select();
      vi.spyOn(Date, 'now').mockReturnValue(session.captureTenantLease(owner)!.expiresAt);
    }
    const subscriber = vi.fn();
    state.subscribe(subscriber);
    for (const kind of ['update', 'insert', 'delete', 'command'] as const) expect(state.start(kind)).toBeUndefined();
    expect(state.unknown(undefined)).toBe(false);
    expect(state.settle(undefined)).toBe(false);
    expect(state.hasUnresolved()).toBe(false);
    expect(state.version()).toBe(0);
    expect(subscriber).not.toHaveBeenCalled();
  },
);

test.each([NaN, Infinity, -Infinity])('nonfinite clock %s cannot admit a mutation', (instant) => {
  select();
  vi.spyOn(Date, 'now').mockReturnValue(instant);
  expect(state.start('update')).toBeUndefined();
  expect(state.hasUnresolved()).toBe(false);
});

test('a stale or structurally copied owner cannot start or inspect another generation', () => {
  const old = select();
  const owner = select({ tenantId: 'south', context: 'context-south' });
  expect(state.start('update', old)).toBeUndefined();
  expect(state.start('update', { ...owner })).toBeUndefined();
  start();
  expect(state.hasUnresolved(old)).toBe(false);
  expect(state.hasUnresolved({ ...owner })).toBe(false);
  expect(state.hasUnresolved(owner)).toBe(true);
});

test('unsupported families including Undo cannot create entries', () => {
  select();
  for (const kind of ['undo', 'read', '', null, undefined]) {
    expect(Reflect.apply(state.start, state, [kind])).toBeUndefined();
  }
  expect(state.hasUnresolved()).toBe(false);
});

test.each(['update', 'insert', 'delete', 'command'] as const)('%s pending and unknown survive subscriber unmount', (kind) => {
  select();
  const firstComponent = vi.fn(),
    unsubscribe = state.subscribe(firstComponent);
  const attempt = start(kind);
  unsubscribe();
  unsubscribe();
  expect(state.hasUnresolved()).toBe(true);
  expect(state.unknown(attempt)).toBe(true);
  expect(state.hasUnresolved()).toBe(true);
  expect(firstComponent).toHaveBeenCalledTimes(1);
  const nextComponent = vi.fn();
  state.subscribe(nextComponent);
  expect(state.settle(attempt)).toBe(true);
  expect(state.hasUnresolved()).toBe(false);
  expect(nextComponent).toHaveBeenCalledTimes(1);
});

test('settlement removes only its exact attempt, not newer work of the same kind', () => {
  select();
  const old = start(),
    newer = start(),
    insert = start('insert');
  state.unknown(old);
  expect(state.settle(old)).toBe(true);
  expect(state.settle(old)).toBe(false);
  expect(state.unknown(old)).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(insert)).toBe(true);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(newer)).toBe(true);
  expect(state.hasUnresolved()).toBe(false);
});

test('copied, forged and proxy handles cannot settle a real attempt or invoke traps', () => {
  select();
  const attempt = start();
  const trap = vi.fn(() => {
    throw new Error('Unexpected access');
  });
  const proxy = new Proxy(attempt, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const handle of [{ ...attempt }, { ...attempt, id: Symbol('tenant-mutation') }, proxy]) {
    expect(state.unknown(handle)).toBe(false);
    expect(state.settle(handle)).toBe(false);
  }
  expect(trap).not.toHaveBeenCalled();
  expect(state.hasUnresolved()).toBe(true);
});

test('subscriptions expose a stable revision, with no notifications for idempotent/stale work', () => {
  select();
  const revisions: number[] = [];
  const unsubscribe = state.subscribe(() => {
    revisions.push(state.version());
  });
  expect(state.version()).toBe(0);
  const attempt = start();
  expect(state.unknown(attempt)).toBe(true);
  expect(state.unknown(attempt)).toBe(false);
  expect(state.settle(attempt)).toBe(true);
  expect(state.settle(attempt)).toBe(false);
  expect(revisions).toEqual([1, 2, 3]);
  unsubscribe();
  start('delete');
  expect(revisions).toEqual([1, 2, 3]);
});

test.each([
  { tenantId: 'south', context: 'context-south' },
  { context: 'context-new' },
  { tabId: 'tab-two' },
  { appId: 'other-app' },
  { accountId: 'bob' },
  {},
])('new selection %j retires all old entries even if token values are reused', (change) => {
  const oldOwner = select(),
    old = start('insert');
  state.unknown(old);
  start('command');
  const changed = vi.fn();
  state.subscribe(changed);
  const newOwner = select(change);
  expect(newOwner).not.toBe(oldOwner);
  expect(state.hasUnresolved()).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
  const current = start('insert');
  expect(state.settle(old)).toBe(false);
  expect(state.unknown(old)).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(current)).toBe(true);
});

test('same-account relogin cannot preserve or clear a former login attempt', () => {
  const oldOwner = select(),
    old = start('delete');
  session.lockSessionIdentity();
  const newOwner = select({ ...oldOwner.tenant });
  expect(newOwner.tenant).toEqual(oldOwner.tenant);
  expect(newOwner.epoch).toBeGreaterThan(oldOwner.epoch);
  const current = start('delete');
  expect(state.settle(old)).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(current)).toBe(true);
});

test('unchanged WHOAMI identity and ordinary route changes do not retire pending work', () => {
  const owner = select(),
    attempt = start('command');
  expect(session.establishSessionIdentity(account())).toBe(owner);
  window.history.replaceState(null, '', '/atlas/item/~other?tenant=north');
  expect(state.hasUnresolved()).toBe(true);
  expect(state.unknown(attempt)).toBe(true);
  expect(state.hasUnresolved()).toBe(true);
});

test('renewal preserves pending and unknown attempts; suspension blocks only new admission', () => {
  const owner = select(),
    pending = start(),
    uncertain = start('command'),
    lease = session.captureTenantLease()!;
  state.unknown(uncertain);
  const version = state.version(),
    changed = vi.fn();
  state.subscribe(changed);
  session.suspendTenantLease(owner);
  expect(state.start('insert')).toBeUndefined();
  expect(state.hasUnresolved(owner)).toBe(true);
  session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2, expiresAt: lease.expiresAt + 60_000 });
  expect(state.version()).toBe(version);
  expect(changed).not.toHaveBeenCalled();
  expect(state.unknown(uncertain)).toBe(false);
  expect(state.settle(pending)).toBe(true);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(uncertain)).toBe(true);
  expect(state.hasUnresolved()).toBe(false);
  expect(start('insert').identity).toBe(owner);
});

test.each(['pending', 'unknown'] as const)('security lock immediately clears %s work before returning', (phase) => {
  select();
  const attempt = start('delete');
  if (phase === 'unknown') state.unknown(attempt);
  const seen: boolean[] = [];
  state.subscribe(() => {
    seen.push(state.hasUnresolved());
  });
  session.lockSessionIdentity();
  expect(seen).toEqual([false]);
  expect(state.hasUnresolved()).toBe(false);
  expect(state.unknown(attempt)).toBe(false);
  expect(state.settle(attempt)).toBe(false);
});

test('clock expiry alone does not erase an unresolved outcome before the security owner locks', () => {
  const owner = select(),
    attempt = start();
  vi.spyOn(Date, 'now').mockReturnValue(session.captureTenantLease(owner)!.expiresAt);
  expect(state.start('insert')).toBeUndefined();
  expect(state.hasUnresolved()).toBe(true);
  expect(state.unknown(attempt)).toBe(true);
  session.lockSessionIdentity();
  expect(state.hasUnresolved()).toBe(false);
});

test('a late asynchronous completion cannot clear new work after security retirement', async () => {
  select();
  const attempt = start('insert'),
    finished = deferred();
  const completion = finished.promise.then(() => state.settle(attempt));
  session.lockSessionIdentity();
  select();
  const current = start('insert');
  finished.resolve();
  expect(await completion).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
  expect(state.settle(current)).toBe(true);
});

test('late acknowledgment of the original unknown attempt may settle it without resending', async () => {
  select();
  const attempt = start(),
    finished = deferred();
  const completion = finished.promise.then(() => state.settle(attempt));
  state.unknown(attempt);
  expect(state.hasUnresolved()).toBe(true);
  finished.resolve();
  expect(await completion).toBe(true);
  expect(state.hasUnresolved()).toBe(false);
});

test('a broken subscriber cannot lose the handle or block forced retirement', () => {
  select();
  state.subscribe(() => {
    throw new Error('Broken observer');
  });
  const laterObserver = vi.fn();
  state.subscribe(laterObserver);
  const attempt = start();
  expect(laterObserver).toHaveBeenCalledTimes(1);
  expect(() => session.lockSessionIdentity()).not.toThrow();
  expect(laterObserver).toHaveBeenCalledTimes(2);
  expect(state.hasUnresolved()).toBe(false);
  expect(state.settle(attempt)).toBe(false);
});

test('reentrant security retirement cannot leave the starting attempt in the new owner', () => {
  select();
  const unsubscribe = state.subscribe(() => {
    if (state.hasUnresolved()) session.lockSessionIdentity();
  });
  const retired = start();
  expect(session.sessionIdentity().mode).toBe('locked');
  expect(state.hasUnresolved()).toBe(false);
  unsubscribe();
  select();
  start('command');
  expect(state.settle(retired)).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
});

test('retirement during the admission clock check cannot register old-owner work', () => {
  select();
  const instant = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => {
    session.lockSessionIdentity();
    return instant;
  });
  expect(state.start('insert')).toBeUndefined();
  expect(state.hasUnresolved()).toBe(false);
});

test('settlement notification cannot erase a reentrant new attempt', () => {
  select();
  const original = start();
  let newer: TenantMutationAttempt | undefined;
  state.subscribe(() => {
    if (!state.hasUnresolved()) newer = state.start('update');
  });
  expect(state.settle(original)).toBe(true);
  expect(newer).toBeDefined();
  expect(newer).not.toBe(original);
  expect(state.settle(original)).toBe(false);
  expect(state.hasUnresolved()).toBe(true);
});
