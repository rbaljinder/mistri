import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeFlagCatalog,
  type FlagContext,
  type FlagOverride,
  type FlagProviderRequest,
  type FlagScope,
} from '../packages/mistri/src/shared/appFlags.js';
import { createFlagEvaluator } from '../packages/mistri/src/server/flags/evaluation.js';
import { captureFlagRequest, createStaticFlagProvider } from '../packages/mistri/src/server/flags/provider.js';

const catalog = normalizeFlagCatalog({
  flags: {
    enabled: { type: 'boolean', default: true, owner: 'ops', tenantManaged: true },
    copy: { type: 'string', default: 'a', safeValue: 'closed', variants: ['a', 'b', 'c'], owner: 'ops', tenantManaged: true },
  },
  roles: ['reader', 'staff'],
  audiences: {
    east: { attributes: { emailDomain: ['east.example'] } },
    west: { attributes: { emailDomain: ['west.example'] } },
    staff: { roles: ['staff'] },
    readers: { roles: ['reader'] },
    elsewhere: { roles: ['reader'], tenants: ['other'] },
    westReaders: { roles: ['reader'], tenants: ['tenant-1'], attributes: { emailDomain: ['west.example'] } },
    eastHere: { roles: ['reader', 'staff'], tenants: ['tenant-1'], attributes: { emailDomain: ['east.example'] } },
  },
});
const scope: FlagScope = { appId: 'market', environment: 'test', tenantId: 'tenant-1' };
const context: FlagContext = {
  identity: { kind: 'subject', id: 'opaque-1' },
  roles: ['reader'],
  attributes: { emailDomain: 'east.example' },
};
const run = (override: FlagOverride, ctx = context) =>
  createFlagEvaluator({ catalog, scope, context: ctx, snapshot: { ...scope, revision: 1, overrides: { copy: override } } }).evaluate(
    'copy',
  );

test('safe kill has priority over targeting, rollout and experiments', () => {
  const result = run({
    disabled: true,
    rollout: 100,
    rules: [{ audiences: ['readers'], value: 'b' }],
    experiment: {
      version: 'v1',
      weights: [
        { value: 'a', weight: 0 },
        { value: 'b', weight: 0 },
        { value: 'c', weight: 100 },
      ],
    },
  });
  assert.equal(result.value, 'closed');
  assert.equal(result.reason, 'disabled');
  const boolean = createFlagEvaluator({
    catalog,
    scope,
    context: {},
    snapshot: { ...scope, revision: 2, overrides: { enabled: { value: true, disabled: true } } },
  }).evaluate('enabled');
  assert.equal(boolean.value, false);
  assert.equal(boolean.reason, 'disabled');
  assert.deepEqual(boolean.diagnostics, []);
});

test('ordered targeting precedes rollout; a rule reaches its audiences, whose role, tenant and attribute conditions AND', () => {
  const rules = [
    { audiences: ['staff'], value: 'c' },
    { audiences: ['elsewhere'], value: 'c' },
    { audiences: ['westReaders'], value: 'c' },
    { audiences: ['eastHere'], value: 'b' },
    { audiences: ['readers'], value: 'c' },
  ];
  const result = run({ rules, rollout: 0, value: 'c' });
  assert.equal(result.value, 'b');
  assert.equal(result.reason, 'target');
  assert.equal(run({ rules, value: 'c' }, { identity: context.identity }).reason, 'override');
  const noAudience = run({ rules: [rules[3]], value: 'c' }, { identity: context.identity, roles: ['reader'] });
  assert.equal(noAudience.value, 'c');
  assert.equal(noAudience.reason, 'override');
});

test('rollout boundaries 0/100 are exact and missing identity defaults even at 100', () => {
  assert.equal(run({ value: 'b', rollout: 0 }).value, 'a');
  assert.equal(run({ value: 'b', rollout: 100 }).value, 'b');
  assert.equal(run({ value: 'b', rollout: 100 }).reason, 'rollout');
  const missing = run({ value: 'b', rollout: 100 }, {});
  assert.equal(missing.value, 'a');
  assert.deepEqual(missing.diagnostics, ['missing_identity']);
  assert.equal(run({ value: 'b' }, {}).value, 'b', 'a fixed value needs no assignment identity');
});

test('rollout cohort is monotone as percentage increases', () => {
  for (let i = 0; i < 100; i++) {
    const ctx = { identity: { kind: 'subject' as const, id: `subject-${i}` } };
    if (run({ value: 'b', rollout: 25 }, ctx).value === 'b') assert.equal(run({ value: 'b', rollout: 75 }, ctx).value, 'b');
  }
});

