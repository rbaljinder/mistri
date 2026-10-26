import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TenantContextReply } from '../shared/tenantContext.js';

let flags: typeof import('./appFlags.js'),
  identity: typeof import('../../../kit/src/client/sessionIdentity.js'),
  presentation: typeof import('../../../kit/src/client/connectionTransition.js');
const dto = (value = true) => ({ values: { enabled: value, config: { label: 'data' } }, version: { global: 2, tenant: null } });
const reply = (body: unknown = dto(), account = 'alice', app = 'desk') =>
  new Response(JSON.stringify(body), {
    headers: { 'x-mistri-app': app, ...(account ? { 'x-mistri-account': account } : {}) },
  });
const proof = (context = 'context-north'): TenantContextReply => ({
  appId: 'desk',
  accountId: 'alice',
  tenantId: 'north',
  tabId: 'tab-one',
  context,
  revision: 1,
  expiresAt: Date.now() + 60_000,
});
const tenantReply = (lease: TenantContextReply, body: unknown = dto()) =>
  new Response(JSON.stringify(body), {
    headers: {
      'x-mistri-app': lease.appId,
      'x-mistri-account': lease.accountId,
      'x-mistri-tenant': lease.tenantId,
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
    },
  });
const sources: Array<{ dispose(): void }> = [];
const page = (active = () => 'desk') => {
  const source = flags.createPageAppFlags(active);
  sources.push(source);
  return source;
};
beforeEach(async () => {
  vi.resetModules();
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  presentation = await import('../../../kit/src/client/connectionTransition.js');
  flags = await import('./appFlags.js');
  const lifecycle = await import('../../../kit/src/client/sessionLifecycle.js');
  lifecycle.configureSessionLifecycle({ onLock: vi.fn() });
  identity.establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
  presentation.replaceAppPresentation(true);
});
afterEach(() => {
  for (const source of sources.splice(0)) source.dispose();
  vi.doUnmock('./experimentExposure.js');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('visitor opt-in only runs explicitly, creates no account assertion and reloads flags', async () => {
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ ready: true }, ''))
    .mockResolvedValueOnce(reply(dto(), ''));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  expect(fetcher).not.toHaveBeenCalled();
  await source.establishVisitor();
  expect(fetcher.mock.calls[0][0]).toBe('/api/experiments/visitor');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    body: '{}',
    headers: { 'content-type': 'application/json', 'x-mistri-visitor': 'establish' },
  });
  expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('x-mistri-account');
  expect(fetcher.mock.calls[1][0]).toBe('/api/flags/evaluate?app=desk');
  expect(source.ready).toBe(true);
  expect(identity.sessionIdentity().accountId).toBeNull();
});

test('visitor opt-in refuses signed-in sessions and stale responses cannot reload a new owner', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await expect(source.establishVisitor()).rejects.toThrow(/Visitor/);
  expect(fetcher).not.toHaveBeenCalled();
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  let answer!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  const pending = source.establishVisitor();
  identity.establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'desk' });
  answer(reply({ ready: true }, ''));
  await expect(pending).rejects.toThrow(/Visitor/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(source.ready).toBe(false);
});

test('first use loads once, captures immutable evaluated values, and absent/unready get never falls back to false', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  expect(fetcher).not.toHaveBeenCalled();
  expect(source.ready).toBe(false);
  expect(() => source.get('enabled')).toThrow(/not ready/);
  await Promise.all([source.load(), source.load()]);
  expect(source.ready).toBe(true);
  expect(source.get('enabled')).toBe(true);
  expect(Object.isFrozen(source.get('config'))).toBe(true);
  expect(() => source.get('unknown')).toThrow(/Undeclared/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/flags/evaluate?app=desk');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-mistri-account': 'alice' },
  });
});

test('late old-owner replies cannot publish after account change or same-tenant context replacement', async () => {
  for (const tenant of [false, true]) {
    identity.establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
    if (tenant) {
      identity.requireTenantSelection();
      identity.establishTenantSelection(proof());
    }
    presentation.replaceAppPresentation(true);
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const source = page(),
      pending = source.load();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const signal = fetcher.mock.calls[0][1]!.signal as AbortSignal;
    if (tenant) identity.establishTenantSelection(proof('new-context'));
    else identity.establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'desk' });
    expect(signal.aborted).toBe(true);
    expect(source.ready).toBe(false);
    resolve(tenant ? tenantReply(proof()) : reply());
    await pending;
    expect(() => source.get('enabled')).toThrow();
    expect(source.ready).toBe(false);
    source.dispose();
  }
});

