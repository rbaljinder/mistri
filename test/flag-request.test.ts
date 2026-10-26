/** Tenant decisions compose with global controls without relabeling ownership. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFlagCatalog, type FlagOverride, type FlagOverrideSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { createComposedFlagEvaluator, captureComposedFlagRequest } from '../packages/mistri/src/server/flags/request.js';
import { createFlagEvaluator } from '../packages/mistri/src/server/flags/evaluation.js';
import type { FlagStore } from '../packages/mistri/src/server/flags/store.js';

const catalog = normalizeFlagCatalog({
  flags: {
    feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
    globalOnly: { type: 'boolean', default: false, owner: 'ops' },
  },
  roles: ['staff'],
  audiences: { north: { tenants: ['north'] }, south: { tenants: ['south'] } },
});
const scope = { appId: 'site', environment: 'production', tenantId: 'north' };
const globalScope = { ...scope, tenantId: null };
const context = { identity: { kind: 'subject' as const, id: 'subject-1' }, roles: ['staff'] };
const pair = (global: FlagOverride, tenant?: FlagOverride): { global: FlagOverrideSnapshot; tenant: FlagOverrideSnapshot } => ({
  global: { ...globalScope, revision: 3, overrides: { feature: global } },
  tenant: { ...scope, revision: 7, overrides: tenant ? { feature: tenant } : {} },
});
const evaluator = (global: FlagOverride, tenant?: FlagOverride) =>
  createComposedFlagEvaluator({ catalog, scope, context, snapshots: pair(global, tenant) });

test('global kill dominates tenant enable; local default fallback differs from an explicit default value', () => {
  const killed = evaluator({ disabled: true }, { value: true }).evaluate('feature');
  assert.equal(killed.value, false);
  assert.equal(killed.reason, 'disabled');
  assert.equal(killed.revision, 3);
  const explicit = evaluator({ value: true }, { value: false }).evaluate('feature');
  assert.equal(explicit.value, false);
  assert.equal(explicit.reason, 'override');
  assert.equal(explicit.revision, 7);
  for (const absent of [undefined, {}, { rollout: 0, value: false }, { rules: [{ audiences: ['south'], value: false }] }]) {
    assert.equal(evaluator({ value: true }, absent).evaluate('feature').value, true);
  }
  assert.equal(evaluator({ value: true }, { disabled: true }).evaluate('feature').reason, 'disabled');
  assert.deepEqual(evaluator({}, {}).version, { global: 3, tenant: 7 });
});

test('global targeting and hashing use the verified evaluation tenant while snapshot ownership remains global', () => {
  const decision = evaluator({ rules: [{ audiences: ['north'], value: true }] }).evaluate('feature');
  assert.equal(decision.value, true);
  assert.equal(decision.reason, 'target');
  for (let i = 0; i < 30; i++) {
    const selected = { identity: { kind: 'subject' as const, id: `subject-${i}` }, tenantId: 'north' };
    const snapshots = pair({ rollout: 50, value: true });
    const composed = createComposedFlagEvaluator({ catalog, scope, context: selected, snapshots });
    const expected = createFlagEvaluator({ catalog, scope, context: selected, snapshot: { ...snapshots.global, tenantId: 'north' } });
    assert.equal(composed.evaluate('feature').value, expected.evaluate('feature').value);
  }
  const foreign = createFlagEvaluator({ catalog, scope, context: { tenantId: 'south' }, snapshot: pair({}).tenant });
  assert.deepEqual(foreign.evaluate('feature').diagnostics, ['invalid_context']);
});

test('an identity-dependent tenant fallback retains its diagnostic with the global decision', () => {
  const request = createComposedFlagEvaluator({
    catalog,
    scope,
    context: {},
    snapshots: pair({ value: true }, { rollout: 100, value: false }),
  });
  assert.deepEqual(request.evaluate('feature'), { value: true, reason: 'override', revision: 3, diagnostics: ['missing_identity'] });
  const both = createComposedFlagEvaluator({
    catalog,
    scope,
    context: {},
    snapshots: pair({ rollout: 100, value: true }, { rollout: 100, value: true }),
  });
  assert.deepEqual(both.evaluate('feature').diagnostics, ['missing_identity']);
});

test('a malformed or foreign layer invalidates the whole pair, never keeping a tenant enable without its global kill', () => {
  const good = pair({ disabled: true }, { value: true });
  for (const snapshots of [
    null,
    { ...good, global: null },
    { ...good, tenant: null },
    { ...good, unexpected: true },
    { ...good, global: { ...good.global, tenantId: 'north' } },
    { ...good, tenant: { ...good.tenant, tenantId: 'south' } },
    { ...good, tenant: { ...good.tenant, overrides: { globalOnly: { value: true } } } },
  ]) {
    const request = createComposedFlagEvaluator({ catalog, scope, context, snapshots });
    assert.equal(request.evaluate('feature').value, false);
    assert.equal(request.evaluate('feature').reason, 'default');
    assert.equal(request.evaluate('feature').diagnostics.length, 1);
    assert.deepEqual(request.version, { global: null, tenant: null });
  }
  const global = createComposedFlagEvaluator({
    catalog,
    scope: globalScope,
    context,
    snapshots: { global: pair({ value: true }).global, tenant: null },
  });
  assert.equal(global.evaluate('feature').value, true);
  assert.deepEqual(global.version, { global: 3, tenant: null });
});

test('request capture performs one pair read, freezes inputs and never substitutes two independent scope reads', async () => {
  let reads = 0;
  const snapshots = pair({ value: true });
  const mutableScope = { ...scope },
    mutableContext = { ...context, roles: ['staff'] };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deployment' },
    read: async () => assert.fail('non-atomic read'),
    history: async () => assert.fail('history'),
    mutate: async () => assert.fail('mutation'),
    close: async () => {},
    async readRequestScopes(selected) {
      reads++;
      assert.ok(Object.isFrozen(selected));
      await held;
      assert.equal(selected.tenantId, 'north');
      return snapshots;
    },
  };
  const pending = captureComposedFlagRequest({ catalog, scope: mutableScope, context: mutableContext, store });
  mutableScope.tenantId = 'south';
  mutableContext.roles.push('undeclared');
  release();
  const captured = await pending;
  assert.equal(reads, 1);
  assert.equal(captured.evaluate('feature').value, true);
  (snapshots.global.overrides as Record<string, FlagOverride>).feature = { disabled: true };
  assert.equal(captured.evaluate('feature').value, true);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.version));
  const missing = await captureComposedFlagRequest({ catalog, scope, context, store: { ...store, readRequestScopes: undefined } });
  assert.deepEqual(missing.evaluate('feature').diagnostics, ['provider_error']);
  const invalid = await captureComposedFlagRequest({ catalog, scope, context: { tenantId: 'south' }, store });
  assert.deepEqual(invalid.evaluate('feature').diagnostics, ['invalid_context']);
  assert.equal(reads, 1);
});
