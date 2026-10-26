import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let session: typeof import('./sessionIdentity.js');
beforeEach(async () => {
  vi.resetModules();
  session = await import('./sessionIdentity.js');
});
afterEach(() => vi.restoreAllMocks());

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}
const account = (accountId = 'alice', appId = 'atlas') => ({ signedIn: true, accountId, appId });
const tenant = (tenantId = 'north', context = 'context-north', tabId = 'tab-one') => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId,
  context,
  tabId,
  revision: 1,
  expiresAt: Date.now() + 60_000,
});

function selected() {
  session.establishSessionIdentity(account());
  session.requireTenantSelection();
  return session.establishTenantSelection(tenant());
}

test('initial lease is visible before identity subscribers and stable ownership contains only five fields', () => {
  session.establishSessionIdentity(account());
  session.requireTenantSelection();
  const seen: unknown[] = [];
  session.subscribeSessionIdentity(() => {
    seen.push(session.captureTenantLease());
    expect(session.tenantLeaseActive()).toBe(true);
  });
  const lease = tenant(),
    owner = session.establishTenantSelection(lease);
  expect(seen).toEqual([lease]);
  expect(Object.keys(owner.tenant!).sort()).toEqual(['accountId', 'appId', 'context', 'tabId', 'tenantId']);
  expect(Object.isFrozen(session.captureTenantLease())).toBe(true);
});

test('renewal preserves exact identity, epoch and captured draft storage without identity notifications', () => {
  const owner = selected(),
    old = session.captureTenantLease()!,
    store = memoryStorage();
  const scoped = session.captureScopedStorage(() => store),
    key = 'mistri.layouts.draft.atlas.item';
  scoped.setItem(key, 'Original dirty form');
  const namespace = session.sessionStorageKey(key);
  const identityChanged = vi.fn(),
    leaseChanged = vi.fn();
  session.subscribeSessionIdentity(identityChanged);
  const unsubscribe = session.subscribeTenantLease(leaseChanged);
  const renewal = { ...old, revision: 2, expiresAt: old.expiresAt + 60_000 };
  session.acceptTenantRenewal(owner, 1, renewal);
  renewal.expiresAt++;
  expect(session.sessionIdentity()).toBe(owner);
  expect(session.sessionIdentity().epoch).toBe(owner.epoch);
  expect(session.captureTenantLease()).toEqual({ ...old, revision: 2, expiresAt: old.expiresAt + 60_000 });
  expect(session.captureTenantLease()).not.toBe(old);
  expect(old.revision).toBe(1);
  expect(scoped.getItem(key)).toBe('Original dirty form');
  expect(session.sessionStorageKey(key)).toBe(namespace);
  expect(identityChanged).not.toHaveBeenCalled();
  expect(leaseChanged).toHaveBeenCalledOnce();
  unsubscribe();
  session.suspendTenantLease();
  expect(leaseChanged).toHaveBeenCalledOnce();
});

test('suspension blocks storage and admission while retaining the lease, owner and dirty values', () => {
  const owner = selected(),
    lease = session.captureTenantLease()!,
    store = memoryStorage();
  const scoped = session.captureScopedStorage(() => store),
    key = 'mistri.layouts.draft.atlas.item';
  scoped.setItem(key, 'Draft');
  const changed = vi.fn();
  session.subscribeTenantLease(changed);
  session.suspendTenantLease(owner);
  session.suspendTenantLease(owner);
  expect(changed).toHaveBeenCalledOnce();
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toBe(lease);
  expect(session.captureSessionIdentity()).toBe(owner);
  expect(scoped.getItem(key)).toBeNull();
  expect(() => scoped.setItem(key, 'Overwrite')).toThrow('unavailable');
  session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2 });
  expect(session.tenantLeaseActive()).toBe(true);
  expect(scoped.getItem(key)).toBe('Draft');
});

