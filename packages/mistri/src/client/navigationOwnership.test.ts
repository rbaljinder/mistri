import { beforeEach, expect, test, vi } from 'vitest';

let core: typeof import('../../../kit/src/client/core.js');
let mode: typeof import('../../../kit/src/client/shellMode.js');
function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  core = await import('../../../kit/src/client/core.js');
  mode = await import('../../../kit/src/client/shellMode.js');
  core.state.activeConnection = 'a';
  core.state.schema = {};
  core.state.stack = [core.tableView('customer')];
  /* The App shell's write guards (appnav.js), which the exits below are held by. */
  const { tenantMutationState } = await import('./tenantMutationState.js');
  const accounts = await import('./tenantAccountState.js');
  mode.installShell({
    pageAffinity: () => true,
    mutations: tenantMutationState,
    accountBusy: () => accounts.hasUnresolvedAdministration() || accounts.hasUnresolvedInvitations(),
  });
});

test('cold navigation and exit checks do not load administration or invitation delivery', async () => {
  vi.resetModules();
  const administration = vi.fn(() => {
    throw new Error('Administration loaded during navigation');
  });
  const invitations = vi.fn(() => {
    throw new Error('Invitations loaded during navigation');
  });
  vi.doMock('./tenantAdministration.js', administration);
  vi.doMock('./tenantInvitations.js', invitations);
  try {
    const cold = await import('../../../kit/src/client/core.js');
    const probes = await import('./tenantAccountState.js');
    expect(cold.allowMutationExit()).toBe(true);
    expect(probes.hasAdministrationSession()).toBe(false);
    expect(probes.hasInvitationSession()).toBe(false);
    expect(administration).not.toHaveBeenCalled();
    expect(invitations).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('./tenantAdministration.js');
    vi.doUnmock('./tenantInvitations.js');
  }
});

test.each(['resolved', 'rejected'] as const)('a %s page lookup cannot navigate into another connection', async (outcome) => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  core.state.activeConnection = 'b';
  const next = core.tableView('ticket');
  core.go(next, 'reset');
  if (outcome === 'resolved') reply.resolve('config:customer');
  else reply.reject(new Error('Unavailable'));
  await opening;
  expect(core.state.stack).toEqual([next]);
});

test('a page lookup cannot undo a newer navigation on the same connection', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  const next = core.tableView('invoice');
  core.go(next, 'reset');
  reply.resolve('config:customer');
  await opening;
  expect(core.state.stack).toEqual([next]);
});

test('a schema replacement invalidates a pending record opening', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const origin = core.currentEntry();
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  core.state.schema = {};
  reply.resolve('config:customer');
  await opening;
  expect(core.currentEntry()).toBe(origin);
});

test('a current lookup still opens its configured page and genuine failures fall back to a row', async () => {
  mode.installShell({ resolvePage: async () => 'config:customer' });
  await core.openRecord('customer', { id: 1 }, 'Ada');
  expect(core.currentEntry()).toEqual(core.pageView('config:customer', 'customer', { id: 1 }, 'Ada'));
  mode.installShell({
    resolvePage: async () => {
      throw new Error('Offline');
    },
  });
  await core.openRecord('invoice', { id: 2 }, 'Invoice');
  expect(core.currentEntry()).toEqual(core.rowView('invoice', { id: 2 }, 'Invoice'));
});

test.each(['older-first', 'newer-first'] as const)('the latest record click wins with %s responses', async (order) => {
  const older = deferred();
  const newer = deferred();
  mode.installShell({ resolvePage: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) });
  const origin = core.currentEntry();
  const first = core.openRecord('customer', { id: 1 }, 'Older click');
  const second = core.openRecord('customer', { id: 2 }, 'Latest click');
  if (order === 'older-first') {
    older.resolve('config:customer');
    await first;
    expect(core.currentEntry()).toBe(origin);
  }
  newer.resolve('config:customer');
  await second;
  older.resolve('config:customer');
  await first;
  expect(core.currentEntry()).toEqual(core.pageView('config:customer', 'customer', { id: 2 }, 'Latest click'));
  expect(core.state.stack).toHaveLength(2);
});

test('an older rejected record open cannot fall back while the newer click is pending', async () => {
  const older = deferred();
  const newer = deferred();
  mode.installShell({ resolvePage: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise) });
  const origin = core.currentEntry();
  const first = core.openRecord('customer', { id: 1 }, 'Older');
  const second = core.openRecord('customer', { id: 2 }, 'Newer');
  older.reject(new Error('Offline'));
  await first;
  expect(core.currentEntry()).toBe(origin);
  newer.reject(new Error('Offline'));
  await second;
  expect(core.currentEntry()).toEqual(core.rowView('customer', { id: 2 }, 'Newer'));
});