test('branding/payload retirement, connection change and lease suspension synchronously invalidate retained readers', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply()));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  const original = source.snapshot();
  presentation.replaceAppPresentation();
  expect(original.ready).toBe(false);
  expect(() => original.get('enabled')).toThrow();
  presentation.replaceAppPresentation(true);
  await source.load();
  const refreshed = source.snapshot();
  const connection = await import('../../../kit/src/client/connectionTransition.js');
  connection.beginConnectionTransition();
  expect(() => refreshed.get('enabled')).toThrow();
  identity.requireTenantSelection();
  const lease = proof();
  identity.establishTenantSelection(lease);
  presentation.replaceAppPresentation(true);
  fetcher.mockImplementation(() => Promise.resolve(tenantReply(lease)));
  await source.load();
  const tenantReader = source.snapshot();
  expect(tenantReader.ready).toBe(true);
  identity.suspendTenantLease();
  expect(() => tenantReader.get('enabled')).toThrow();
  expect(source.ready).toBe(false);
});

test('tenant GET uses canonical lease selectors/headers and rejects a mismatched response owner', async () => {
  identity.requireTenantSelection();
  const lease = proof();
  identity.establishTenantSelection(lease);
  const fetcher = vi.fn().mockResolvedValue(tenantReply(lease));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  expect(source.ready).toBe(true);
  expect(fetcher.mock.calls[0][0]).toBe('/api/flags/evaluate?app=desk&tenant=north');
  expect(fetcher.mock.calls[0][1].headers).toMatchObject({
    'x-mistri-app': 'desk',
    'x-mistri-account': 'alice',
    'x-mistri-tab': 'tab-one',
    'x-mistri-context': 'context-north',
    'x-mistri-lease-revision': '1',
  });
  source.retire();
  fetcher.mockResolvedValue(tenantReply({ ...lease, context: 'wrong-context' }));
  await source.load();
  expect(source.ready).toBe(false);
  expect(() => source.get('enabled')).toThrow();
});

test('anonymous reads create no identity/tracking and neither SSR nor another App response is adopted', async () => {
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  const script = document.createElement('script');
  script.id = 'mistri-flags';
  script.textContent = JSON.stringify(dto(false));
  document.head.append(script);
  try {
    const fetcher = vi.fn().mockResolvedValue(reply(dto(), ''));
    vi.stubGlobal('fetch', fetcher);
    const source = page();
    expect(source.ready).toBe(false);
    await source.load();
    expect(source.get('enabled')).toBe(true);
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
    expect(identity.sessionIdentity().accountId).toBeNull();
    source.retire();
    fetcher.mockResolvedValue(reply(dto(), '', 'other'));
    await source.load();
    expect(source.ready).toBe(false);
    expect(() => source.get('enabled')).toThrow();
  } finally {
    script.remove();
  }
});

test('malformed/private data fails closed and does not trigger a render retry loop', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ ...dto(), roles: ['admin'] }));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  await source.load();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(source.ready).toBe(false);
  expect(() => source.get('enabled')).toThrow(/Invalid evaluated/);
});

const receipt = `ar1.${'a'.repeat(64)}`;
const evaluated = () => ({ ...dto(), assignmentReceipts: { enabled: receipt } });
const acknowledgement = { outcomes: ['recorded'], coverage: { received: 1, recorded: 1, duplicate: 0, failed: 0, unknown: 0, dropped: 0 } };

test('private receipts stay in memory; loading and imperative flag reads do not report consumption', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem'),
    set = vi.spyOn(Storage.prototype, 'setItem');
  const fetcher = vi
    .fn()
    .mockImplementation((path: string) => Promise.resolve(reply(path.includes('/exposures') ? acknowledgement : evaluated())));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  source.get('enabled');
  source.snapshot().get('enabled');
  expect(fetcher).toHaveBeenCalledTimes(1);
  source.commitUse(source.snapshot(), ['enabled', 'enabled', 'config']);
  await vi.waitFor(() => expect(source.exposureCoverage().recorded).toBe(1));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe('/api/experiments/exposures?app=desk');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ receipts: [receipt] });
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(document.documentElement.innerHTML).not.toContain(receipt);
});

