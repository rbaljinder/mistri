import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFlagSnapshot, type FlagOverride } from '../packages/mistri/src/shared/appFlags.js';
import {
  matchFlagCapabilities,
  type FlagAuthorityCatalog,
  type FlagRequiredCapability,
} from '../packages/mistri/src/server/flags/authority.js';
import {
  FlagManagementDenied,
  FlagRevisionConflict,
  normalizeFlagStoreMutation,
  type FlagHistoryEntry,
  type FlagStore,
} from '../packages/mistri/src/server/flags/store.js';
import { createExperimentDecisionManager } from '../packages/mistri/src/server/experiments/decisions.js';
import {
  ExperimentConflict,
  identifyEpoch,
  type ExperimentEpoch,
  type ExperimentResult,
  type ExperimentStore,
} from '../packages/mistri/src/server/experiments/contracts.js';
import { buildExperimentResult } from '../packages/mistri/src/server/experiments/results.js';

const binding = { suiteId: 'suite', deploymentId: 'deployment' };
const scope = { appId: 'app', environment: 'production', tenantId: null };
const allocation = {
  version: 'v1',
  weights: [
    { value: 'a', weight: 50 },
    { value: 'b', weight: 50 },
  ],
};
const catalog: FlagAuthorityCatalog = {
  flags: { copy: { type: 'string', default: 'a', safeValue: 'a', variants: ['a', 'b'], owner: 'product', tenantManaged: true } },
  roles: ['staff'],
  audiences: { staff: { roles: ['staff'] } },
  experiments: { copy: allocation },
};
const controls = { flags: catalog.flags, roles: catalog.roles, audiences: catalog.audiences };
const declaration: ExperimentEpoch = {
  scope: { appId: 'app', environment: 'production', controlTenantId: null, evaluationTenantId: null },
  flagId: 'copy',
  version: 'v1',
  owner: 'product',
  unit: 'subject',
  control: 'a',
  arms: [
    { id: 'a', value: 'a', weight: 50 },
    { id: 'b', value: 'b', weight: 50 },
  ],
  eligibility: { rollout: 100, audiences: {} },
  startsAtMs: 1000,
  endsAtMs: 2000,
  conversionWindowMs: 100,
  deliveryGraceMs: 50,
  primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
  guardrails: [{ id: 'withdrawn', event: 'withdrawn', eventVersion: 1, unitField: 'actorId', maxIncrease: 0.1 }],
};
const epoch = identifyEpoch(binding, declaration);
const resultInput = () => ({
  epoch,
  declaration,
  dataRevision: 10,
  evidenceRevision: 1,
  capturedAtMs: 2150,
  delivery: { throughMs: 2150, pending: 0, failed: 0, incomplete: 0 },
  diagnostics: { pendingConversions: 0, unattributedConversions: 0, lateConversions: 0, lateExposures: 0 },
  aggregates: [
    { arm: 'a', exposed: 1000, mature: 1000, primary: 100, guardrails: [0] },
    { arm: 'b', exposed: 1000, mature: 1000, primary: 300, guardrails: [0] },
  ],
});
const request = {
  tenantId: null,
  flagId: 'copy',
  epochFingerprint: epoch.fingerprint,
  expectedRevision: 1,
  expectedResultRevision: 1,
  winnerVariant: 'b',
  reason: 'Apply reviewed winner',
} as const;
function fixture(capabilities: readonly FlagRequiredCapability[] = ['flags.manage', 'experiments.manage', 'experiments.decide']) {
  let snapshot = normalizeFlagSnapshot({ ...scope, revision: 1, overrides: { copy: { experiment: allocation } } }, catalog);
  const history: FlagHistoryEntry[] = [],
    correlations: unknown[] = [],
    operations: string[] = [];
  let evidence: ExperimentResult = buildExperimentResult(resultInput()),
    dataRevision = evidence.dataRevision;
  let observe = () => {},
    onRead = () => {},
    onMutate = () => {},
    unknownCommit = false;
  const flags: FlagStore = {
    binding,
    async read() {
      operations.push('control-read');
      onRead();
      return snapshot;
    },
    async history() {
      return { entries: [...history].reverse(), nextBeforeRevision: null };
    },
    async close() {},
    async mutate(input, guard) {
      operations.push('mutate');
      onMutate();
      const change = normalizeFlagStoreMutation(input);
      if (change.expectedRevision !== snapshot.revision) throw new FlagRevisionConflict();
      assert.equal(change.operation, 'decide');
      if (change.operation !== 'decide') throw Error();
      const before = snapshot,
        after = normalizeFlagSnapshot(
          { ...scope, revision: snapshot.revision + 1, overrides: { copy: { value: change.evidence.winnerVariant } } },
          catalog,
        );
      const entry: FlagHistoryEntry = {
        scope,
        before,
        after,
        revision: after.revision,
        flagId: 'copy',
        actorId: change.actorId,
        reason: change.reason,
        operation: 'decide',
        evidence: change.evidence,
        at: '2026-09-30T00:00:00.000Z',
        revertRevision: null,
      };
      await guard();
      snapshot = after;
      history.push(entry);
      if (unknownCommit) throw Error('Unknown commit outcome');
      return entry;
    },
  };
  const experiments = {
    binding,
    async readEpoch() {
      operations.push('epoch-read');
      return epoch;
    },
    async readResults() {
      operations.push('results-read');
      return evidence;
    },
    async readDataRevision() {
      return dataRevision;
    },
    async appendDecisionEvidence(_epoch: unknown, input: unknown, guard: () => void | Promise<void>) {
      await guard();
      correlations.push(input);
      return input;
    },
  } as unknown as ExperimentStore;
  const manager = createExperimentDecisionManager({
    ...scope,
    catalog,
    epochs: [declaration],
    flags,
    experiments,
    authorize: (auth) => {
      operations.push(`authorize:${auth.operation}`);
      const roles = {
        operator: {
          flags: [
            {
              actions: capabilities.filter((cap) => cap.startsWith('flags.')).map((cap) => cap.split('.')[1]) as ('view' | 'manage')[],
              environments: ['production'],
              owners: ['product'],
            },
          ],
          experiments: [
            {
              actions: capabilities.filter((cap) => cap.startsWith('experiments.')).map((cap) => cap.split('.')[1]) as (
                | 'view'
                | 'manage'
                | 'decide'
              )[],
              environments: ['production'],
              owners: ['product'],
            },
          ],
        },
      };
      if (!matchFlagCapabilities(roles, ['operator'], 'app', auth)) return null;
      return {
        actorId: 'subject',
        reobserve() {
          operations.push('reobserve');
          observe();
        },
      };
    },
  });
  return {
    manager,
    flags,
    experiments,
    history,
    correlations,
    operations,
    get snapshot() {
      return snapshot;
    },
    setEvidence(value: ExperimentResult) {
      evidence = value;
      dataRevision = value.dataRevision;
    },
    setDataRevision(value: number) {
      dataRevision = value;
    },
    setOverride(value: FlagOverride, revision = snapshot.revision) {
      snapshot = normalizeFlagSnapshot({ ...scope, revision, overrides: { copy: value } }, catalog);
    },
    onObserve(fn: () => void) {
      observe = fn;
    },
    onRead(fn: () => void) {
      onRead = fn;
    },
    onMutate(fn: () => void) {
      onMutate = fn;
    },
    unknownCommit() {
      unknownCommit = true;
    },
  };
}