test('returning to the same entry does not revive an old navigation intent', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const origin = core.currentEntry();
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  core.go(core.tableView('invoice'));
  core.backTo(0);
  expect(core.currentEntry()).toBe(origin);
  reply.resolve('config:customer');
  await opening;
  expect(core.state.stack).toEqual([origin]);
});

test('a connection transition retires pending navigation before the schema changes', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const origin = core.currentEntry();
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  const { beginConnectionTransition } = await import('../../../kit/src/client/connectionTransition.js');
  beginConnectionTransition().finish();
  reply.resolve('config:customer');
  await opening;
  expect(core.currentEntry()).toBe(origin);
});

test('a drawer handled without changing the route still supersedes a pending page open', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const origin = core.currentEntry();
  const opening = core.openRecord('customer', { id: 1 }, 'Ada');
  mode.installShell({ openRecord: () => true });
  await core.openRecord('customer', { id: 2 }, 'Drawer');
  reply.resolve('config:customer');
  await opening;
  expect(core.currentEntry()).toBe(origin);
});

test('paint and breadcrumb updates are not navigation intents', () => {
  const current = core.captureNavigation();
  core.render();
  core.renderCrumbs();
  expect(current()).toBe(true);
  core.beginNavigation();
  expect(current()).toBe(false);
});

test('a pending record autosave blocks voluntary exits, then releases them on settlement', async () => {
  let pending = true;
  core.setRecordMutationPendingProbe(() => pending);
  const origin = core.currentEntry();
  const opener = vi.fn(() => true);
  mode.installShell({ openRecord: opener });
  core.go(core.tableView('invoice'));
  core.backTo(-1);
  await core.openRecord('customer', { id: 2 }, 'Other');
  expect(core.currentEntry()).toBe(origin);
  expect(opener).not.toHaveBeenCalled();
  pending = false;
  expect(core.allowMutationExit()).toBe(true);
  core.go(core.tableView('invoice'));
  expect(core.currentEntry()).not.toBe(origin);
});

test('an unreadable pending-record owner does not authorize navigation', () => {
  core.setRecordMutationPendingProbe(() => {
    throw new Error('Retired owner');
  });
  expect(core.allowMutationExit()).toBe(false);
  core.setRecordMutationPendingProbe(() => false);
  expect(core.allowMutationExit()).toBe(true);
});

test('transient surface guards supplement existing write owners and unregister only their own guard', async () => {
  const origin = core.currentEntry();
  const first = core.registerSurfaceMutationPendingProbe(() => true);
  const second = core.registerSurfaceMutationPendingProbe(() => true);
  const opener = vi.fn(() => true);
  mode.installShell({ openRecord: opener });
  core.go(core.tableView('invoice'));
  core.backTo(-1);
  await core.openRecord('customer', { id: 2 }, 'Other');
  expect(core.currentEntry()).toBe(origin);
  expect(opener).not.toHaveBeenCalled();
  first();
  first();
  expect(core.allowMutationExit()).toBe(false);
  second();
  core.setRecordMutationPendingProbe(() => true);
  expect(core.allowMutationExit()).toBe(false);
  core.setRecordMutationPendingProbe(() => false);
  expect(core.allowMutationExit()).toBe(true);
});

test('a throwing transient surface fails closed, and the normal opener receives exact loaded keys', async () => {
  const stop = core.registerSurfaceMutationPendingProbe(() => {
    throw new Error('Unavailable owner');
  });
  expect(core.allowMutationExit()).toBe(false);
  stop();
  const records = [{ key: { id: '9007199254740993' }, label: 'Large identifier' }];
  // The list's question and page reach the opener too, so a glance or dialog can step past the page.
  const list = { query: 'customer', offset: 20, limit: 20, total: 21 };
  const opener = vi.fn(() => true);
  mode.installShell({ openRecord: opener });
  await core.openRecord('customer', records[0].key, records[0].label, 'push', { records, list });
  expect(opener).toHaveBeenCalledWith('customer', records[0].key, records[0].label, records, list);
});

test('automatic page resolution cannot overtake a newer explicit intent', async () => {
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const automatic = core.pageFor('customer');
  core.beginNavigation();
  reply.resolve('config:customer');
  expect(await automatic).toBeNull();
});

test('automatic page lookup rejects current errors but ignores errors from cancelled work', async () => {
  mode.installShell({
    resolvePage: async () => {
      throw new Error('Offline');
    },
  });
  await expect(core.pageFor('customer')).rejects.toThrow('Offline');
  const reply = deferred();
  mode.installShell({ resolvePage: () => reply.promise });
  const automatic = core.pageFor('customer');
  core.beginNavigation();
  reply.reject(new Error('Old failure'));
  expect(await automatic).toBeNull();
});