test('account, App, tenant-context and lease changes synchronously abort exposure delivery and ignore late success', async () => {
  for (const mode of ['account', 'app', 'tenant', 'lease']) {
    identity.establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
    const lease = proof();
    if (mode === 'tenant' || mode === 'lease') {
      identity.requireTenantSelection();
      identity.establishTenantSelection(lease);
    }
    presentation.replaceAppPresentation(true);
    let finish!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation((path: string) =>
      path.includes('/exposures')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(mode === 'tenant' || mode === 'lease' ? tenantReply(lease, evaluated()) : reply(evaluated())),
    );
    vi.stubGlobal('fetch', fetcher);
    const source = page();
    await source.load();
    const reader = source.snapshot();
    source.commitUse(reader, ['enabled']);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const signal = fetcher.mock.calls[1][1].signal as AbortSignal;
    if (mode === 'account') identity.establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'desk' });
    else if (mode === 'app') presentation.replaceAppPresentation();
    else if (mode === 'tenant') identity.establishTenantSelection(proof('replacement'));
    else identity.suspendTenantLease();
    expect(signal.aborted).toBe(true);
    expect(source.exposureCoverage()).toMatchObject({ recorded: 0, unknown: 1, queued: 0, inFlight: 0 });
    source.commitUse(reader, ['enabled']);
    finish(mode === 'tenant' || mode === 'lease' ? tenantReply(lease, acknowledgement) : reply(acknowledgement));
    await Promise.resolve();
    await Promise.resolve();
    expect(source.exposureCoverage().recorded).toBe(0);
    source.dispose();
  }
});

test('absence of receipt never fabricates an observation for subjects or visitors', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  source.commitUse(source.snapshot(), ['enabled']);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  presentation.replaceAppPresentation(true);
  fetcher.mockResolvedValue(reply(dto(), ''));
  await source.load();
  source.commitUse(source.snapshot(), ['enabled']);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(source.exposureCoverage().recorded).toBe(0);
});

test('basic flags and receipts without a sender do not load experiment delivery', async () => {
  const imported = vi.fn(() => {
    throw new Error('Unexpected experiment delivery import');
  });
  vi.doMock('./experimentExposure.js', imported);
  const fetcher = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetcher);
  const basic = page();
  await basic.load();
  expect(basic.get('enabled')).toBe(true);
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  presentation.replaceAppPresentation(true);
  fetcher.mockResolvedValue(reply(dto(), ''));
  await basic.load();
  expect(basic.get('enabled')).toBe(true);
  const capture = () => ({ appId: 'desk', current: () => true });
  for (const exposure of [undefined, vi.fn(async () => undefined)]) {
    const source = flags.createAppFlagsState({ capture, read: async () => evaluated(), exposure });
    await source.load();
    expect(source.get('enabled')).toBe(true);
    source.commitUse(source.snapshot(), ['enabled']);
    expect(source.exposureCoverage().recorded).toBe(0);
  }
  const exposure = vi.fn();
  const source = flags.createAppFlagsState({ capture, read: async () => dto(), exposure });
  await source.load();
  expect(source.ready).toBe(true);
  expect(exposure).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
});

test('anonymous server-issued receipts report committed use without establishing identity again', async () => {
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  presentation.replaceAppPresentation(true);
  const fetcher = vi
    .fn()
    .mockImplementation((path: string) => Promise.resolve(reply(path.includes('/exposures') ? acknowledgement : evaluated(), '')));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.load();
  source.commitUse(source.snapshot(), ['enabled']);
  await vi.waitFor(() => expect(source.exposureCoverage().recorded).toBe(1));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe('/api/experiments/exposures?app=desk');
  expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('x-mistri-account');
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/visitor'))).toBe(false);
});