test('decide requires all three independent capabilities; view is neither implied nor required', async () => {
  const all: FlagRequiredCapability[] = ['flags.manage', 'experiments.manage', 'experiments.decide'];
  for (let mask = 0; mask < 7; mask++) {
    const f = fixture(all.filter((_, index) => mask & (1 << index)));
    await assert.rejects(f.manager.decide(request), FlagManagementDenied);
    assert.deepEqual(f.operations, ['authorize:decide']);
  }
  const f = fixture();
  assert.deepEqual(await f.manager.decide(request), { flagId: 'copy', revision: 2, operation: 'decide' });
  assert.deepEqual(f.snapshot.overrides.copy, { value: 'b' });
  assert.deepEqual(f.history[0].evidence, { epochFingerprint: epoch.fingerprint, resultsRevision: 1, winnerVariant: 'b' });
  assert.equal(Object.isFrozen(f.history[0].evidence), true);
  await assert.rejects(f.manager.results(request), /./, 'closed read request refuses mutation fields');
  const read = { tenantId: null, flagId: 'copy', epochFingerprint: epoch.fingerprint };
  await assert.rejects(f.manager.results(read), FlagManagementDenied);
  const viewer = fixture(['experiments.view']);
  assert.equal((await viewer.manager.results(read)).evidenceRevision, 1);
  await assert.rejects(viewer.manager.decide(request), FlagManagementDenied);
});

