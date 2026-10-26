import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagAssignmentBucket, type FlagAssignment } from '../packages/mistri/src/server/flags/assignment.js';
import { createFlagEvaluator } from '../packages/mistri/src/server/flags/evaluation.js';
import { FlagValidationError, normalizeFlagCatalog, type FlagExperiment } from '../packages/mistri/src/shared/appFlags.js';

const base: FlagAssignment = {
  appId: 'market',
  environment: 'test',
  tenantId: null,
  flagId: 'copy',
  experimentVersion: 'v1',
  purpose: 'variant',
  identity: { kind: 'subject', id: 'opaque-1' },
};
const catalog = normalizeFlagCatalog({
  flags: { copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'product', tenantManaged: true } },
  roles: [],
  audiences: {},
});
const experiment: FlagExperiment = {
  version: 'v1',
  weights: [
    { value: 'a', weight: 40 },
    { value: 'b', weight: 60 },
  ],
};
const scope = { appId: 'market', environment: 'test', tenantId: null };

test('assignment is deterministic, bounded and needs identity, never randomness', () => {
  const first = flagAssignmentBucket(base);
  assert.equal(flagAssignmentBucket({ ...base }), first);
  assert.equal(first, 93.94530955712277, 'v1 assignment protocol stays stable across releases');
  assert.equal(flagAssignmentBucket({ ...base, purpose: 'rollout' }), 18.476202768704297);
  assert.ok(first !== null && first >= 0 && first < 100);
  const { identity: _identity, ...anonymous } = base;
  assert.equal(flagAssignmentBucket(anonymous), null);
  for (let i = 0; i < 2000; i++) {
    const bucket = flagAssignmentBucket({ ...base, identity: { kind: 'visitor', id: `visitor-${i}` } });
    assert.ok(bucket !== null && bucket >= 0 && bucket < 100);
  }
});

test('assignment rejects undeclared inputs and does not hash raw identifying fields', () => {
  for (const input of [
    { ...base, email: 'person@example.test' },
    { ...base, purpose: 'arbitrary' },
    { ...base, experimentVersion: undefined },
    { ...base, identity: { kind: 'visitor', id: '127.0.0.1' } },
  ]) {
    assert.throws(() => flagAssignmentBucket(input as FlagAssignment), FlagValidationError);
  }
});

test('App, environment, tenant, flag, experiment version, identity kind and purpose isolate assignments', () => {
  const cases: FlagAssignment[] = [
    base,
    { ...base, appId: 'dealer' },
    { ...base, environment: 'production' },
    { ...base, tenantId: 'one' },
    { ...base, tenantId: 'two' },
    { ...base, flagId: 'other' },
    { ...base, experimentVersion: 'v2' },
    { ...base, experimentVersion: null },
    { ...base, identity: { kind: 'visitor', id: 'opaque-1' } },
    { ...base, purpose: 'rollout' },
  ];
  assert.equal(new Set(cases.map(flagAssignmentBucket)).size, cases.length);
  assert.notEqual(
    flagAssignmentBucket({ ...base, appId: 'ab', environment: 'c' }),
    flagAssignmentBucket({ ...base, appId: 'a', environment: 'bc' }),
    'namespace tuple is unambiguous',
  );
});

test('experiment allocation is sticky across snapshots and weight order, and uses canonical variant indices', () => {
  const context = { identity: base.identity };
  const run = (revision: number, allocation = experiment) =>
    createFlagEvaluator({
      catalog,
      scope,
      context,
      snapshot: { ...scope, revision, overrides: { copy: { experiment: allocation } } },
    }).evaluate('copy');
  const first = run(1);
  assert.equal(first.reason, 'experiment');
  assert.equal(first.experimentVersion, 'v1');
  assert.equal(first.value, catalog.flags.copy.variants![first.variant!]);
  assert.equal(run(2).value, first.value);
  assert.equal(run(3, { ...experiment, weights: [...experiment.weights].reverse() }).value, first.value);
});

test('zero weights never receive an assignment; 100 percent gets every identified subject', () => {
  for (let i = 0; i < 100; i++) {
    const result = createFlagEvaluator({
      catalog,
      scope,
      context: { identity: { kind: 'visitor', id: `visitor-${i}` } },
      snapshot: {
        ...scope,
        revision: 1,
        overrides: {
          copy: {
            experiment: {
              version: 'v1',
              weights: [
                { value: 'a', weight: 0 },
                { value: 'b', weight: 100 },
              ],
            },
          },
        },
      },
    }).evaluate('copy');
    assert.equal(result.value, 'b');
    assert.equal(result.variant, 1);
  }
});

test('missing experiment identity returns the declared default and a bounded diagnostic', () => {
  const result = createFlagEvaluator({
    catalog,
    scope,
    context: {},
    snapshot: { ...scope, revision: 1, overrides: { copy: { experiment } } },
  }).evaluate('copy');
  assert.equal(result.value, 'a');
  assert.equal(result.reason, 'default');
  assert.deepEqual(result.diagnostics, ['missing_identity']);
  assert.equal(result.variant, undefined);
});

test('object variants compare structurally, are assigned canonically and remain frozen', () => {
  const declared = normalizeFlagCatalog({
    flags: {
      object: {
        type: 'object',
        default: { a: 1, b: 2 },
        variants: [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        owner: 'ops',
      },
    },
    roles: [],
    audiences: {},
  });
  const result = createFlagEvaluator({
    catalog: declared,
    scope,
    context: { identity: base.identity },
    snapshot: {
      ...scope,
      revision: 1,
      overrides: {
        object: {
          experiment: {
            version: 'v1',
            weights: [
              { value: { b: 2, a: 1 }, weight: 0 },
              { value: { b: 4, a: 3 }, weight: 100 },
            ],
          },
        },
      },
    },
  }).evaluate('object');
  assert.deepEqual(result.value, { a: 3, b: 4 });
  assert.equal(result.variant, 1);
  assert.ok(Object.isFrozen(result.value));
});
