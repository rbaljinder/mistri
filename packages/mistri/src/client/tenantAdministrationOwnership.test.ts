import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  assertAccountCurrent,
  assertSessionCurrent,
  captureAccountIdentity,
  captureTenantLease,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
} from '../../../kit/src/client/sessionIdentity.js';
import { checkSessionIdentity, configureSessionLifecycle, invalidateTenantContext } from '../../../kit/src/client/sessionLifecycle.js';
import { renewTenant } from './tenantTransport.js';
import { hasAdministrationSession, hasUnresolvedAdministration, TenantAdministrationController } from './tenantAdministration.js';
import { ADMINISTRATION_HTTP_HEADER, type AdministrationSession } from '../shared/tenantAdministration.js';

let controller: TenantAdministrationController;
let admission: AdministrationSession;
let fetcher: ReturnType<typeof vi.fn>;
const account = { signedIn: true, accountId: 'operator', appId: 'app' };
const target = { tenantId: 'new', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] };
const result = () => ({
  receiptId: 'receipt',
  requestId: 'request',
  completedAt: new Date().toISOString(),
  replayed: true,
  change: { operation: 'createTenant', before: null, after: { tenant: { tenantId: 'new', status: 'active', version: '1' } } },
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'x-mistri-app': 'app', 'x-mistri-account': 'operator', [ADMINISTRATION_HTTP_HEADER]: admission.context },
  });
const select = (name = 'north') =>
  establishTenantSelection({
    appId: 'app',
    accountId: 'operator',
    tenantId: name,
    tabId: 'tab',
    context: `business-${name}`,
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
async function pendingAttempt() {
  await controller.open();
  await controller.loadTenants();
  controller.select('new');
  expect(controller.prepare({ operation: 'createTenant', tenantId: 'new' })).toBe(true);
  await controller.execute();
  expect(controller.snapshot().phase).toBe('unknown');
  return controller.snapshot().attempt;
}
beforeEach(() => {
  lockSessionIdentity();
  establishSessionIdentity(account);
  requireTenantSelection();
  admission = {
    appId: 'app',
    accountId: 'operator',
    context: 'administration-context',
    expiresAt: Date.now() + 300_000,
    maxMembershipLifetimeMs: 86_400_000,
  };
  fetcher = vi.fn(async (url: string) => {
    if (url.includes('/open?')) return response({ session: admission });
    if (url.includes('/tenants?')) return response({ page: { items: [target], next: null } });
    if (url.includes('/execute?')) throw new Error('Lost acknowledgement');
    if (url.includes('/status?')) return response({ status: 'completed', outcome: 'applied', result: result() });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  controller = new TenantAdministrationController();
});
afterEach(() => {
  controller.retire();
  configureSessionLifecycle({ onLock: () => {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a late business selection cannot erase an unknown administration attempt or its exact recovery envelope', async () => {
  const attempt = await pendingAttempt(),
    native = captureAccountIdentity(),
    previous = sessionIdentity();
  select();
  expect(() => assertSessionCurrent(previous)).toThrow();
  expect(() => assertAccountCurrent(native)).not.toThrow();
  expect(controller.snapshot().attempt).toBe(attempt);
  expect(controller.snapshot().phase).toBe('unknown');
  expect(hasUnresolvedAdministration()).toBe(true);
  await controller.check();
  expect(controller.snapshot().result?.receiptId).toBe('receipt');
  expect(hasUnresolvedAdministration()).toBe(false);
  const requests = fetcher.mock.calls.filter(([url]) => /\/(execute|status)\?/.test(url));
  expect(requests).toHaveLength(2);
  for (const [, init] of requests) {
    expect(JSON.parse(init.body)).toEqual(attempt);
    expect(init.headers[ADMINISTRATION_HTTP_HEADER]).toBe('administration-context');
    expect(init.headers['x-mistri-context']).toBeUndefined();
  }
});

test('selection during an in-flight administration request still publishes its uncertain outcome to the same native owner', async () => {
  await controller.open();
  await controller.loadTenants();
  controller.select('new');
  controller.prepare({ operation: 'createTenant', tenantId: 'new' });
  let fail!: (reason: Error) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const pending = controller.execute(),
    attempt = controller.snapshot().attempt;
  select();
  fail(new Error('Lost'));
  await pending;
  expect(controller.current()).toBe(true);
  expect(controller.snapshot()).toMatchObject({ phase: 'unknown', attempt });
});

test('forty business selection transitions reuse one administration admission, not forty server quota slots', async () => {
  await controller.open();
  const native = captureAccountIdentity();
  for (let i = 0; i < 40; i++) {
    requireTenantSelection();
    select(i % 2 ? 'north' : 'south');
    await controller.open();
    expect(captureAccountIdentity()).toBe(native);
    expect(controller.current()).toBe(true);
  }
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/open?'))).toHaveLength(1);
});

test('verified native identity plus denied business renewal retires data ownership but retains independent administration recovery', async () => {
  const attempt = await pendingAttempt();
  select();
  const previous = sessionIdentity(),
    native = captureAccountIdentity();
  const onLock = vi.fn();
  configureSessionLifecycle({
    onLock,
    onCheck: async () => response(account),
    onContextCheck: async (owner) => {
      await renewTenant(owner, captureTenantLease(owner)!);
    },
    onTenantDenied: () => {
      requireTenantSelection();
    },
  });
  fetcher.mockImplementationOnce(async () => response({ code: 'tenant_context_unavailable' }, 403));
  await checkSessionIdentity();
  expect(onLock).not.toHaveBeenCalled();
  expect(sessionIdentity().tenant).toBeUndefined();
  expect(captureTenantLease()).toBeUndefined();
  expect(() => assertSessionCurrent(previous)).toThrow();
  expect(captureAccountIdentity()).toBe(native);
  expect(controller.snapshot().attempt).toBe(attempt);
  expect(hasAdministrationSession()).toBe(true);
  await controller.check();
  expect(controller.snapshot().result?.receiptId).toBe('receipt');
});

test('actual native logout or replacement still retires all administration data and cannot adopt an old native root', async () => {
  await pendingAttempt();
  const native = captureAccountIdentity();
  lockSessionIdentity();
  establishSessionIdentity(account);
  requireTenantSelection();
  expect(() => assertAccountCurrent(native)).toThrow();
  expect(controller.current()).toBe(false);
  expect(controller.snapshot().attempt).toBeNull();
  expect(hasUnresolvedAdministration()).toBe(false);
  expect(hasAdministrationSession()).toBe(false);
});

test.each([
  () => {},
  () => {
    throw new Error('Failed retirement');
  },
])('a non-retiring business denial hook cannot leave denied data active', async (hook) => {
  select();
  const onLock = vi.fn();
  configureSessionLifecycle({ onLock, onTenantDenied: hook });
  invalidateTenantContext(sessionIdentity());
  expect(sessionIdentity().mode).toBe('locked');
  expect(onLock).toHaveBeenCalledWith('unavailable');
});

test('a transient initial admission failure can be explicitly retried without remounting the account', async () => {
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  expect(await controller.open()).toBeNull();
  expect(controller.snapshot().message).toMatch(/Retry/);
  expect(await controller.open()).toEqual(admission);
  expect(controller.snapshot().message).toBe('');
  expect(hasAdministrationSession()).toBe(true);
});
