import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExperimentContractError,
  identifyEpoch,
  type ConversionFact,
  type ExperimentEpoch,
  type ExperimentStore,
} from '../packages/mistri/src/server/experiments/contracts.js';
import {
  conversionIsAttributed,
  createExperimentConversionDestination,
  prepareConversion,
} from '../packages/mistri/src/server/experiments/conversions.js';

const epoch: ExperimentEpoch = {
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
  primary: { id: 'submitted', event: 'applicationSubmitted', eventVersion: 1, unitField: 'actorSubjectId' },
  guardrails: [{ id: 'withdrawn', event: 'applicationWithdrawn', eventVersion: 1, unitField: 'actorSubjectId', maxIncrease: 0.02 }],
};
const reference = identifyEpoch({ suiteId: 'suite', deploymentId: 'deployment' }, epoch);
const fact: ConversionFact = {
  unit: { kind: 'subject', id: 'subject-1' },
  source: 'business-db',
  eventId: 'event-1',
  event: 'applicationSubmitted',
  eventVersion: 1,
  metric: 'submitted',
  occurredAtMs: 1550,
};

test('attribution uses committed event time, strict following exposure and inclusive window end', () => {
  assert.equal(conversionIsAttributed(1500, 1499, 100), false);
  assert.equal(conversionIsAttributed(1500, 1500, 100), false);
  assert.equal(conversionIsAttributed(1500, 1501, 100), true);
  assert.equal(conversionIsAttributed(1500, 1600, 100), true);
  assert.equal(conversionIsAttributed(1500, 1601, 100), false);
  assert.equal(prepareConversion(reference, epoch, fact, 2150).late, false);
  const delayed = prepareConversion(reference, epoch, fact, 3000);
  assert.equal(delayed.late, true);
  assert.equal(delayed.occurredAtMs, 1550);
  assert.equal(conversionIsAttributed(1500, delayed.occurredAtMs, 100), true);
});

test('event identity is namespaced independently from binary metric outcome; raw IDs are not persisted', () => {
  const original = prepareConversion(reference, epoch, fact, 1600);
  assert.equal(original.sourceKey, prepareConversion(reference, epoch, fact, 2000).sourceKey);
  assert.notEqual(original.sourceKey, prepareConversion(reference, epoch, { ...fact, source: 'other-db' }, 1600).sourceKey);
  assert.notEqual(original.sourceKey, prepareConversion(reference, epoch, { ...fact, eventId: 'event-2' }, 1600).sourceKey);
  assert.equal(original.unitKey, prepareConversion(reference, epoch, { ...fact, eventId: 'event-2' }, 1600).unitKey);
  assert.equal(JSON.stringify(original).includes('subject-1'), false);
  assert.equal(JSON.stringify(original).includes('event-1'), false);
});

test('undeclared metrics/events, wrong unit, future eventtime and epoch-window violations refuse ingestion', () => {
  for (const change of [
    { metric: 'foreign' },
    { event: 'applicationWithdrawn' },
    { eventVersion: 2 },
    { occurredAtMs: 999 },
    { occurredAtMs: 2100 },
    { occurredAtMs: NaN },
    { unit: { kind: 'visitor' as const, id: 'opaque' } },
    { unit: { kind: 'subject' as const, id: 'a@example.test' } },
  ]) {
    assert.throws(() => prepareConversion(reference, epoch, { ...fact, ...change }, 3000), ExperimentContractError);
  }
  assert.throws(() => prepareConversion(reference, epoch, fact, 1549), ExperimentContractError);
  assert.equal(
    prepareConversion(reference, epoch, { ...fact, metric: 'withdrawn', event: 'applicationWithdrawn' }, 1600).metric,
    'withdrawn',
  );
});

test('destination resolves only after durable commit and preserves rejection for outbox retry', async () => {
  let release!: () => void,
    started!: () => void,
    committed = false,
    acknowledged = false;
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const store = {
    async ingestConversion(ref, projected, beforeCommit) {
      assert.deepEqual(ref, { key: reference.key, fingerprint: reference.fingerprint });
      assert.equal(projected, fact);
      started();
      await commit;
      await beforeCommit();
      committed = true;
      return { status: 'inserted', dataRevision: 1, late: false };
    },
  } as Pick<ExperimentStore, 'ingestConversion'>;
  const destination = createExperimentConversionDestination({
    store: store as ExperimentStore,
    epoch: reference,
    async projectCommittedEvent(event) {
      assert.equal(event, 'committed-envelope');
      return { fact, reobserve() {} };
    },
  });
  const pending = destination.deliver('committed-envelope').then(() => {
    assert.equal(committed, true);
    acknowledged = true;
  });
  await ready;
  assert.equal(acknowledged, false);
  release();
  await pending;
  assert.equal(acknowledged, true);
  const denied = createExperimentConversionDestination({
    store: {
      async ingestConversion() {
        throw new Error('Commit failed');
      },
    } as unknown as ExperimentStore,
    epoch: reference,
    async projectCommittedEvent() {
      return { fact, reobserve() {} };
    },
  });
  await assert.rejects(denied.deliver('committed-envelope'), /Commit failed/);
});
