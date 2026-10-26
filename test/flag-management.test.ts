import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFlagCatalog, normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import {
  createFlagManagement,
  type FlagAuthorizationRequest,
  type FlagManagementChange,
} from '../packages/mistri/src/server/flags/management.js';
import { normalizeFlagAuthorityCatalog } from '../packages/mistri/src/server/flags/authority.js';
import {
  FlagManagementDenied,
  normalizeFlagStoreMutation,
  type FlagHistoryEntry,
  type FlagStore,
  type FlagStoreMutation,
} from '../packages/mistri/src/server/flags/store.js';

const catalog = normalizeFlagCatalog({
  flags: {
    feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
    private: { type: 'string', default: 'internal', owner: 'security' },
  },
  roles: [],
  audiences: {},
});
const scope = { appId: 'leads', environment: 'production', tenantId: null };
const change: FlagManagementChange = {
  operation: 'set',
  tenantId: null,
  flagId: 'feature',
  expectedRevision: 0,
  reason: 'Release',
  override: { value: true },
};
function fixture() {
  const calls: FlagStoreMutation[] = [],
    order: string[] = [];
  const before = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: { private: { value: 'secret' } } }, catalog);
  const after = normalizeFlagSnapshot({ ...scope, revision: 1, overrides: { ...before.overrides, feature: { value: true } } }, catalog);
  const entry: FlagHistoryEntry = Object.freeze({
    scope,
    revision: 1,
    flagId: 'feature',
    operation: 'set',
    actorId: 'subject-1',
    reason: 'Release',
    at: '2026-09-30T00:00:00.000Z',
    revertRevision: null,
    before,
    after,
  });
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deployment' },
    read: async () => after,
    history: async () => ({ entries: [entry], nextBeforeRevision: null }),
    close: async () => {},
    mutate: async (input, guard) => {
      calls.push(input);
      order.push('write');
      await guard();
      order.push('commit');
      return entry;
    },
  };
  return { store, calls, order };
}

test('management fixes App/environment and obtains actor, operation and owner from trusted authority', async () => {
  const { store, calls, order } = fixture(),
    requests: FlagAuthorizationRequest[] = [];
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize(request) {
      requests.push(request);
      order.push('authorize');
      return {
        actorId: 'verified-subject',
        reobserve() {
          order.push('observe');
        },
      };
    },
  });
  await manager.change(change);
  assert.deepEqual(requests, [{ scope, flagId: 'feature', owner: 'product', operation: 'set', requiredCapabilities: ['flags.manage'] }]);
  assert.equal(calls[0].actorId, 'verified-subject');
  assert.deepEqual(order, ['authorize', 'observe', 'write', 'observe', 'commit']);
  assert.ok(Object.isFrozen(requests[0]));
  assert.ok(Object.isFrozen(requests[0].scope));
  assert.ok(Object.isFrozen(requests[0].requiredCapabilities));
  for (const injected of [
    { ...change, environment: 'development' },
    { ...change, appId: 'root' },
    { ...change, actorId: 'admin' },
    { ...change, roles: ['admin'] },
    { ...change, owner: 'security' },
  ]) {
    await assert.rejects(manager.change(injected));
  }
  assert.equal(calls.length, 1);
});

test('denied and failing authorizers never reach the store; revoked authority cannot commit', async () => {
  const { store, calls, order } = fixture();
  for (const authorize of [
    () => null,
    () => {
      throw new FlagManagementDenied();
    },
  ]) {
    await assert.rejects(createFlagManagement({ ...scope, catalog, store, authorize }).change(change), FlagManagementDenied);
  }
  assert.equal(calls.length, 0);
  const revoked = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: () => ({
      actorId: 'subject',
      reobserve() {
        throw new FlagManagementDenied();
      },
    }),
  });
  await assert.rejects(revoked.change(change), FlagManagementDenied);
  assert.deepEqual(order, []);
});

test('kill-only authority cannot set or revert, and kill cannot carry replacement targeting', async () => {
  const { store, calls } = fixture();
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: (request) => (request.operation === 'kill' ? { actorId: 'on-call', reobserve() {} } : null),
  });
  await assert.rejects(manager.change(change), FlagManagementDenied);
  await assert.rejects(
    manager.change({ operation: 'revert', tenantId: null, flagId: 'feature', expectedRevision: 0, revertRevision: 0, reason: 'Enable' }),
    FlagManagementDenied,
  );
  await assert.rejects(manager.change({ ...change, operation: 'kill' } as unknown as FlagManagementChange));
  await manager.change({ operation: 'kill', tenantId: null, flagId: 'feature', expectedRevision: 0, reason: 'Incident' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'kill');
  assert.equal(Object.hasOwn(calls[0], 'override'), false);
});