test('expired duplicate receipt advances CAS while suspended and needs a fresh next revision for admission', () => {
  const owner = selected(),
    lease = session.captureTenantLease()!;
  vi.spyOn(Date, 'now').mockReturnValue(lease.expiresAt + 10);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toBe(lease);
  session.acceptTenantRenewal(owner, 1, { ...lease, revision: 2 });
  expect(session.captureTenantLease()?.revision).toBe(2);
  expect(session.tenantLeaseActive()).toBe(false);
  session.acceptTenantRenewal(owner, 2, { ...lease, revision: 3, expiresAt: lease.expiresAt + 60_000 });
  expect(session.tenantLeaseActive()).toBe(true);
  expect(session.captureSessionIdentity()).toBe(owner);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid revision %s cannot establish or renew a lease', (revision) => {
  session.establishSessionIdentity(account());
  session.requireTenantSelection();
  expect(() => session.establishTenantSelection({ ...tenant(), revision })).toThrow();
  const owner = session.establishTenantSelection(tenant()),
    lease = session.captureTenantLease()!;
  expect(() => session.acceptTenantRenewal(owner, 1, { ...lease, revision })).toThrow();
  expect(session.captureTenantLease()).toBe(lease);
});

test('renewal CAS rejects copies, changed owners, skipped and competing revisions without notifications', () => {
  const owner = selected(),
    lease = session.captureTenantLease()!,
    changed = vi.fn();
  session.subscribeTenantLease(changed);
  const next = { ...lease, revision: 2 };
  for (const field of ['appId', 'accountId', 'tenantId', 'tabId', 'context'] as const)
    expect(() => session.acceptTenantRenewal(owner, 1, { ...next, [field]: 'wrong' })).toThrow();
  expect(() => session.acceptTenantRenewal({ ...owner }, 1, next)).toThrow();
  expect(() => session.acceptTenantRenewal(owner, 2, { ...next, revision: 3 })).toThrow();
  expect(changed).not.toHaveBeenCalled();
  session.acceptTenantRenewal(owner, 1, next);
  expect(() => session.acceptTenantRenewal(owner, 1, next)).toThrow();
  expect(changed).toHaveBeenCalledOnce();
  const newer = selected();
  changed.mockClear();
  expect(session.captureTenantLease(owner)).toBeUndefined();
  expect(session.tenantLeaseActive(owner)).toBe(false);
  session.suspendTenantLease(owner);
  expect(() => session.acceptTenantRenewal(owner, 2, { ...next, revision: 3 })).toThrow();
  expect(changed).not.toHaveBeenCalled();
  expect(session.tenantLeaseActive(newer)).toBe(true);
});

test.each([NaN, Infinity, -Infinity, -1])('invalid or backward clock %s suspends without discarding ownership', (instant) => {
  const owner = selected(),
    lease = session.captureTenantLease()!;
  vi.spyOn(Date, 'now').mockReturnValue(instant);
  expect(session.tenantLeaseActive()).toBe(false);
  expect(session.captureTenantLease()).toBe(lease);
  expect(session.captureSessionIdentity()).toBe(owner);
});

test('tenant selection retires account-wide storage and same-key per-tab/context owners', () => {
  session.establishSessionIdentity(account());
  const store = memoryStorage(),
    key = 'mistri.layouts.draft.atlas.item';
  session.captureScopedStorage(() => store).setItem(key, 'Account wide');
  const accountOwner = session.captureSessionIdentity();
  session.requireTenantSelection();
  expect(session.sessionStorageKey(key)).toBeNull();
  expect(session.sessionStorageKey('mistri.theme')).toBe('mistri.theme');
  expect(() => session.assertSessionCurrent(accountOwner)).toThrow('previous session');
  session.establishTenantSelection(tenant());
  const north = session.captureScopedStorage(() => store),
    first = session.sessionStorageKey(key);
  expect(north.getItem(key)).toBeNull();
  north.setItem(key, 'North draft');
  for (const selected of [tenant('south', 'context-south'), tenant('north', 'new-context'), tenant('north', 'context-north', 'tab-two')]) {
    session.requireTenantSelection();
    session.establishTenantSelection(selected);
    expect(session.sessionStorageKey(key)).not.toBe(first);
    expect(session.captureScopedStorage(() => store).getItem(key)).toBeNull();
    expect(() => north.setItem(key, 'Late north edit')).toThrow('previous session');
  }
});