test('premature, incomplete, immature, SRM-failed/insufficient and unsafe guardrail results refuse decisions', async () => {
  const base = resultInput();
  const changes = [
    { capturedAtMs: 2149, delivery: { ...base.delivery, throughMs: 2149 } },
    ...['pending', 'failed', 'incomplete'].map((key) => ({ delivery: { ...base.delivery, [key]: 1 } })),
    { aggregates: base.aggregates.map((arm) => ({ ...arm, mature: 999 })) },
    { aggregates: [base.aggregates[0], { ...base.aggregates[1], exposed: 500, mature: 500 }] },
    { aggregates: base.aggregates.map((arm) => ({ ...arm, exposed: 4, mature: 4, primary: 1 })) },
    { aggregates: [base.aggregates[0], { ...base.aggregates[1], guardrails: [500] }] },
    { aggregates: [base.aggregates[0], { ...base.aggregates[1], guardrails: [90] }] },
  ];
  for (const change of changes) {
    const f = fixture();
    f.setEvidence(buildExperimentResult({ ...base, ...change }));
    await assert.rejects(f.manager.decide(request));
    assert.equal(f.history.length, 0);
    assert.equal(f.correlations.length, 0);
  }
});

test('stale result revisions, unpublished corrections and whole-scope control CAS never retry', async () => {
  const stale = fixture();
  stale.setEvidence(buildExperimentResult({ ...resultInput(), evidenceRevision: 2 }));
  await assert.rejects(stale.manager.decide(request), ExperimentConflict);
  const dirty = fixture();
  dirty.setDataRevision(11);
  await assert.rejects(dirty.manager.decide(request), ExperimentConflict);
  const cas = fixture();
  cas.onMutate(() => cas.setOverride({ experiment: allocation }, 2));
  await assert.rejects(cas.manager.decide(request), FlagRevisionConflict);
  assert.equal(cas.operations.filter((op) => op === 'mutate').length, 1);
  assert.equal(cas.correlations.length, 1, 'separate result correlation may remain orphaned');
  assert.equal(cas.history.length, 0);
  const corrected = fixture();
  corrected.onMutate(() => corrected.setEvidence(buildExperimentResult({ ...resultInput(), evidenceRevision: 2 })));
  await assert.rejects(corrected.manager.decide(request), ExperimentConflict);
  assert.equal(corrected.history.length, 0);
});

test('foreign epoch/scope/winner, wrong live allocation and fixed-value bypass are refused', async () => {
  for (const change of [{ epochFingerprint: '0'.repeat(64) }, { tenantId: 'tenant' }, { winnerVariant: 'foreign' }, { appId: 'foreign' }]) {
    const f = fixture();
    await assert.rejects(f.manager.decide({ ...request, ...change }));
    assert.equal(f.history.length, 0);
  }
  for (const override of [
    { value: 'b' },
    { experiment: { ...allocation, version: 'v2' } },
    {
      experiment: {
        ...allocation,
        weights: [
          { value: 'a', weight: 20 },
          { value: 'b', weight: 80 },
        ],
      },
    },
    { experiment: allocation, rollout: 25 },
    { experiment: allocation, rules: [{ audiences: ['staff'], value: 'a' }] },
  ]) {
    const f = fixture();
    f.setOverride(override);
    await assert.rejects(f.manager.decide(request));
    assert.equal(f.history.length, 0);
  }
  const f = fixture(),
    perTenant = { ...declaration, scope: { ...declaration.scope, evaluationTenantId: 'tenant' } };
  const manager = createExperimentDecisionManager({
    ...scope,
    catalog,
    epochs: [perTenant],
    flags: f.flags,
    experiments: f.experiments,
    authorize: () => ({ actorId: 'subject', reobserve() {} }),
  });
  await assert.rejects(
    manager.decide({ ...request, epochFingerprint: identifyEpoch(binding, perTenant).fingerprint }),
    FlagManagementDenied,
  );
});

