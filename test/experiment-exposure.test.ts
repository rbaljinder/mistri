import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExperimentContractError,
  identifyEpoch,
  normalizeEpoch,
  unitKey,
  type ExperimentEpoch,
  type ExperimentStore,
  type ExposureFact,
} from '../packages/mistri/src/server/experiments/contracts.js';
import { epochAdmits } from '../packages/mistri/src/server/experiments/eligibility.js';
import { createExperimentExposureRecorder, prepareExposure } from '../packages/mistri/src/server/experiments/exposure.js';

const binding = { suiteId: 'suite', deploymentId: 'deployment' };
const epoch: ExperimentEpoch = {
  scope: { appId: 'app', environment: 'production', controlTenantId: null, evaluationTenantId: 'tenant' },
  flagId: 'copy',
  version: 'v1',
  owner: 'product',
  unit: 'subject',
  control: 'a',
  arms: [
    { id: 'a', value: { text: 'a', nested: { a: 1, b: 2 } }, weight: 50 },
    { id: 'b', value: 'b', weight: 50 },
  ],
  eligibility: {
    rollout: 100,
    audiences: { west: { tenants: ['tenant'] }, east: { rollout: 40, roles: ['member'] } },
  },
  startsAtMs: 1000,
  endsAtMs: 2000,
  conversionWindowMs: 100,
  deliveryGraceMs: 50,
  primary: { id: 'submitted', event: 'applicationSubmitted', eventVersion: 1, unitField: 'actorSubjectId' },
  guardrails: [],
};
const reference = identifyEpoch(binding, epoch);
const fact: ExposureFact = { unit: { kind: 'subject', id: 'opaque-subject' }, arm: 'a', usedAtMs: 1500 };

test('canonical epoch freezes declaration and fingerprints every authority/allocation/window/metric field', () => {
  const canonical = identifyEpoch(binding, {
    ...epoch,
    arms: [{ ...epoch.arms[1] }, { ...epoch.arms[0], value: { nested: { b: 2, a: 1 }, text: 'a' } }],
    eligibility: { ...epoch.eligibility, audiences: { east: { roles: ['member'], rollout: 40 }, west: { tenants: ['tenant'] } } },
  });
  assert.equal(canonical.key, reference.key);
  assert.equal(canonical.fingerprint, reference.fingerprint);
  for (const change of [
    { owner: 'other' },
    { unit: 'visitor' as const },
    { control: 'b' },
    { startsAtMs: 999 },
    { endsAtMs: 2001 },
    { conversionWindowMs: 101 },
    { deliveryGraceMs: 51 },
    { arms: epoch.arms.map((arm, i) => ({ ...arm, weight: i ? 40 : 60 })) },
    { eligibility: { ...epoch.eligibility, rollout: 90 } },
    // An audience is frozen into the epoch: widening it is a new version, not a silent change of who is measured.
    { eligibility: { ...epoch.eligibility, audiences: { ...epoch.eligibility.audiences, east: { rollout: 41, roles: ['member'] } } } },
    { primary: { ...epoch.primary, event: 'different' } },
    { primary: { ...epoch.primary, eventVersion: 2 } },
    { primary: { ...epoch.primary, unitField: 'different' } },
    { guardrails: [{ id: 'withdrawn', event: 'applicationWithdrawn', eventVersion: 1, unitField: 'actorSubjectId', maxIncrease: 0.02 }] },
  ]) {
    const changed = identifyEpoch(binding, { ...epoch, ...change });
    assert.equal(changed.key, reference.key);
    assert.notEqual(changed.fingerprint, reference.fingerprint);
  }
  for (const change of [
    { flagId: 'other' },
    { version: 'v2' },
    { scope: { ...epoch.scope, appId: 'other' } },
    { scope: { ...epoch.scope, environment: 'development' } },
    { scope: { ...epoch.scope, evaluationTenantId: 'other' } },
    { scope: { ...epoch.scope, controlTenantId: 'tenant' } },
  ]) {
    assert.notEqual(identifyEpoch(binding, { ...epoch, ...change }).key, reference.key);
  }
  assert.notEqual(identifyEpoch({ ...binding, deploymentId: 'other' }, epoch).key, reference.key);
  assert.ok(Object.isFrozen(reference.declaration.arms[0].value));
  assert.ok(Object.isFrozen(reference.declaration.eligibility.audiences!.east.roles));
  assert.equal('id' in prepareExposure(reference, epoch, fact, 1600), false);
});