test('foreign App, environment and tenant snapshots always default', () => {
  for (const other of [
    { ...scope, appId: 'other' },
    { ...scope, environment: 'production' },
    { ...scope, tenantId: 'tenant-2' },
    { ...scope, tenantId: null },
  ]) {
    const result = createFlagEvaluator({
      catalog,
      scope,
      context,
      snapshot: { ...other, revision: 1, overrides: { copy: { value: 'b' } } },
    }).evaluate('copy');
    assert.equal(result.value, 'a');
    assert.equal(result.revision, null);
    assert.deepEqual(result.diagnostics, ['scope_mismatch']);
  }
});

test('invalid provider document defaults as a whole, never keeps its valid-looking subset', () => {
  for (const overrides of [
    { copy: { value: 'b' }, enabled: { value: 'yes' } },
    { copy: { value: 'undeclared' } },
    { copy: { value: 'b', expression: 'true' } },
    { copy: { value: 'b', rollout: 101 } },
  ]) {
    const result = createFlagEvaluator({ catalog, scope, context, snapshot: { ...scope, revision: 1, overrides } }).evaluate('copy');
    assert.equal(result.value, 'a');
    assert.deepEqual(result.diagnostics, ['invalid_snapshot']);
  }
});

test('invalid context defaults without treating unrecognized roles or attributes as authority', async () => {
  let calls = 0;
  const result = await captureFlagRequest({
    catalog,
    scope,
    context: { roles: ['root'] },
    provider: {
      readSnapshot() {
        calls++;
        return null;
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.evaluate('copy').value, 'a');
  assert.deepEqual(result.evaluate('copy').diagnostics, ['invalid_context']);
  assert.throws(() => result.evaluate('undeclared'), /Undeclared flag/);
});

test('provider failures and malformed values return declared defaults with sanitized diagnostics', async () => {
  for (const readSnapshot of [
    () => {
      throw new Error('private provider token');
    },
    async () => {
      throw new Error('private provider token');
    },
  ]) {
    const request = await captureFlagRequest({ catalog, scope, context, provider: { readSnapshot } });
    assert.deepEqual(request.evaluate('copy'), { value: 'a', reason: 'default', revision: null, diagnostics: ['provider_error'] });
  }
  const bad = await captureFlagRequest({ catalog, scope, context, provider: { readSnapshot: () => ({ arbitrary: 'private' }) } });
  assert.deepEqual(bad.evaluate('copy').diagnostics, ['invalid_snapshot']);
  const missingReply = await captureFlagRequest({ catalog, scope, context, provider: { readSnapshot: () => undefined } });
  assert.deepEqual(missingReply.evaluate('copy').diagnostics, ['invalid_snapshot'], 'only null means no overrides');
  const absent = await captureFlagRequest({ catalog, scope, context, provider: createStaticFlagProvider(catalog, null) });
  assert.deepEqual(absent.evaluate('copy'), { value: 'a', reason: 'default', revision: null, diagnostics: [] });
});

test('request captures before provider await and evaluates one immutable snapshot', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const givenContext = {
    identity: { kind: 'subject' as const, id: 'opaque-1' },
    roles: ['reader'],
    attributes: { emailDomain: 'east.example' },
  };
  const givenScope = { ...scope };
  const givenSnapshot = { ...scope, revision: 1, overrides: { copy: { rules: [{ audiences: ['readers'], value: 'b' }] } } };
  let calls = 0,
    received: FlagProviderRequest | undefined;
  const requestPromise = captureFlagRequest({
    catalog,
    scope: givenScope,
    context: givenContext,
    provider: {
      readSnapshot(request) {
        calls++;
        received = request;
        return pending;
      },
    },
  });
  givenContext.roles[0] = 'staff';
  givenContext.attributes.emailDomain = 'west.example';
  givenScope.appId = 'other';
  assert.ok(Object.isFrozen(received));
  assert.ok(Object.isFrozen(received!.context.roles));
  release(givenSnapshot);
  const request = await requestPromise;
  givenSnapshot.overrides.copy.rules[0].value = 'c';
  givenSnapshot.revision = 2;
  assert.equal(request.evaluate('copy').value, 'b');
  assert.equal(request.evaluate('copy').value, 'b');
  assert.equal(request.revision, 1);
  assert.equal(calls, 1);
  assert.throws(() => (request.evaluate('copy').diagnostics as string[]).push('leak'), TypeError);
});

test('static provider copies nested values and does not refresh a captured request', async () => {
  const declared = normalizeFlagCatalog({
    flags: { config: { type: 'object', default: { nested: ['default'] }, owner: 'ops' } },
    roles: [],
    audiences: {},
  });
  const local = { ...scope, tenantId: null };
  const snapshot = { ...local, revision: 1, overrides: { config: { value: { nested: ['original'] } } } };
  const provider = createStaticFlagProvider(declared, snapshot);
  snapshot.overrides.config.value.nested[0] = 'changed';
  const request = await captureFlagRequest({ catalog: declared, scope: local, context: {}, provider });
  assert.deepEqual(request.evaluate('config').value, { nested: ['original'] });
  assert.throws(() => (request.evaluate('config').value as { nested: string[] }).nested.push('leak'), TypeError);
});