test.each(['resolve', 'reject'])('retirement fences an async exposure factory that later %ss', async (outcome) => {
  const send = vi.fn(),
    capture = () => ({ appId: 'desk', current: () => true });
  let finish!: (sender: { current(): boolean; send: typeof send }) => void, fail!: (error: Error) => void;
  const read = vi.fn(async (_owner: unknown, _signal: AbortSignal): Promise<unknown> => evaluated());
  const exposure = vi.fn(
    () =>
      new Promise<{ current(): boolean; send: typeof send }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const source = flags.createAppFlagsState({ capture, read, exposure }),
    notify = vi.fn();
  source.subscribe(notify);
  const pending = source.load();
  await vi.waitFor(() => expect(exposure).toHaveBeenCalledTimes(1));
  expect(source.ready).toBe(false);
  expect(notify).not.toHaveBeenCalled();
  source.retire();
  expect(read.mock.calls[0][1].aborted).toBe(true);
  read.mockResolvedValue(dto(false));
  await source.load();
  const current = source.snapshot();
  expect(current.get('enabled')).toBe(false);
  const notifications = notify.mock.calls.length;
  if (outcome === 'resolve') finish({ current: () => true, send });
  else fail(new Error('Late factory failure'));
  await pending;
  expect(source.snapshot()).toBe(current);
  expect(notify).toHaveBeenCalledTimes(notifications);
  source.commitUse(current, ['enabled']);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});

test.each(['account', 'lease'])('native %s retirement during module loading cannot adopt a new sender owner', async (mode) => {
  const lease = proof();
  if (mode === 'lease') {
    identity.requireTenantSelection();
    identity.establishTenantSelection(lease);
  }
  const actual = await vi.importActual<typeof import('./experimentExposure.js')>('./experimentExposure.js');
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const capture = vi.fn(actual.captureExperimentExposureSender);
  const imported = vi.fn(async () => {
    await waiting;
    return { ...actual, captureExperimentExposureSender: capture };
  });
  vi.doMock('./experimentExposure.js', imported);
  const fetcher = vi.fn().mockResolvedValue(mode === 'lease' ? tenantReply(lease, evaluated()) : reply(evaluated()));
  vi.stubGlobal('fetch', fetcher);
  const source = page(),
    pending = source.load();
  await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
  expect(source.ready).toBe(false);
  if (mode === 'lease') identity.acceptTenantRenewal(identity.sessionIdentity(), 1, { ...lease, revision: 2 });
  else identity.establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'desk' });
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  fetcher.mockResolvedValue(mode === 'lease' ? tenantReply({ ...lease, revision: 2 }, dto(false)) : reply(dto(false), 'bob'));
  await source.load();
  const current = source.snapshot();
  expect(current.get('enabled')).toBe(false);
  finish();
  await pending;
  expect(source.snapshot()).toBe(current);
  expect(capture).not.toHaveBeenCalled();
  source.commitUse(current, ['enabled']);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('an owner that becomes stale while the queue module loads never publishes or creates a queue', async () => {
  const actual = await vi.importActual<typeof import('./experimentExposure.js')>('./experimentExposure.js');
  let finish!: () => void,
    current = true;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const createQueue = vi.fn(actual.createExperimentExposureQueue);
  const imported = vi.fn(async () => {
    await waiting;
    return { ...actual, createExperimentExposureQueue: createQueue };
  });
  vi.doMock('./experimentExposure.js', imported);
  const source = flags.createAppFlagsState({
    capture: () => ({ appId: 'desk', current: () => current }),
    read: async () => evaluated(),
    exposure: () => ({ current: () => true, send: vi.fn() }),
  });
  const notify = vi.fn();
  source.subscribe(notify);
  const original = source.snapshot(),
    pending = source.load();
  await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
  current = false;
  finish();
  await pending;
  expect(source.snapshot()).toBe(original);
  expect(notify).not.toHaveBeenCalled();
  expect(createQueue).not.toHaveBeenCalled();
});

test('a rejected async factory cannot publish an error for an owner that became stale', async () => {
  let fail!: (error: Error) => void,
    current = true;
  const exposure = vi.fn(
    () =>
      new Promise<undefined>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const source = flags.createAppFlagsState({
    capture: () => ({ appId: 'desk', current: () => current }),
    read: async () => evaluated(),
    exposure,
  });
  const notify = vi.fn();
  source.subscribe(notify);
  const original = source.snapshot(),
    pending = source.load();
  await vi.waitFor(() => expect(exposure).toHaveBeenCalledTimes(1));
  current = false;
  fail(new Error('Stale sender'));
  await pending;
  expect(source.snapshot()).toBe(original);
  expect(notify).not.toHaveBeenCalled();
});

test('explicit public form selection is retained for flag reads and replaced selection retires old replies', async () => {
  identity.establishSessionIdentity({ signedIn: false, appId: 'desk' });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ ready: true }, ''))
    .mockResolvedValueOnce(reply(dto(), ''));
  vi.stubGlobal('fetch', fetcher);
  const source = page();
  await source.establishVisitor({ form: 'apply', address: 'north-intake-address' });
  for (const call of fetcher.mock.calls)
    expect(call[1].headers).toMatchObject({
      'x-mistri-experiment-form': 'apply',
      'x-mistri-experiment-address': 'north-intake-address',
    });
  expect(source.ready).toBe(true);
  let answer!: (response: Response) => void;
  fetcher
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    )
    .mockResolvedValueOnce(reply({ ready: true }, ''))
    .mockResolvedValueOnce(reply(dto(false), ''));
  const stale = source.establishVisitor({ form: 'apply', address: 'south-intake-address' });
  await source.establishVisitor({ form: 'other' });
  answer(reply({ ready: true }, ''));
  await expect(stale).rejects.toThrow(/Visitor/);
  expect(source.get('enabled')).toBe(false);
  await expect(source.establishVisitor({ address: 'without-form' })).rejects.toThrow(/Visitor/);
});