test.each(['update', 'insert', 'delete', 'command'] as const)(
  '%s uncertainty blocks route, breadcrumb, drawer and browser-history exits',
  async (kind) => {
    const identity = await import('../../../kit/src/client/sessionIdentity.js');
    const { tenantMutationState } = await import('./tenantMutationState.js');
    const { parseTenantLink, qualifyTenantLink } = await import('./tenantLink.js');
    mode.installShell({ tenantLinks: { parse: parseTenantLink, qualify: qualifyTenantLink } });
    identity.establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'alice' });
    identity.requireTenantSelection();
    identity.establishTenantSelection({
      appId: 'a',
      accountId: 'alice',
      tenantId: 'north',
      tabId: 'tab',
      context: 'north-context',
      revision: 1,
      expiresAt: Date.now() + 60_000,
    });
    const origin = core.tableView('customer'),
      current = core.rowView('customer', { id: 1 }, 'Ada');
    core.state.stack = [origin, current];
    const open = vi.fn(() => true);
    mode.installShell({ openRecord: open });
    const { applyHash, toHash } = await import('../../../kit/src/client/url.js');
    const find = vi.fn(),
      select = vi.fn();
    const attempt = tenantMutationState.start(kind)!;
    expect(attempt).toBeDefined();
    for (const phase of ['pending', 'unknown']) {
      if (phase === 'unknown') tenantMutationState.unknown(attempt);
      core.go(core.tableView('invoice'), 'reset');
      core.backTo(0);
      await core.openRecord('customer', { id: 2 }, 'Other');
      expect(applyHash('/a/customer?tenant=north', { findTableById: find, selectConnection: select })).toBe(false);
      expect(core.state.stack).toEqual([origin, current]);
      expect(open).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(window.location.pathname + window.location.search).toBe(toHash());
    }
    tenantMutationState.settle(attempt);
    core.backTo(0);
    expect(core.state.stack).toEqual([origin]);
    window.history.replaceState(null, '', '/');
  },
);

test('forced identity retirement clears the exit gate without claiming an old mutation completed', async () => {
  const identity = await import('../../../kit/src/client/sessionIdentity.js');
  const { tenantMutationState } = await import('./tenantMutationState.js');
  identity.establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'alice' });
  identity.requireTenantSelection();
  identity.establishTenantSelection({
    appId: 'a',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab',
    context: 'north-context',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
  const attempt = tenantMutationState.start('insert')!;
  expect(core.allowMutationExit()).toBe(false);
  identity.lockSessionIdentity();
  expect(core.allowMutationExit()).toBe(true);
  expect(tenantMutationState.settle(attempt)).toBe(false);
  core.state.schema = null;
  expect(core.findTable('customer')).toBeUndefined();
});

test('pre-selection administration blocks existing navigation guards without inventing a business lease', async () => {
  const identity = await import('../../../kit/src/client/sessionIdentity.js');
  const { TenantAdministrationController } = await import('./tenantAdministration.js');
  const { tenantMutationState } = await import('./tenantMutationState.js');
  identity.establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'a' });
  identity.requireTenantSelection();
  const session = { accountId: 'operator', appId: 'a', context: 'admin', expiresAt: Date.now() + 60_000, maxMembershipLifetimeMs: 60_000 };
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {
        'x-mistri-account': 'operator',
        'x-mistri-app': 'a',
        'x-mistri-administration-context': 'admin',
      },
    });
  let fail!: (reason: Error) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(reply({ session }))
      .mockResolvedValueOnce(
        reply({
          page: {
            items: [{ tenantId: 'north', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] }],
            next: null,
          },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
      ),
  );
  const controller = new TenantAdministrationController();
  try {
    await controller.open();
    await controller.loadTenants();
    controller.select('north');
    expect(controller.prepare({ operation: 'createTenant', tenantId: 'north' })).toBe(true);
    const pending = controller.execute();
    const origin = core.currentEntry();
    expect(identity.sessionIdentity().tenant).toBeUndefined();
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    expect(core.allowMutationExit()).toBe(false);
    core.go(core.tableView('invoice'), 'reset');
    expect(core.currentEntry()).toBe(origin);
    fail(new Error('Lost reply'));
    await pending;
    expect(core.allowMutationExit()).toBe(false);
    identity.lockSessionIdentity();
    expect(core.allowMutationExit()).toBe(true);
    expect(controller.snapshot().attempt).toBeNull();
  } finally {
    controller.retire();
    vi.unstubAllGlobals();
  }
});