test('tenant replies are captured and wrong account/App/expiry cannot establish selection', () => {
  session.establishSessionIdentity(account());
  const pending = session.requireTenantSelection();
  for (const value of [
    { ...tenant(), appId: 'other' },
    { ...tenant(), accountId: 'bob' },
    { ...tenant(), expiresAt: NaN },
    { ...tenant(), expiresAt: Date.now() },
    { ...tenant(), context: '' },
  ])
    expect(() => session.establishTenantSelection(value, pending)).toThrow('could not be verified');
  const value = tenant();
  session.establishTenantSelection(value, pending);
  value.tenantId = 'mutated';
  expect(session.sessionIdentity().tenant?.tenantId).toBe('north');
  expect(Object.isFrozen(session.sessionIdentity().tenant)).toBe(true);
  expect(() => session.establishTenantSelection(tenant('south'), pending)).toThrow('previous session');
});

test('unknown identity fails closed while harmless appearance preferences remain available', () => {
  expect(session.sessionIdentity()).toEqual({ mode: 'unknown', epoch: 0, accountId: null, appId: null });
  expect(session.sessionStorageKey('mistri.pages.visits.v1')).toBeNull();
  expect(session.sessionStorageKey('mistri.theme')).toBe('mistri.theme');
  expect(() => session.assertSessionCurrent(session.captureSessionIdentity())).toThrow('session is unavailable');
});

test('anonymous preserves legacy storage and authenticated storage has no legacy fallback', () => {
  session.establishSessionIdentity({ signedIn: false });
  const store = memoryStorage();
  const key = 'mistri.pages.visits.v1';
  session.captureScopedStorage(() => store).setItem(key, 'Legacy account unknown');
  expect(session.sessionStorageKey(key)).toBe(key);
  session.establishSessionIdentity(account());
  const scoped = session.captureScopedStorage(() => store);
  expect(scoped.getItem(key)).toBeNull();
  scoped.setItem(key, 'Alice records');
  expect(scoped.getItem(key)).toBe('Alice records');
  expect(store.values.get(key)).toBe('Legacy account unknown');
  expect(session.sessionStorageKey(key)).not.toBe(key);
});

test('account and App namespaces are distinct even when identifiers contain separators', () => {
  const store = memoryStorage();
  const key = 'mistri.layouts.draft.atlas.ticket';
  const keys = new Set<string | null>();
  for (const [accountId, appId] of [
    ['a.b', 'c'],
    ['a', 'b.c'],
    ['alice', 'atlas'],
    ['bob', 'atlas'],
    ['alice', 'finance'],
  ]) {
    session.establishSessionIdentity(account(accountId, appId));
    keys.add(session.sessionStorageKey(key));
    const scoped = session.captureScopedStorage(() => store);
    expect(scoped.getItem(key)).toBeNull();
    scoped.setItem(key, `${accountId}:${appId}`);
  }
  expect(keys.size).toBe(5);
  session.establishSessionIdentity(account('alice', 'atlas'));
  expect(session.captureScopedStorage(() => store).getItem(key)).toBe('alice:atlas');
});

