import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExperimentContractError, identifyEpoch, type ExperimentEpoch } from '../packages/mistri/src/server/experiments/contracts.js';
import { buildExperimentResult, experimentResultStatistics } from '../packages/mistri/src/server/experiments/results.js';

const declaration: ExperimentEpoch = {
  scope: { appId: 'app', environment: 'production', controlTenantId: null, evaluationTenantId: null },
  flagId: 'copy',
  version: 'v1',
  owner: 'product',
  unit: 'subject',
  control: 'a',
  arms: [
    { id: 'a', value: 'a', weight: 20 },
    { id: 'b', value: 'b', weight: 30 },
    { id: 'c', value: 'c', weight: 50 },
  ],
  eligibility: { rollout: 100, audiences: {} },
  startsAtMs: 1000,
  endsAtMs: 2000,
  conversionWindowMs: 100,
  deliveryGraceMs: 50,
  primary: { id: 'submitted', event: 'applicationSubmitted', eventVersion: 1, unitField: 'actorSubjectId' },
  guardrails: [],
};
const epoch = identifyEpoch({ suiteId: 'suite', deploymentId: 'deployment' }, declaration);
function fixture() {
  return {
    epoch,
    declaration,
    dataRevision: 10,
    evidenceRevision: 1,
    capturedAtMs: 2150,
    delivery: { throughMs: 2150, pending: 0, failed: 0, incomplete: 0 },
    diagnostics: { pendingConversions: 0, unattributedConversions: 0, lateConversions: 0, lateExposures: 0 },
    aggregates: [
      { arm: 'a', exposed: 20, mature: 20, primary: 2, guardrails: [] },
      { arm: 'b', exposed: 30, mature: 30, primary: 10, guardrails: [] },
      { arm: 'c', exposed: 50, mature: 50, primary: 25, guardrails: [] },
    ],
  };
}

test('bounded results retain epoch, declaration, evidence revision and actual-exposure allocation', () => {
  const result = buildExperimentResult(fixture()),
    stats = experimentResultStatistics(result);
  assert.equal(result.epoch.fingerprint, epoch.fingerprint);
  assert.equal(result.evidenceRevision, 1);
  assert.deepEqual(stats.srm.observed, [20, 30, 50]);
  assert.equal(stats.srm.pValue, 1);
  assert.equal(stats.status, 'final-evidence');
  assert.equal(stats.decisionAuthorization, 'not-evaluated');
  assert.equal(result.statisticsVersion, 'an2-binary-v1');
  assert.equal(stats, result.statistics);
  assert.equal(stats.methods.familySize, 2);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.input.arms[0]));
  assert.equal(JSON.stringify(result).includes('unitKey'), false);
});

test('elapsed grace alone never finalizes without delivery watermark and complete cohorts', () => {
  const base = fixture();
  for (const change of [
    { delivery: { ...base.delivery, throughMs: 2149 } },
    { delivery: { ...base.delivery, pending: 1 } },
    { delivery: { ...base.delivery, failed: 1 } },
    { delivery: { ...base.delivery, incomplete: 1 } },
    { diagnostics: { ...base.diagnostics, pendingConversions: 1 } },
    { aggregates: base.aggregates.map((arm) => ({ ...arm, mature: arm.mature - 1 })) },
  ]) {
    const stats = experimentResultStatistics(buildExperimentResult({ ...base, ...change }));
    assert.equal(stats.finalized, false);
    assert.equal(stats.status, 'descriptive');
    assert.ok(stats.comparisons.every((comparison) => comparison.pValue === null && comparison.significance === 'descriptive'));
  }
  const immature = buildExperimentResult({ ...base, aggregates: base.aggregates.map((arm) => ({ ...arm, mature: arm.mature - 1 })) });
  assert.equal(immature.input.arms[0].primary, 2);
  assert.equal(immature.input.arms[0].immature, 1);
});

test('late corrections produce separately revisioned evidence; prior decision input stays intact', () => {
  const first = buildExperimentResult(fixture());
  const next = buildExperimentResult({
    ...fixture(),
    dataRevision: 11,
    evidenceRevision: 2,
    capturedAtMs: 3000,
    diagnostics: { pendingConversions: 0, unattributedConversions: 1, lateConversions: 1, lateExposures: 0 },
    aggregates: fixture().aggregates.map((arm) => ({ ...arm, primary: arm.primary + 1 })),
  });
  assert.equal(first.evidenceRevision, 1);
  assert.equal(first.input.arms[0].primary, 2);
  assert.equal(next.evidenceRevision, 2);
  assert.equal(next.input.arms[0].primary, 3);
  assert.equal(next.diagnostics.lateConversions, 1);
  assert.equal(next.input.completeness.incomplete, 0);
});

test('invalid aggregate shapes, binary counts, timestamps, missing arms and overflow fail closed', () => {
  const base = fixture();
  for (const change of [
    { dataRevision: -1 },
    { evidenceRevision: 0 },
    { capturedAtMs: 0 },
    { delivery: { ...base.delivery, throughMs: 2151 } },
    { diagnostics: { ...base.diagnostics, pendingConversions: NaN } },
    { aggregates: base.aggregates.slice(1) },
    { aggregates: [base.aggregates[0], base.aggregates[0], base.aggregates[0]] },
    { aggregates: base.aggregates.map((arm) => ({ ...arm, primary: arm.mature + 1 })) },
    { aggregates: base.aggregates.map((arm) => ({ ...arm, mature: arm.exposed + 1 })) },
    { aggregates: base.aggregates.map((arm) => ({ ...arm, guardrails: [0] })) },
    { delivery: { ...base.delivery, pending: Number.MAX_SAFE_INTEGER }, diagnostics: { ...base.diagnostics, pendingConversions: 1 } },
  ]) {
    assert.throws(() => buildExperimentResult({ ...base, ...change }), ExperimentContractError);
  }
});
