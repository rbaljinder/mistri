import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFlagCatalog, type FlagEvaluation } from '../packages/mistri/src/shared/appFlags.js';
import { createCommandFlags, executeWithCommandFlags } from '../packages/mistri/src/server/commands/commandFlags.js';
import { createOpenFeatureProvider } from '../packages/mistri/src/server/openfeature.js';

const catalog = normalizeFlagCatalog({
  flags: {
    launch: { type: 'boolean', default: false, owner: 'team' },
    banner: { type: 'string', default: 'plain', owner: 'team' },
    limit: { type: 'number', default: 10, owner: 'team' },
    theme: { type: 'object', default: { dense: false }, owner: 'team' },
  },
  roles: [],
  audiences: {},
});
const answers: Record<string, Pick<FlagEvaluation, 'value' | 'reason'>> = {
  launch: { value: true, reason: 'target' },
  banner: { value: 'sale', reason: 'rollout' },
  limit: { value: 25, reason: 'experiment' },
  theme: { value: { dense: true }, reason: 'disabled' },
};
const evaluate = (id: string): FlagEvaluation => ({ ...answers[id], revision: 1, diagnostics: [] });
const provider = createOpenFeatureProvider();

/** What an attempt would run in: the host's reader, with exposure recorded. */
function attempt<T>(run: () => Promise<T>, used: string[] = []) {
  const reader = createCommandFlags(
    catalog,
    { evaluate },
    () => {},
    async (id) => {
      used.push(id);
    },
  );
  return executeWithCommandFlags(reader, undefined, run);
}

test('the provider is a structural OpenFeature server provider that adds no dependency', () => {
  assert.equal(provider.metadata.name, 'mistri');
  assert.equal(provider.runsOn, 'server');
  for (const method of [
    'resolveBooleanEvaluation',
    'resolveStringEvaluation',
    'resolveNumberEvaluation',
    'resolveObjectEvaluation',
  ] as const) {
    assert.equal(typeof provider[method], 'function');
  }
});

test('the reason maps: kill is DISABLED, a rule TARGETING_MATCH, a rollout or an allocation SPLIT, anything else DEFAULT', async () => {
  await attempt(async () => {
    assert.deepEqual(await provider.resolveBooleanEvaluation('launch', false), { value: true, reason: 'TARGETING_MATCH' });
    assert.deepEqual(await provider.resolveStringEvaluation('banner', 'x'), { value: 'sale', reason: 'SPLIT' });
    assert.deepEqual(await provider.resolveNumberEvaluation('limit', 0), { value: 25, reason: 'SPLIT' });
    assert.deepEqual(await provider.resolveObjectEvaluation('theme', {}), { value: { dense: true }, reason: 'DISABLED' });
  });
  answers.launch = { value: false, reason: 'default' };
  try {
    await attempt(async () =>
      assert.deepEqual(await provider.resolveBooleanEvaluation('launch', true), { value: false, reason: 'DEFAULT' }),
    );
  } finally {
    answers.launch = { value: true, reason: 'target' };
  }
});

test('outside an attempt there is no scope: the default comes back as INVALID_CONTEXT', async () => {
  const result = await provider.resolveBooleanEvaluation('launch', false);
  assert.equal(result.value, false);
  assert.equal(result.reason, 'ERROR');
  assert.equal(result.errorCode, 'INVALID_CONTEXT');
});

test("an unknown flag is FLAG_NOT_FOUND and a wrong type is TYPE_MISMATCH, each with the caller's default", async () => {
  await attempt(async () => {
    const unknown = await provider.resolveBooleanEvaluation('nope', true);
    assert.deepEqual([unknown.value, unknown.errorCode], [true, 'FLAG_NOT_FOUND']);
    const wrong = await provider.resolveBooleanEvaluation('banner', false);
    assert.deepEqual([wrong.value, wrong.errorCode], [false, 'TYPE_MISMATCH']);
  });
});

test("the caller's EvaluationContext never targets: the decision is the verified one, whatever the context says", async () => {
  const hostile = {
    targetingKey: 'someone-else',
    roles: ['admin'],
    tenantId: 'other',
    attributes: { emailDomain: 'partner.example' },
    audiences: ['beta'],
  };
  await attempt(async () => {
    const plain = await provider.resolveBooleanEvaluation('launch', false);
    const withContext = await provider.resolveBooleanEvaluation('launch', false, hostile);
    assert.deepEqual(withContext, plain);
  });
});

test('a read counts as exposure, as ctx.flags.get does, and a retired attempt answers an error', async () => {
  const used: string[] = [];
  let late: Promise<unknown> | undefined;
  await attempt(async () => {
    await provider.resolveStringEvaluation('banner', 'x');
    await provider.resolveStringEvaluation('banner', 'x');
    late = new Promise((resolve) => setTimeout(resolve, 20)).then(() => provider.resolveStringEvaluation('banner', 'x'));
  }, used);
  assert.deepEqual(used, ['banner'], 'once per flag per attempt');
  const retired = (await late) as { errorCode?: string; value: string };
  assert.deepEqual([retired.value, retired.errorCode], ['x', 'GENERAL']);
});