test('authority is current before pending reads and rechecked inside the flag transaction', async () => {
  const denied = fixture();
  denied.onObserve(() => {
    throw new FlagManagementDenied();
  });
  await assert.rejects(denied.manager.decide(request), FlagManagementDenied);
  assert.deepEqual(denied.operations, ['authorize:decide', 'reobserve']);
  const revoked = fixture();
  revoked.onMutate(() =>
    revoked.onObserve(() => {
      throw new FlagManagementDenied();
    }),
  );
  await assert.rejects(revoked.manager.decide(request), FlagManagementDenied);
  assert.equal(revoked.history.length, 0);
  assert.equal(revoked.snapshot.revision, 1);
  assert.equal(revoked.correlations.length, 1);
});

test('a corrected explicit decision preserves the original audit evidence reference', async () => {
  const f = fixture();
  await f.manager.decide(request);
  const previous = f.history[0].evidence;
  f.setEvidence(buildExperimentResult({ ...resultInput(), dataRevision: 11, evidenceRevision: 2 }));
  await f.manager.decide({ ...request, expectedRevision: 2, expectedResultRevision: 2, winnerVariant: 'a' });
  assert.equal(f.snapshot.revision, 3);
  assert.deepEqual(f.snapshot.overrides.copy, { value: 'a' });
  assert.equal(f.history[0].evidence, previous);
  assert.equal(previous?.resultsRevision, 1);
  assert.equal(f.history[1].evidence?.resultsRevision, 2);
  assert.equal(f.correlations.length, 2);
});

test('unknown commit is surfaced once and must be reconciled from control history', async () => {
  const f = fixture();
  f.unknownCommit();
  await assert.rejects(f.manager.decide(request), /Unknown commit outcome/);
  assert.equal(f.operations.filter((op) => op === 'mutate').length, 1);
  assert.equal(f.snapshot.revision, 2);
  assert.equal(f.history[0].operation, 'decide');
  await assert.rejects(f.manager.decide(request), FlagRevisionConflict);
});

test('trusted mutation contract cannot disguise decision evidence as set or reason text', () => {
  const base = { scope, catalog: controls, flagId: 'copy', expectedRevision: 0, actorId: 'subject', reason: 'Reviewed' };
  const evidence = { epochFingerprint: epoch.fingerprint, resultsRevision: 1, winnerVariant: 'b' };
  assert.equal(normalizeFlagStoreMutation({ ...base, operation: 'decide', evidence }).operation, 'decide');
  assert.throws(() => normalizeFlagStoreMutation({ ...base, operation: 'set', override: { value: 'b' }, evidence }));
  assert.throws(() => normalizeFlagStoreMutation({ ...base, operation: 'decide', reason: JSON.stringify(evidence) }));
  for (const patch of [{ resultsRevision: 0 }, { resultsRevision: 1.5 }, { epochFingerprint: 'bad' }, { winnerVariant: 'c' }]) {
    assert.throws(() => normalizeFlagStoreMutation({ ...base, operation: 'decide', evidence: { ...evidence, ...patch } }));
  }
});

test('registered and result evidence cannot substitute another declared App/environment/tenant epoch', async () => {
  for (const patch of [
    { appId: 'foreign' },
    { environment: 'development' },
    { controlTenantId: 'tenant', evaluationTenantId: 'tenant' },
    { evaluationTenantId: 'tenant' },
  ]) {
    const foreign = { ...declaration, scope: { ...declaration.scope, ...patch } };
    const registered = identifyEpoch(binding, foreign);
    const f = fixture();
    f.experiments.readEpoch = async () => registered;
    await assert.rejects(f.manager.decide(request), ExperimentConflict);
    assert.equal(f.history.length, 0);
    const result = fixture();
    result.setEvidence(buildExperimentResult({ ...resultInput(), epoch: registered, declaration: foreign }));
    await assert.rejects(result.manager.decide(request), ExperimentConflict);
    assert.equal(result.history.length, 0);
  }
  const f = fixture();
  assert.throws(() =>
    createExperimentDecisionManager({
      ...scope,
      catalog,
      epochs: [{ ...declaration, version: 'foreign' }],
      flags: f.flags,
      experiments: f.experiments,
      authorize: () => null,
    }),
  );
});