test('an enclosing Console fence is checked again inside the commit guard and cannot arrive in a body', async () => {
  const f = fixture();
  let admitted = true;
  const underlying = f.store.mutate;
  const store: FlagStore = {
    ...f.store,
    async mutate(input, guard) {
      // Revocation while a real store is waiting for its write lock.
      admitted = false;
      return underlying(input, guard);
    },
  };
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: () => ({
      actorId: 'target-subject',
      reobserve() {
        f.order.push('target');
      },
    }),
  });
  let observations = 0;
  const fence = () => {
    observations++;
    if (!admitted) throw new FlagManagementDenied();
  };
  await assert.rejects(manager.change(change, fence), FlagManagementDenied);
  assert.equal(observations, 2);
  assert.deepEqual(f.order, ['target', 'write', 'target']);
  assert.equal(f.calls.length, 1);
  await assert.rejects(manager.change({ ...change, beforeCommit: true } as FlagManagementChange));
  assert.equal(f.calls.length, 1);
});

test('tenant management requires definition opt-in before authority is consulted', async () => {
  const { store } = fixture();
  let authorizations = 0;
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: () => {
      authorizations++;
      return { actorId: 'subject', reobserve() {} };
    },
  });
  await assert.rejects(manager.change({ ...change, tenantId: 'one', flagId: 'private' }), FlagManagementDenied);
  await assert.rejects(manager.change({ ...change, flagId: 'missing' }), FlagManagementDenied);
  assert.equal(authorizations, 0);
});

test('history exposes only the authorized flag and reobserves before returning it', async () => {
  const { store } = fixture();
  let operation: string | undefined,
    observed = false;
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: (request) => {
      operation = request.operation;
      return {
        actorId: 'subject',
        reobserve() {
          observed = true;
        },
      };
    },
  });
  const history = await manager.history({ tenantId: null, flagId: 'feature' });
  assert.equal(operation, 'view');
  assert.ok(observed);
  assert.equal(history.entries[0].before, null);
  assert.deepEqual(history.entries[0].after, { value: true });
  assert.equal(JSON.stringify(history).includes('secret'), false);
  const revoked = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: () => ({
      actorId: 'subject',
      reobserve() {
        throw new FlagManagementDenied();
      },
    }),
  });
  await assert.rejects(revoked.history({ tenantId: null, flagId: 'feature' }), FlagManagementDenied);
});

test('mutation is captured before authorization awaits and validates declared safe values', async () => {
  const { store, calls } = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: async () => {
      await waiting;
      return { actorId: 'subject', reobserve() {} };
    },
  });
  const input = { ...change, override: { value: true } };
  const pending = manager.change(input);
  input.override.value = false;
  input.reason = 'Changed';
  release();
  await pending;
  assert.equal(calls[0].reason, 'Release');
  assert.equal(calls[0].operation === 'set' && calls[0].override.value, true);
  assert.throws(
    () =>
      normalizeFlagStoreMutation({
        scope,
        catalog,
        operation: 'kill',
        flagId: 'private',
        actorId: 'subject',
        reason: 'Incident',
        expectedRevision: 0,
      }),
    FlagManagementDenied,
  );
});

test('mutation acknowledgement exposes no value or history to manage-only or kill-only callers', async () => {
  const { store } = fixture();
  const manager = createFlagManagement({
    ...scope,
    catalog,
    store,
    authorize: (request) => (request.operation !== 'view' ? { actorId: 'subject', reobserve() {} } : null),
  });
  assert.deepEqual(await manager.change(change), { flagId: 'feature', revision: 1, operation: 'set' });
  assert.deepEqual(
    await manager.change({ operation: 'kill', tenantId: null, flagId: 'feature', expectedRevision: 0, reason: 'Incident' }),
    { flagId: 'feature', revision: 1, operation: 'kill' },
  );
  await assert.rejects(manager.history({ tenantId: null, flagId: 'feature' }), FlagManagementDenied);
});

const experiment = {
  version: 'v1',
  weights: [
    { value: false, weight: 50 },
    { value: true, weight: 50 },
  ],
};
const experimentCatalog = normalizeFlagAuthorityCatalog({
  ...catalog,
  flags: { ...catalog.flags, feature: { ...catalog.flags.feature, variants: [false, true] } },
  experiments: { feature: experiment },
});