test('same active identity is stable, but lock and reauthentication invalidate old snapshots', () => {
  const original = session.establishSessionIdentity(account());
  expect(Object.isFrozen(original)).toBe(true);
  expect(session.establishSessionIdentity(account())).toBe(original);
  expect(() => session.assertSessionCurrent(original)).not.toThrow();
  const locked = session.lockSessionIdentity();
  expect(locked.epoch).toBe(original.epoch + 1);
  expect(session.lockSessionIdentity()).toBe(locked);
  expect(session.sessionStorageKey('mistri.history.v1')).toBeNull();
  expect(() => session.assertSessionCurrent(original)).toThrow('previous session');
  expect(() => session.assertSessionCurrent(locked)).toThrow('session is unavailable');
  session.establishSessionIdentity(account());
  expect(() => session.assertSessionCurrent(original, 'alice')).toThrow('previous session');
});

test('authenticated response owner is mandatory when provided, and mismatches do not mutate a newer identity', () => {
  const snapshot = session.establishSessionIdentity(account());
  expect(() => session.assertSessionCurrent(snapshot, 'alice')).not.toThrow();
  for (const header of ['bob', '', null, undefined]) {
    expect(() => session.assertSessionCurrent(snapshot, header)).toThrow('unverified account');
  }
  session.establishSessionIdentity(account('bob'));
  expect(() => session.assertSessionCurrent(snapshot, 'alice')).toThrow('previous session');
  expect(session.sessionIdentity().accountId).toBe('bob');
});

test.each([
  null,
  {},
  [],
  { signedIn: 'true' },
  { signedIn: true, who: 'Alice' },
  account('', 'atlas'),
  account('alice', ''),
  account(' alice', 'atlas'),
  { signedIn: false, accountId: 'alice' },
])('invalid whoami payload locks previous sensitive access: %j', (value) => {
  session.establishSessionIdentity(account());
  expect(() => session.establishSessionIdentity(value)).toThrow('valid session identity');
  expect(session.sessionIdentity().mode).toBe('locked');
  expect(session.sessionStorageKey('mistri.sql.v1')).toBeNull();
});

test('captured storage rejects every stale operation without touching either account storage', () => {
  session.establishSessionIdentity(account());
  const store = memoryStorage();
  const scoped = session.captureScopedStorage(() => store);
  scoped.setItem('mistri.pages.saved.atlas', 'Alice pages');
  const before = new Map(store.values);
  session.establishSessionIdentity(account('bob'));
  store.getItem.mockClear();
  store.setItem.mockClear();
  store.removeItem.mockClear();
  expect(() => scoped.getItem('mistri.pages.saved.atlas')).toThrow('previous session');
  expect(() => scoped.setItem('mistri.pages.saved.atlas', 'Late Alice callback')).toThrow('previous session');
  expect(() => scoped.removeItem('mistri.pages.saved.atlas')).toThrow('previous session');
  expect(store.getItem).not.toHaveBeenCalled();
  expect(store.setItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(store.values).toEqual(before);
});

test('unknown captured storage never accesses protected keys but can read browser preferences', () => {
  const store = memoryStorage();
  store.values.set('mistri.theme', 'dark');
  const scoped = session.captureScopedStorage(() => store);
  expect(scoped.getItem('mistri.pages.visits.v1')).toBeNull();
  expect(store.getItem).not.toHaveBeenCalled();
  expect(() => scoped.setItem('mistri.pages.visits.v1', 'No identity')).toThrow('storage is unavailable');
  expect(() => scoped.removeItem('mistri.pages.visits.v1')).toThrow('storage is unavailable');
  expect(scoped.getItem('mistri.theme')).toBe('dark');
  session.establishSessionIdentity(account());
  expect(() => scoped.getItem('mistri.theme')).toThrow('previous session');
});

test('storage failures propagate to existing recovery callers rather than pretending to save', () => {
  session.establishSessionIdentity(account());
  const denied = new Error('Storage unavailable');
  const scoped = session.captureScopedStorage(() => {
    throw denied;
  });
  expect(() => scoped.getItem('mistri.history.v1')).toThrow(denied);
  expect(() => scoped.setItem('mistri.history.v1', 'query')).toThrow(denied);
  expect(() => scoped.removeItem('mistri.history.v1')).toThrow(denied);
});