test('an epoch says who only through audiences: the retired segments, roles and tenants shapes are refused', () => {
  const stored = identifyEpoch(binding, epoch);
  assert.equal(identifyEpoch(binding, stored.declaration).fingerprint, stored.fingerprint);
  assert.equal(
    epochAdmits({ ...stored.declaration, eligibility: { rollout: 100, audiences: {} } }, { roles: ['reader'] }, 'other'),
    true,
    'no audience named admits everyone',
  );
  assert.throws(() =>
    identifyEpoch(binding, { ...epoch, eligibility: { rollout: 100, roles: ['member'], tenants: ['tenant'], segments: {} } } as never),
  );
  assert.throws(
    () => identifyEpoch(binding, { ...epoch, eligibility: { rollout: 100, audiences: {}, segments: {} } } as never),
    /Experiment segments are retired; name an audience\./,
  );
  for (const eligibility of [
    { rollout: 100, audiences: {}, segments: { region: ['east'] } },
    { rollout: 100, roles: ['member'], audiences: {} },
    { rollout: 100, tenants: ['tenant'], audiences: {} },
  ])
    assert.throws(() => identifyEpoch(binding, { ...epoch, eligibility } as never));
});

test('actual exposure has start-inclusive/end-exclusive event time, assigned arm, correct unit kind', () => {
  assert.equal(prepareExposure(reference, epoch, { ...fact, usedAtMs: 1000 }, 1000).usedAtMs, 1000);
  assert.equal(prepareExposure(reference, epoch, { ...fact, usedAtMs: 1999 }, 2150).late, false);
  assert.equal(prepareExposure(reference, epoch, fact, 2151).late, true);
  for (const usedAtMs of [0, 999, 2000, 2001, 1500.5, NaN, Infinity]) {
    assert.throws(() => prepareExposure(reference, epoch, { ...fact, usedAtMs }, 2500), ExperimentContractError);
  }
  assert.throws(() => prepareExposure(reference, epoch, fact, 1499), ExperimentContractError);
  assert.throws(() => prepareExposure(reference, epoch, { ...fact, arm: 'foreign' }, 1600), ExperimentContractError);
  assert.throws(
    () => prepareExposure(reference, epoch, { ...fact, unit: { kind: 'visitor', id: 'opaque' } }, 1600),
    ExperimentContractError,
  );
  const zero = { ...epoch, arms: epoch.arms.map((arm, i) => ({ ...arm, weight: i ? 100 : 0 })) };
  assert.throws(() => prepareExposure(reference, zero, fact, 1600), ExperimentContractError);
});

test('privacy and closed contracts reject raw email/IP, getters, forced variant eligibility and overflow', () => {
  for (const id of ['a@example.test', '127.0.0.1', '2001:db8::1', '::ffff:127.0.0.1', '999.1.2.3', '', 'x'.repeat(129)]) {
    assert.throws(() => prepareExposure(reference, epoch, { ...fact, unit: { kind: 'subject', id } }, 1600), ExperimentContractError);
  }
  assert.notEqual(
    unitKey(reference, fact.unit, 'subject'),
    unitKey(identifyEpoch(binding, { ...epoch, version: 'v2' }), fact.unit, 'subject'),
  );
  let getterRead = false;
  const unsafe = {
    ...epoch,
    get control() {
      getterRead = true;
      return 'a';
    },
  };
  assert.throws(() => normalizeEpoch(unsafe), ExperimentContractError);
  assert.equal(getterRead, false);
  for (const invalid of [
    { ...epoch, eligibility: { ...epoch.eligibility, rules: [{ value: 'b' }] } },
    { ...epoch, endsAtMs: 8_640_000_000_000_000 },
    { ...epoch, deliveryGraceMs: -1 },
    { ...epoch, scope: { ...epoch.scope, controlTenantId: 'other' } },
    { ...epoch, arms: Array(17).fill(epoch.arms[0]) },
    { ...epoch, arms: epoch.arms.map((arm) => ({ ...arm, weight: 49 })) },
    { ...epoch, guardrails: [{ id: 'primary', event: 'adverse', eventVersion: 1, unitField: 'actorSubjectId', maxIncrease: 0.1 }] },
  ]) {
    assert.throws(() => normalizeEpoch(invalid), ExperimentContractError);
  }
});

test('actual-use adapter requires verifier and carries reobservation through to the commit owner', async () => {
  let writes = 0,
    observations = 0;
  const guard = () => {
    observations++;
  };
  const store = {
    async ingestExposure(ref, received, beforeCommit) {
      assert.deepEqual(ref, { key: reference.key, fingerprint: reference.fingerprint });
      assert.deepEqual(received, fact);
      await beforeCommit();
      writes++;
      return { status: 'inserted', dataRevision: 1, late: false };
    },
  } as Pick<ExperimentStore, 'ingestExposure'>;
  const recorder = createExperimentExposureRecorder({
    store: store as ExperimentStore,
    epoch: reference,
    async verifyUse(receipt) {
      assert.equal(receipt, 'signed-use');
      return { fact, reobserve: guard };
    },
  });
  assert.equal(writes, 0);
  await recorder.recordUse('signed-use');
  assert.equal(writes, 1);
  assert.equal(observations, 1);
  const denied = createExperimentExposureRecorder({
    store: store as ExperimentStore,
    epoch: reference,
    async verifyUse() {
      throw new Error('Receipt/session mismatch');
    },
  });
  await assert.rejects(denied.recordUse('forged'));
  assert.equal(writes, 1);
});