test('declared experiment put, stripped allocation and revert all require flag AND experiment management', async () => {
  const { store, calls } = fixture(),
    requests: FlagAuthorizationRequest[] = [];
  const manager = createFlagManagement({
    ...scope,
    catalog: experimentCatalog,
    store,
    authorize: (request) => {
      requests.push(request);
      return request.requiredCapabilities.every((capability) => ['flags.manage', 'flags.killswitch'].includes(capability))
        ? { actorId: 'subject', reobserve() {} }
        : null;
    },
  });
  for (const input of [
    { ...change, override: { experiment } },
    change,
    { ...change, override: {} },
    { operation: 'revert', tenantId: null, flagId: 'feature', expectedRevision: 1, revertRevision: 0, reason: 'Strip allocation' },
  ]) {
    await assert.rejects(manager.change(input as FlagManagementChange), FlagManagementDenied);
    assert.deepEqual(requests.at(-1)!.requiredCapabilities, ['flags.manage', 'experiments.manage']);
  }
  assert.equal(calls.length, 0);
  await manager.change({ operation: 'kill', tenantId: null, flagId: 'feature', expectedRevision: 0, reason: 'Incident' });
  assert.deepEqual(requests.at(-1)!.requiredCapabilities, ['flags.killswitch']);
  assert.equal(calls.length, 1);
  await assert.rejects(manager.change({ ...change, requiredCapabilities: ['flags.manage'] } as FlagManagementChange));
});

test('experiment epochs are captured; undeclared, changed and historical allocations are refused', async () => {
  const { store, calls } = fixture();
  const authorize = () => ({ actorId: 'subject', reobserve() {} });
  const declared = {
    ...experimentCatalog,
    experiments: { feature: { version: 'v1', weights: experiment.weights.map((weight) => ({ ...weight })) } },
  };
  const manager = createFlagManagement({ ...scope, catalog: declared, store, authorize });
  declared.experiments.feature.version = 'v2';
  declared.experiments.feature.weights[0].weight = 25;
  await manager.change({ ...change, override: { experiment } });
  await manager.change(change);
  await manager.change({ operation: 'revert', tenantId: null, flagId: 'feature', expectedRevision: 1, revertRevision: 0, reason: 'Reset' });
  for (const allocation of [
    { ...experiment, version: 'v2' },
    {
      ...experiment,
      weights: [
        { value: false, weight: 25 },
        { value: true, weight: 75 },
      ],
    },
  ])
    await assert.rejects(manager.change({ ...change, override: { experiment: allocation } }), FlagManagementDenied);
  const ordinary = createFlagManagement({ ...scope, catalog: { ...experimentCatalog, experiments: {} }, store, authorize });
  await assert.rejects(ordinary.change({ ...change, override: { experiment } }), FlagManagementDenied);
  const old = normalizeFlagSnapshot(
    { ...scope, revision: 1, overrides: { feature: { experiment: { ...experiment, version: 'old' } } } },
    experimentCatalog,
  );
  const historical = createFlagManagement({
    ...scope,
    catalog: experimentCatalog,
    authorize,
    store: {
      ...store,
      history: async (...args) => {
        const page = await store.history(...args);
        return { ...page, entries: page.entries.map((entry) => ({ ...entry, after: old })) };
      },
    },
  });
  await assert.rejects(
    historical.change({
      operation: 'revert',
      tenantId: null,
      flagId: 'feature',
      expectedRevision: 1,
      revertRevision: 1,
      reason: 'Restore',
    }),
    FlagManagementDenied,
  );
  assert.equal(calls.length, 3);
});

test('full required set is reobserved before lock wait and before commit; lost experiment authority rolls back', async () => {
  const { store, order } = fixture();
  let experimentAllowed = true,
    observed = 0;
  const originalMutate = store.mutate;
  const waitingStore: FlagStore = {
    ...store,
    mutate: async (input, guard) => {
      experimentAllowed = false; // Revocation while waiting for the control row lock.
      return originalMutate(input, guard);
    },
  };
  const manager = createFlagManagement({
    ...scope,
    catalog: experimentCatalog,
    store: waitingStore,
    authorize: (request) => ({
      actorId: 'subject',
      reobserve() {
        observed++;
        assert.deepEqual(request.requiredCapabilities, ['flags.manage', 'experiments.manage']);
        if (!experimentAllowed) throw new FlagManagementDenied();
      },
    }),
  });
  await assert.rejects(manager.change(change), FlagManagementDenied);
  assert.equal(observed, 2);
  assert.deepEqual(order, ['write']);
});
