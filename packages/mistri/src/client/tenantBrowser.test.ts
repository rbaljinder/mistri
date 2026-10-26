import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { TenantChooserProps } from './components/TenantChooser.js';
import type { TenantContextReply, TenantContextRecovery } from '../shared/tenantContext.js';

const mocks = vi.hoisted(() => ({
  discover: vi.fn<() => Promise<readonly string[]>>(),
  choose: vi.fn<(tenantId: string, previous?: TenantContextReply) => Promise<TenantContextReply>>(),
  recover: vi.fn<(tabId: string) => Promise<TenantContextRecovery>>(),
  renew: vi.fn(),
  checkSession: vi.fn(),
  invalidate: vi.fn(),
  mount: vi.fn<(host: HTMLElement, tree: ReactElement<TenantChooserProps>) => void>(),
  supportStatus: vi.fn(),
  showSupportSession: vi.fn(),
}));
vi.mock('./tenantSupport.js', async (original) => ({
  ...(await original<typeof import('./tenantSupport.js')>()),
  supportStatus: mocks.supportStatus,
  showSupportSession: mocks.showSupportSession,
}));
vi.mock('./tenantTransport.js', () => ({
  discoverTenants: mocks.discover,
  chooseTenant: mocks.choose,
  recoverTenant: mocks.recover,
  renewTenant: mocks.renew,
}));
vi.mock('../../../kit/src/client/sessionLifecycle.js', () => ({
  invalidateSession: mocks.invalidate,
  checkSessionIdentity: mocks.checkSession,
}));
vi.mock('./components/TenantChooser.js', () => ({ TenantChooser: () => null, TenantControl: () => null }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({
  mount: mocks.mount,
  element: (tag: string, tree: ReactElement<TenantChooserProps>, className: string) => {
    const host = document.createElement(tag);
    host.className = className;
    mocks.mount(host, tree);
    return host;
  },
}));

let identity: typeof import('../../../kit/src/client/sessionIdentity.js');
let browser: typeof import('./tenantBrowser.js');
let host: HTMLElement;
const reply = (tenantId = 'north', context = `context-${tenantId}`, lifetime = 60000): TenantContextReply => ({
  appId: 'atlas',
  accountId: 'alice',
  tenantId,
  tabId: 'tab-one',
  context,
  revision: 1,
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
const props = (): TenantChooserProps => mocks.mount.mock.calls.at(-1)![1].props;
const settle = () => vi.advanceTimersByTimeAsync(0);
async function initial(tenants: readonly string[] = ['north', 'south']) {
  mocks.discover.mockResolvedValueOnce(tenants);
  const completion = browser.initialTenantSelection(host, 'Atlas');
  await settle();
  return { completion, chooser: props() };
}
async function selected(value = reply()) {
  const start = await initial();
  mocks.choose.mockResolvedValueOnce(value);
  start.chooser.onSelect(value.tenantId);
  await start.completion;
  mocks.choose.mockClear();
  mocks.mount.mockClear();
  return identity.sessionIdentity();
}
function control() {
  const before = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const clear = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const rebuild = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const node = browser.tenantControl(before, clear, rebuild),
    chooser = props();
  return { before, clear, rebuild, node, chooser };
}
function replaceSelection(value = reply('south', 'new-context')) {
  identity.requireTenantSelection();
  identity.establishTenantSelection(value);
  return identity.sessionIdentity();
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  document.body.innerHTML = '<main id="content"></main>';
  host = document.getElementById('content')!;
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  mocks.invalidate.mockImplementation(() => {
    identity.lockSessionIdentity();
  });
  mocks.renew.mockRejectedValue(new Error('Offline'));
  mocks.checkSession.mockResolvedValue(undefined);
  browser = await import('./tenantBrowser.js');
});
afterEach(() => {
  identity.lockSessionIdentity();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('initial discovery retires identity to unselected and offers its choices without choosing one', async () => {
  const before = identity.sessionIdentity(),
    found = deferred<readonly string[]>();
  mocks.discover.mockReturnValueOnce(found.promise);
  let finished = false;
  const pending = browser.initialTenantSelection(host, 'Atlas').then(() => {
    finished = true;
  });
  expect(identity.sessionIdentity().epoch).toBe(before.epoch + 1);
  expect(identity.sessionIdentity().tenantRequired).toBe(true);
  expect(identity.sessionIdentity().tenant).toBeUndefined();
  // Nothing chooser-like is drawn while discovery has not answered.
  expect(mocks.mount).not.toHaveBeenCalled();
  found.resolve(['north', 'south']);
  await settle();
  expect(props()).toMatchObject({ busy: false, tenantIds: ['north', 'south'] });
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  mocks.choose.mockResolvedValueOnce(reply());
  props().onSelect('north');
  await pending;
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('north');
  expect(identity.captureTenantLease()).toEqual(reply());
  expect(finished).toBe(true);
});

test('a sole membership is entered at once, the chooser never drawn at all', async () => {
  const found = deferred<readonly string[]>();
  mocks.discover.mockReturnValueOnce(found.promise);
  mocks.choose.mockResolvedValueOnce(reply());
  const pending = browser.initialTenantSelection(host, 'Atlas');
  found.resolve(['north']);
  await pending;
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('north');
  expect(identity.captureTenantLease()).toEqual(reply());
  // There was never a choice to make, so nothing chooser-like was drawn, not even for a moment.
  expect(mocks.mount).not.toHaveBeenCalled();
});

test('a sole membership the address names is entered; a link to another tenant keeps the chooser', async () => {
  mocks.discover.mockResolvedValueOnce(['north']);
  mocks.choose.mockResolvedValueOnce(reply());
  await browser.initialTenantSelection(host, 'Atlas', 'north');
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('north');
  identity.lockSessionIdentity();
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  mocks.choose.mockClear();
  mocks.discover.mockResolvedValueOnce(['north']);
  void browser.initialTenantSelection(host, 'Atlas', 'south');
  await settle();
  expect(props()).toMatchObject({ requestedTenant: 'south', tenantIds: ['north'], busy: false });
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('a sole platform membership is chosen by hand, and a sole tenant that fails to open is not retried', async () => {
  mocks.discover.mockResolvedValueOnce(['@platform']);
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(props()).toMatchObject({ tenantIds: ['@platform'], busy: false });
  expect(mocks.choose).not.toHaveBeenCalled();
  identity.lockSessionIdentity();
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'alice' });
  mocks.discover.mockResolvedValueOnce(['north']);
  mocks.choose.mockRejectedValueOnce(new Error('PRIVATE_REFUSAL'));
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('north');
  expect(props()).toMatchObject({ busy: false, tenantIds: ['north'] });
  expect(props().error).toBeDefined();
  expect(identity.sessionIdentity().tenant).toBeUndefined();
});

test('empty initial discovery does not grant access or issue a context request', async () => {
  await initial([]);
  expect(props()).toMatchObject({ tenantIds: [], busy: false, error: undefined });
  props().onSelect('north');
  await settle();
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(identity.sessionIdentity().tenant).toBeUndefined();
});

test('account enrollment refreshes an empty chooser without selecting its new tenant', async () => {
  await initial([]);
  const owner = identity.sessionIdentity();
  mocks.discover.mockResolvedValueOnce(['north']);
  await browser.refreshTenantDiscovery();
  expect(props()).toMatchObject({ tenantIds: ['north'], busy: false });
  expect(identity.sessionIdentity()).toBe(owner);
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('enrollment refresh wins over an older discovery response for the same account', async () => {
  const old = deferred<readonly string[]>();
  mocks.discover.mockReturnValueOnce(old.promise);
  void browser.initialTenantSelection(host, 'Atlas');
  mocks.discover.mockResolvedValueOnce(['north', 'south']);
  await browser.refreshTenantDiscovery();
  old.resolve([]);
  await settle();
  expect(props()).toMatchObject({ tenantIds: ['north', 'south'], busy: false });
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('enrollment refresh neither interrupts pending selection nor survives native retirement', async () => {
  const start = await initial(),
    pending = deferred<TenantContextReply>();
  mocks.choose.mockReturnValueOnce(pending.promise);
  start.chooser.onSelect('north');
  const calls = mocks.discover.mock.calls.length;
  await browser.refreshTenantDiscovery();
  expect(mocks.discover).toHaveBeenCalledTimes(calls);
  identity.lockSessionIdentity();
  await browser.refreshTenantDiscovery();
  expect(mocks.discover).toHaveBeenCalledTimes(calls);
  pending.resolve(reply());
  await settle();
  expect(identity.sessionIdentity().mode).toBe('locked');
});

test('enrollment refresh updates an existing tenant control without retiring its business owner', async () => {
  const owner = await selected();
  const c = control();
  mocks.discover.mockResolvedValueOnce(['north', 'south', 'west']);
  await browser.refreshTenantDiscovery();
  expect(props()).toMatchObject({ currentTenant: 'north', tenantIds: ['north', 'south', 'west'], busy: false });
  expect(identity.sessionIdentity()).toBe(owner);
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(c.clear).not.toHaveBeenCalled();
  expect(c.rebuild).not.toHaveBeenCalled();
});

test('late enrollment discovery cannot republish tenants after a native account change', async () => {
  await selected();
  control();
  const pending = deferred<readonly string[]>();
  mocks.discover.mockReturnValueOnce(pending.promise);
  const refresh = browser.refreshTenantDiscovery();
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'bob' });
  const calls = mocks.mount.mock.calls.length;
  pending.resolve(['PRIVATE_OLD_TENANT']);
  await refresh;
  expect(mocks.mount).toHaveBeenCalledTimes(calls);
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('a link hint is shown without auto-selection and resolves only the actually confirmed choice', async () => {
  mocks.discover.mockResolvedValueOnce(['north', 'south']);
  const pending = browser.initialTenantSelection(host, 'Atlas', 'south');
  await settle();
  expect(props().requestedTenant).toBe('south');
  expect(mocks.choose).not.toHaveBeenCalled();
  const confirmed = reply('north');
  mocks.choose.mockResolvedValueOnce(confirmed);
  props().onSelect('north');
  expect(await pending).toBe(confirmed);
  expect(identity.sessionIdentity().tenant?.tenantId).toBe('north');
});

test('initial discovery failure stays unselected and retry is explicit', async () => {
  mocks.discover.mockRejectedValueOnce(new Error('PRIVATE_DISCOVERY'));
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(props().error).toMatch(/could not be checked/);
  expect(props().error).not.toContain('PRIVATE_DISCOVERY');
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  expect(mocks.choose).not.toHaveBeenCalled();
  mocks.discover.mockResolvedValueOnce(['south', 'west']);
  props().onRetry!();
  await settle();
  expect(props()).toMatchObject({ busy: false, error: undefined, tenantIds: ['south', 'west'] });
  expect(identity.sessionIdentity().tenant).toBeUndefined();
});

test.each(['success', 'failure'])('stale discovery %s cannot repaint or replace a newer initial chooser', async (outcome) => {
  const old = deferred<readonly string[]>();
  mocks.discover.mockReturnValueOnce(old.promise);
  void browser.initialTenantSelection(host, 'Old App');
  // The old one drew nothing while it waited, so it has no chooser of its own to act through.
  expect(mocks.mount).not.toHaveBeenCalled();
  mocks.discover.mockResolvedValueOnce(['south', 'west']);
  void browser.initialTenantSelection(host, 'New App');
  await settle();
  const calls = mocks.mount.mock.calls.length;
  if (outcome === 'success') old.resolve(['PRIVATE_OLD_TENANT']);
  else old.reject(new Error('Old refusal'));
  await settle();
  expect(mocks.mount).toHaveBeenCalledTimes(calls);
  expect(props()).toMatchObject({ appName: 'New App', tenantIds: ['south', 'west'], error: undefined });
  expect(mocks.discover).toHaveBeenCalledTimes(2);
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('initial selection rejects unknown IDs and duplicate clicks while an acknowledgement is pending', async () => {
  const start = await initial(),
    acknowledged = deferred<TenantContextReply>();
  start.chooser.onSelect('forged');
  expect(mocks.choose).not.toHaveBeenCalled();
  mocks.choose.mockReturnValueOnce(acknowledged.promise);
  start.chooser.onSelect('north');
  start.chooser.onSelect('south');
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('north');
  expect(props().busy).toBe(true);
  acknowledged.resolve(reply());
  await start.completion;
});

test('unconfirmed initial selection shows a safe error without establishing or auto-retrying', async () => {
  const start = await initial();
  mocks.choose.mockRejectedValueOnce(new Error('PRIVATE_ACK'));
  start.chooser.onSelect('north');
  await settle();
  expect(props()).toMatchObject({ busy: false });
  expect(props().error).toMatch(/selection was not confirmed/);
  expect(props().error).not.toContain('PRIVATE_ACK');
  expect(identity.sessionIdentity().tenant).toBeUndefined();
  expect(mocks.choose).toHaveBeenCalledTimes(1);
  expect(mocks.recover).not.toHaveBeenCalled();
});

test('late initial acknowledgement cannot establish its tenant after an account change', async () => {
  const start = await initial(),
    acknowledged = deferred<TenantContextReply>();
  mocks.choose.mockReturnValueOnce(acknowledged.promise);
  start.chooser.onSelect('north');
  identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'bob' });
  const current = identity.sessionIdentity(),
    calls = mocks.mount.mock.calls.length;
  acknowledged.resolve(reply());
  await settle();
  expect(identity.sessionIdentity()).toBe(current);
  expect(mocks.mount).toHaveBeenCalledTimes(calls);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test.each(['cancelled', 'denied'])('a %s before-switch hook does not retire, clear or request', async (outcome) => {
  const owner = await selected(),
    c = control();
  if (outcome === 'cancelled') c.before.mockResolvedValue(false);
  else c.before.mockRejectedValue(new Error('Not allowed'));
  c.chooser.onSelect('south');
  await settle();
  expect(c.before).toHaveBeenCalledTimes(1);
  expect(identity.sessionIdentity()).toBe(owner);
  expect(c.clear).not.toHaveBeenCalled();
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
  c.before.mockResolvedValue(true);
  mocks.choose.mockResolvedValueOnce(reply('south'));
  c.chooser.onSelect('south');
  await settle();
  expect(c.rebuild).toHaveBeenCalledTimes(1);
});

test('current, unknown and retained old-control choices do not even invoke the before hook', async () => {
  await selected();
  const c = control();
  c.chooser.onSelect('north');
  c.chooser.onSelect('forged');
  replaceSelection();
  c.chooser.onSelect('south');
  await settle();
  expect(c.before).not.toHaveBeenCalled();
  expect(c.clear).not.toHaveBeenCalled();
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('switch waits for the before hook, retires then clears before request and rebuilds only after acknowledgement', async () => {
  const owner = await selected(),
    c = control(),
    permitted = deferred<boolean>(),
    cleared = deferred<void>(),
    acknowledged = deferred<TenantContextReply>();
  const events: string[] = [];
  const stop = identity.subscribeSessionIdentity(() => {
    events.push(identity.sessionIdentity().tenant ? 'established' : 'retired');
  });
  c.before.mockImplementation(() => {
    events.push('before');
    return permitted.promise;
  });
  c.clear.mockImplementation(() => {
    events.push('clear');
    expect(identity.sessionIdentity().tenant).toBeUndefined();
    return cleared.promise;
  });
  mocks.choose.mockImplementationOnce(() => {
    events.push('request');
    return acknowledged.promise;
  });
  c.rebuild.mockImplementation(async () => {
    events.push('rebuild');
    expect(identity.sessionIdentity().tenant?.tenantId).toBe('south');
  });
  c.chooser.onSelect('south');
  c.chooser.onSelect('south');
  expect(identity.sessionIdentity()).toBe(owner);
  expect(events).toEqual(['before']);
  permitted.resolve(true);
  await settle();
  expect(events).toEqual(['before', 'retired', 'clear']);
  expect(mocks.choose).not.toHaveBeenCalled();
  cleared.resolve();
  await settle();
  expect(events).toEqual(['before', 'retired', 'clear', 'request']);
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('south', reply());
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(props()).toMatchObject({ tenantIds: [], busy: true });
  acknowledged.resolve(reply('south'));
  await settle();
  expect(events).toEqual(['before', 'retired', 'clear', 'request', 'established', 'rebuild']);
  stop();
});

test('a changed owner while the before hook waits cannot retire or clear the new selection', async () => {
  await selected();
  const c = control(),
    before = deferred<boolean>();
  c.before.mockReturnValueOnce(before.promise);
  c.chooser.onSelect('south');
  const current = replaceSelection();
  before.resolve(true);
  await settle();
  expect(identity.sessionIdentity()).toBe(current);
  expect(c.clear).not.toHaveBeenCalled();
  expect(mocks.choose).not.toHaveBeenCalled();
});

test.each(['success', 'failure'])('late clear %s cannot request or lock a newer generation', async (outcome) => {
  await selected();
  const c = control(),
    clear = deferred<void>();
  c.clear.mockReturnValueOnce(clear.promise);
  c.chooser.onSelect('south');
  await settle();
  const current = replaceSelection();
  if (outcome === 'success') clear.resolve();
  else clear.reject(new Error('Old clear failed'));
  await settle();
  expect(identity.sessionIdentity()).toBe(current);
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
  expect(c.rebuild).not.toHaveBeenCalled();
});

test('clear failure locks the retired surface without sending a switch request', async () => {
  await selected();
  const c = control();
  c.clear.mockRejectedValueOnce(new Error('Clear failed'));
  c.chooser.onSelect('south');
  await settle();
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('unavailable', false);
  expect(identity.sessionIdentity().mode).toBe('locked');
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(c.rebuild).not.toHaveBeenCalled();
});

test.each(['active', 'inactive'])('lost CAS permits only explicit recovery of an %s server context', async (status) => {
  const original = await selected(),
    c = control();
  mocks.choose.mockRejectedValueOnce(new Error('Lost CAS acknowledgement'));
  c.chooser.onSelect('south');
  await settle();
  const pending = identity.sessionIdentity();
  expect(pending.tenant).toBeUndefined();
  expect(c.clear).toHaveBeenCalledTimes(1);
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
  const recovery = props();
  expect(recovery).toMatchObject({ tenantIds: [], busy: false });
  expect(recovery.error).toMatch(/switch was not confirmed/);
  recovery.onSelect('north');
  c.chooser.onSelect('south');
  await settle();
  expect(mocks.choose).toHaveBeenCalledTimes(1);
  mocks.recover.mockResolvedValueOnce(
    status === 'active' ? reply('south', 'server-selected') : { tabId: original.tenant!.tabId, status: 'inactive' },
  );
  recovery.onRetry!();
  await settle();
  expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(original.tenant!.tabId);
  expect(mocks.choose).toHaveBeenCalledTimes(1);
  if (status === 'active') {
    expect(identity.sessionIdentity().tenant?.context).toBe('server-selected');
    expect(c.rebuild).toHaveBeenCalledTimes(1);
  } else {
    expect(identity.sessionIdentity()).toBe(pending);
    expect(props().error).toMatch(/inactive/);
    expect(c.rebuild).not.toHaveBeenCalled();
  }
});

test('recovery failure remains unselected, safe and explicit without overlapping retry calls', async () => {
  await selected();
  const c = control();
  mocks.choose.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  c.chooser.onSelect('south');
  await settle();
  const pending = identity.sessionIdentity(),
    recover = deferred<TenantContextRecovery>();
  mocks.recover.mockReturnValueOnce(recover.promise);
  const retry = props().onRetry!;
  retry();
  retry();
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  recover.reject(new Error('PRIVATE_RECOVERY'));
  await settle();
  expect(identity.sessionIdentity()).toBe(pending);
  expect(props().error).toMatch(/still unconfirmed/);
  expect(props().error).not.toContain('PRIVATE_RECOVERY');
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(mocks.choose).toHaveBeenCalledTimes(1);
});

test.each(['switch', 'recovery'])('late %s response cannot establish, repaint or rebuild a newer owner', async (operation) => {
  await selected();
  const c = control(),
    answer = deferred<TenantContextReply>();
  if (operation === 'switch') mocks.choose.mockReturnValueOnce(answer.promise);
  else mocks.choose.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  c.chooser.onSelect('south');
  await settle();
  if (operation === 'recovery') {
    mocks.recover.mockReturnValueOnce(answer.promise);
    props().onRetry!();
  }
  const current = replaceSelection(reply('north', 'new-north')),
    mounts = mocks.mount.mock.calls.length;
  answer.resolve(reply('south'));
  await settle();
  expect(identity.sessionIdentity()).toBe(current);
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(mocks.mount).toHaveBeenCalledTimes(mounts);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test('ordinary blur keeps an unexpired tenant surface active without the suspension cover', async () => {
  const owner = await selected();
  window.dispatchEvent(new Event('blur'));
  await settle();
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(true);
  expect(host).not.toHaveAttribute('inert');
  expect(document.body).not.toHaveClass('tenant-suspended');
});

test('unconfirmed proactive renewal suspends the mounted surface and retains identity through expiry', async () => {
  const owner = await selected(reply('north', 'short-lived', 1000));
  await vi.advanceTimersByTimeAsync(799);
  expect(mocks.renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(201);
  expect(mocks.renew).toHaveBeenCalledOnce();
  expect(mocks.invalidate).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
  expect(identity.tenantLeaseActive()).toBe(false);
  expect(host).toHaveAttribute('inert');
  expect(document.body).toHaveClass('tenant-suspended');
});

test.each(['unselected', 'new-selection', 'new-account'])('old expiry cannot lock %s generation', async (next) => {
  await selected(reply('north', 'short-lived', 1000));
  if (next === 'new-account') identity.establishSessionIdentity({ signedIn: true, appId: 'atlas', accountId: 'bob' });
  else if (next === 'new-selection') replaceSelection();
  else identity.requireTenantSelection();
  const current = identity.sessionIdentity();
  await vi.advanceTimersByTimeAsync(1000);
  expect(identity.sessionIdentity()).toBe(current);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test('acknowledged switch replaces the old renewal controller with its own schedule', async () => {
  await selected(reply('north', 'short-lived', 1000));
  const c = control();
  mocks.choose.mockResolvedValueOnce(reply('south', 'longer-lived', 5000));
  c.chooser.onSelect('south');
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.invalidate).not.toHaveBeenCalled();
  expect(mocks.renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.renew).toHaveBeenCalledOnce();
  expect(mocks.renew.mock.calls[0][0]).toBe(identity.sessionIdentity());
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test('a voluntary switch captures the renewed full lease after the asynchronous exit guard', async () => {
  const owner = await selected(),
    c = control(),
    before = deferred<boolean>();
  c.before.mockReturnValueOnce(before.promise);
  c.chooser.onSelect('south');
  const renewed = { ...identity.captureTenantLease()!, revision: 2, expiresAt: Date.now() + 120000 };
  identity.acceptTenantRenewal(owner, 1, renewed);
  mocks.choose.mockResolvedValueOnce(reply('south'));
  before.resolve(true);
  await settle();
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith('south', renewed);
});

test('manual recovery checks the native session and suspension does not call switch teardown', async () => {
  const owner = await selected(),
    c = control();
  browser.suspendBrowserTenant(owner);
  document.querySelector<HTMLButtonElement>('.tenant-renewal-overlay button')!.click();
  expect(mocks.checkSession).toHaveBeenCalledOnce();
  expect(c.clear).not.toHaveBeenCalled();
  expect(c.rebuild).not.toHaveBeenCalled();
  expect(identity.sessionIdentity()).toBe(owner);
});

test('current rebuild failure locks the acknowledged context instead of restoring old data', async () => {
  await selected();
  const c = control();
  mocks.choose.mockResolvedValueOnce(reply('south'));
  c.rebuild.mockRejectedValueOnce(new Error('Rebuild failed'));
  c.chooser.onSelect('south');
  await settle();
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('unavailable', false);
  expect(identity.sessionIdentity().mode).toBe('locked');
  expect(c.clear).toHaveBeenCalledTimes(1);
  expect(mocks.choose).toHaveBeenCalledTimes(1);
});

test('late rebuild failure cannot lock a newer generation even when recovery returns the same context token', async () => {
  await selected();
  const c = control(),
    rebuild = deferred<void>(),
    answer = reply('south', 'same-server-context');
  c.rebuild.mockReturnValueOnce(rebuild.promise);
  mocks.choose.mockResolvedValueOnce(answer);
  c.chooser.onSelect('south');
  await settle();
  expect(c.rebuild).toHaveBeenCalledTimes(1);
  const current = replaceSelection(answer);
  rebuild.reject(new Error('Old rebuild failed'));
  await settle();
  expect(identity.sessionIdentity()).toBe(current);
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

/* The dealer's side of audited support: a way to read the log of visits into
   this tenant, offered only to a member whose role the App granted it to. */
const logButton = (node: HTMLElement) => node.querySelector('button.tenant-support-log');

test('a dealer whose role may read the support log is offered it beside the tenant control', async () => {
  await selected();
  const node = browser.tenantControl(
    vi.fn().mockResolvedValue(true),
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockResolvedValue(undefined),
    true,
  );
  const button = logButton(node);
  expect(button).not.toBeNull();
  expect(button!.textContent).toBe('Support visits');
});

test('a dealer whose role may not read it is offered nothing, and the control is unchanged', async () => {
  await selected();
  const node = browser.tenantControl(
    vi.fn().mockResolvedValue(true),
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockResolvedValue(undefined),
    false,
  );
  expect(logButton(node)).toBeNull();
  // The ordinary tenant control is still there: the absence is the button's, not the control's.
  expect(node.classList.contains('tenant-control-host')).toBe(true);
});

test('the log opens on a host of its own, and only while the selection it was built for is current', async () => {
  await selected();
  const node = browser.tenantControl(
    vi.fn().mockResolvedValue(true),
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockResolvedValue(undefined),
    true,
  );
  const button = logButton(node) as HTMLButtonElement;
  // A stale control, whose tenant selection has since been replaced, opens nothing.
  replaceSelection();
  button.click();
  expect(document.querySelector('.support-log-host')).toBeNull();
});

/* Audited support: a live session of this login resumes where the chooser would be.
   A session stands on a platform membership, so only an account discovery finds
   with one is asked (tenantBrowser.ts). */
test('an account without the platform realm is never asked for a support status', async () => {
  browser.configureTenantSupport({ who: 'alice@example.invalid' });
  mocks.discover.mockResolvedValueOnce(['north', 'south']);
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(mocks.supportStatus).not.toHaveBeenCalled();
  expect(props()).toMatchObject({ tenantIds: ['north', 'south'], busy: false });
});

const live = { state: 'active', supportId: 's', tenantId: 'north', version: 1, remainingMs: 1000 };
test("a platform member's choices are drawn at once, and its support status is asked beside them", async () => {
  browser.configureTenantSupport({ who: 'alice@example.invalid' });
  const status = deferred<unknown>();
  mocks.supportStatus.mockReturnValueOnce(status.promise);
  mocks.discover.mockResolvedValueOnce(['north', '@platform']);
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(mocks.supportStatus).toHaveBeenCalledExactlyOnceWith();
  expect(props()).toMatchObject({ tenantIds: ['north', '@platform'], busy: false });
  const drawn = mocks.mount.mock.calls.length;
  status.resolve({ session: null });
  await settle();
  expect(mocks.mount).toHaveBeenCalledTimes(drawn);
  expect(mocks.supportStatus).toHaveBeenCalledOnce();
});

test('a live support session found before anything is chosen is resumed in place of the chooser', async () => {
  browser.configureTenantSupport({ who: 'alice@example.invalid' });
  const resumed = deferred<unknown>();
  mocks.supportStatus.mockResolvedValueOnce({ session: live }).mockReturnValueOnce(resumed.promise);
  mocks.discover.mockResolvedValueOnce(['@platform']);
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(mocks.supportStatus).toHaveBeenLastCalledWith({ resume: true });
  // Busy while it resumes: a choice now is not taken.
  expect(props()).toMatchObject({ tenantIds: ['@platform'], busy: true });
  props().onSelect('@platform');
  resumed.resolve({ session: live, context: reply() });
  await settle();
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(mocks.showSupportSession).toHaveBeenCalledOnce();
});

test('a choice made before the support status arrives stands, and nothing is resumed', async () => {
  browser.configureTenantSupport({ who: 'alice@example.invalid' });
  const status = deferred<unknown>();
  mocks.supportStatus.mockReturnValueOnce(status.promise);
  mocks.discover.mockResolvedValueOnce(['north', '@platform']);
  const completion = browser.initialTenantSelection(host, 'Atlas');
  await settle();
  let chosen: string | undefined;
  void completion.then((value) => {
    chosen = value.tenantId;
  });
  mocks.choose.mockResolvedValueOnce(reply());
  props().onSelect('north');
  await settle();
  expect(chosen).toBe('north');
  status.resolve({ session: live });
  await settle();
  expect(mocks.supportStatus).toHaveBeenCalledOnce();
  expect(mocks.showSupportSession).not.toHaveBeenCalled();
});

test('a support session that ended before it could be resumed leaves the choices', async () => {
  browser.configureTenantSupport({ who: 'alice@example.invalid' });
  mocks.supportStatus.mockResolvedValueOnce({ session: live }).mockResolvedValueOnce({ session: null });
  mocks.discover.mockResolvedValueOnce(['@platform']);
  void browser.initialTenantSelection(host, 'Atlas');
  await settle();
  expect(mocks.showSupportSession).not.toHaveBeenCalled();
  expect(props()).toMatchObject({ tenantIds: ['@platform'], busy: false });
});
