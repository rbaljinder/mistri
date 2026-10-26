import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalCommandJson } from '../packages/engine/src/adapters/commands/canonicalJson.js';
import { COMMAND_EVENT_TABLES, CommandEventStoreUnavailable } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import type { CommandEventEnvelope } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import type { EventPublication } from '../packages/mistri/src/server/events/eventPublisher.js';
import { defineCommand, defineCommands, withCommandVersions } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { bool, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineExperimentConversion } from '../packages/mistri/src/server/experiments/declarations.js';
import {
  createExperimentConversionRegistry,
  experimentDeliveryPolicy,
} from '../packages/mistri/src/server/experiments/conversionRegistry.js';
import {
  activateExperimentConversionProducer,
  createExperimentConversionTransport,
  type ExperimentOutboxOwner,
} from '../packages/mistri/src/server/experiments/conversionTransport.js';
import {
  ExperimentConflict,
  identifyEpoch,
  type ExperimentEpoch,
  type ExperimentStore,
} from '../packages/mistri/src/server/experiments/contracts.js';
import { prepareConversion } from '../packages/mistri/src/server/experiments/conversions.js';
import { buildExperimentResult } from '../packages/mistri/src/server/experiments/results.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';

async function fixture(t: TestContext, secondMetric = false) {
  const base = eventDeliveryPolicy(1, 'tenant');
  const event = defineEvent('assignment.fact-0', shape({ assigned: bool() }));
  const conversion = defineExperimentConversion({ id: 'assigned', on: event, unit: { kind: 'subject', source: 'actor' } });
  const commands = withCommandVersions(
    defineCommands({
      assign: defineCommand({
        source: 'business',
        target: 'effects',
        output: { parse: (value) => value as { assigned: boolean } },
        events: { assignment: defineEventProjection(event, (value: { assigned: boolean }) => value) },
        handle() {
          return { assigned: true };
        },
      }),
    }),
    () => 2,
  );
  const conversions = [
    conversion,
    ...(secondMetric ? [defineExperimentConversion({ id: 'adverse', on: event, unit: { kind: 'subject', source: 'actor' } })] : []),
  ];
  const registry = createExperimentConversionRegistry({ conversions, commands });
  const declaration: ExperimentEpoch = {
    scope: { appId: base.source.appId, environment: 'production', controlTenantId: null, evaluationTenantId: 'north' },
    flagId: 'assignment',
    version: 'v1',
    owner: 'team',
    unit: 'subject',
    control: 'a',
    arms: [
      { id: 'a', value: 'a', weight: 50 },
      { id: 'b', value: 'b', weight: 50 },
    ],
    eligibility: { rollout: 100, audiences: {} },
    startsAtMs: Date.parse('2026-09-08T00:00:00.000Z'),
    endsAtMs: Date.parse('2026-09-09T00:00:00.000Z'),
    conversionWindowMs: 86_400_000,
    deliveryGraceMs: 86_400_000,
    primary: { id: 'assigned', event: event.name, eventVersion: event.version, unitField: 'actorId' },
    guardrails: secondMetric
      ? [{ id: 'adverse', event: event.name, eventVersion: event.version, unitField: 'actorId', maxIncrease: 0.1 }]
      : [],
  };
  const binding = { suiteId: 'suite', deploymentId: 'deployment' },
    epoch = identifyEpoch(binding, declaration);
  const policy = experimentDeliveryPolicy(registry, {
    epoch,
    source: base.source,
    serviceId: base.serviceId,
    commandIds: ['assign'],
    evaluationTenantId: 'north',
    limits: { ...base.limits, leaseMs: 20_000, timeoutMs: 10_000 },
  });
  const f = eventDeliveryFixture(t, policy),
    probe = f.open();
  const facts = new Map<string, ReturnType<typeof prepareConversion>>();
  const subjects: string[] = [];
  let now = 1000,
    mode: 'up' | 'down' | 'lost-ack' = 'up',
    dataRevision = 0,
    evidenceRevision = 0;
  let revoked = false,
    storeClosed = false,
    beforeCommit: (() => void) | undefined;
  let watermark = declaration.startsAtMs,
    coverageIncomplete = 0,
    ledgerGeneration = 0;
  const receivedAtMs = Date.parse('2026-09-12T00:00:00.000Z');
  const store = {
    binding,
    async readEpoch(reference) {
      assert.equal(reference.key, epoch.key);
      assert.equal(reference.fingerprint, epoch.fingerprint);
      return epoch;
    },
    async ingestConversion(reference, fact, guard) {
      if (mode === 'down') throw new Error('Experiment database unavailable');
      const value = prepareConversion(reference, declaration, fact, receivedAtMs),
        key = JSON.stringify([value.sourceKey, value.metric]);
      beforeCommit?.();
      await guard();
      subjects.push(fact.unit.id);
      const duplicate = facts.has(key);
      if (!duplicate) {
        facts.set(key, value);
        dataRevision++;
      }
      if (mode === 'lost-ack') throw new Error('Connection lost after COMMIT');
      return { status: duplicate ? 'duplicate' : 'inserted', dataRevision, late: value.late };
    },
    async readDataRevision() {
      return dataRevision;
    },
    async publishResults(reference, publication, guard) {
      if (publication.expectedDataRevision !== dataRevision) throw new ExperimentConflict();
      beforeCommit?.();
      await guard();
      return buildExperimentResult({
        epoch: reference,
        declaration,
        dataRevision,
        evidenceRevision: ++evidenceRevision,
        capturedAtMs: receivedAtMs,
        delivery: publication.delivery,
        diagnostics: { pendingConversions: 0, unattributedConversions: 0, lateConversions: facts.size, lateExposures: 0 },
        aggregates: declaration.arms.map((arm) => ({
          arm: arm.id,
          exposed: 0,
          mature: 0,
          primary: 0,
          guardrails: declaration.guardrails.map(() => 0),
        })),
      });
    },
    async close() {
      storeClosed = true;
    },
  } satisfies Pick<ExperimentStore, 'binding' | 'readEpoch' | 'ingestConversion' | 'readDataRevision' | 'publishResults' | 'close'>;
  const owner: ExperimentOutboxOwner = {
    async observeCommittedActor(envelope) {
      // This fixture's source owner verifies the real committed journal row;
      // possession of a structural publication or authored payload is not proof.
      const row = f.db.prepare(`SELECT envelope_json FROM "${COMMAND_EVENT_TABLES.event}" WHERE event_id=?`).get(envelope.eventId);
      assert.ok(row, 'source event has not committed');
      assert.equal(canonicalCommandJson(envelope), canonicalCommandJson(JSON.parse(String(row.envelope_json))));
      return {
        eventId: envelope.eventId,
        receiptId: envelope.receiptId,
        appId: policy.source.appId,
        environment: 'production',
        evaluationTenantId: 'north',
        realm: 'tenant',
        subjectId: 'native-account-proof',
        reobserve() {
          if (revoked) throw new Error('Native source authority revoked');
        },
      };
    },
    async captureCompleteness(request) {
      const generation = ledgerGeneration,
        rows = await probe.inspect(undefined, '', 100);
      const committed = Number(f.db.prepare(`SELECT count(*) AS count FROM "${COMMAND_EVENT_TABLES.event}"`).get()!.count);
      return {
        epoch: request.epoch,
        destinationId: policy.destinationId,
        dataRevision: request.dataRevision,
        delivery: {
          throughMs: watermark,
          pending: Math.max(0, committed - rows.length) + rows.filter((row) => !['delivered', 'failed'].includes(row.state)).length,
          failed: rows.filter((row) => row.state === 'failed').length,
          incomplete: coverageIncomplete,
        },
        reobserve() {
          assert.equal(ledgerGeneration, generation, 'Outbox completeness lease changed');
          if (revoked) throw new Error('Native source authority revoked');
        },
      };
    },
  };
  const options = {
    store: store as unknown as ExperimentStore,
    epoch,
    registry,
    enrollment: { source: policy.source, producerId: 'assignment-producer', correlationNamespace: 'assignment-facts' },
    policy,
    owner,
    clock: () => now,
  };
  const bridge = await createExperimentConversionTransport(options);
  const publication = (envelope: CommandEventEnvelope, signal = new AbortController().signal): EventPublication => ({
    destinationId: policy.destinationId,
    serviceId: policy.serviceId,
    idempotencyKey: envelope.eventId,
    envelope,
    deadline: now + 1000,
    signal,
  });
  return {
    f,
    probe,
    options,
    bridge,
    epoch,
    declaration,
    facts,
    subjects,
    publication,
    clock: (value: number) => {
      now = value;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    revoke: () => {
      revoked = true;
    },
    beforeCommit: (callback?: () => void) => {
      beforeCommit = callback;
    },
    storeClosed: () => storeClosed,
    watermark: (value: number) => {
      watermark = value;
      ledgerGeneration++;
    },
    incomplete: (value: number) => {
      coverageIncomplete = value;
      ledgerGeneration++;
    },
  };
}

test('real SQLite business rollback emits no conversion; committed outbox survives ingestion outage and retries', async (t) => {
  const o = await fixture(t);
  const original = DatabaseSync.prototype.prepare;
  const mocked = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith(`INSERT INTO main."${COMMAND_EVENT_TABLES.event}"`)) throw new Error('Event append failed');
    return Reflect.apply(original, this, [sql]);
  });
  await assert.rejects(o.f.seed(), CommandEventStoreUnavailable);
  mocked.mock.restore();
  assert.equal(o.f.executions(), 0);
  assert.equal(o.f.db.prepare(`SELECT count(*) AS count FROM "${COMMAND_EVENT_TABLES.event}"`).get()!.count, 0);
  const activated = await activateExperimentConversionProducer(o.f.open(), o.options);
  t.after(() => activated.producer.stop());
  assert.equal((await activated.producer.tick()).status, 'idle');
  assert.equal(o.facts.size, 0);
  const [event] = await o.f.seed();
  o.setMode('down');
  assert.equal((await activated.producer.tick()).status, 'unknown');
  assert.equal((await o.probe.inspect())[0].state, 'unknown');
  assert.equal(o.f.executions(), 1);
  assert.equal(o.facts.size, 0);
  o.clock(1010);
  o.setMode('up');
  assert.equal((await activated.producer.tick()).status, 'accepted');
  assert.equal((await o.probe.inspect())[0].eventId, event.eventId);
  assert.equal((await o.probe.inspect())[0].state, 'delivered');
  assert.equal(o.facts.size, 1);
  assert.equal(o.f.executions(), 1);
  assert.deepEqual(o.subjects, ['native-account-proof']);
  await activated.producer.stop();
  assert.equal(o.storeClosed(), false, 'producer does not own the shared experiment store');
});

test('crash after experiment COMMIT before ACK replays one source-event/metric safely after producer restart', async (t) => {
  const o = await fixture(t);
  await o.f.seed();
  o.setMode('lost-ack');
  const first = await activateExperimentConversionProducer(o.f.open(), o.options);
  assert.equal((await first.producer.tick()).status, 'unknown');
  assert.equal(o.facts.size, 1);
  assert.equal((await o.probe.inspect())[0].state, 'unknown');
  await first.producer.stop();
  o.clock(1010);
  o.setMode('up');
  const restarted = await activateExperimentConversionProducer(o.f.open(), o.options);
  t.after(() => restarted.producer.stop());
  assert.equal((await restarted.producer.tick()).status, 'accepted');
  assert.equal(o.facts.size, 1);
  assert.equal(o.subjects.length, 2);
  assert.equal((await o.probe.inspect())[0].attempts, 2);
});

test('transport pins source, tenant, command version, manifest ordinal and payload schema', async (t) => {
  const o = await fixture(t),
    [event] = await o.f.seed();
  for (const patch of [
    { sourceId: 'other' },
    { tenantId: 'south' },
    { actorId: 'forged-subject' },
    { commandVersion: 99 },
    { version: 99 },
    { ordinal: 1 },
    { name: 'other.event' },
    { payloadJson: '{"assigned":"not-a-boolean"}' },
    { payloadJson: '{"assigned":true,"actorSubjectId":"forged-subject"}' },
  ]) {
    await assert.rejects(o.bridge.transport(o.publication({ ...event, ...patch })));
  }
  await assert.rejects(o.bridge.transport({ ...o.publication(event), destinationId: 'other' }));
  await assert.rejects(o.bridge.transport({ ...o.publication(event), idempotencyKey: 'lease-token' }));
  await assert.rejects(
    createExperimentConversionTransport({
      ...o.options,
      policy: { ...o.options.policy, routes: [{ ...o.options.policy.routes[0], commandVersion: 99 }] },
    }),
  );
  await assert.rejects(
    createExperimentConversionTransport({
      ...o.options,
      enrollment: { ...o.options.enrollment, source: { ...o.options.enrollment.source, appId: 'other' } },
    }),
  );
  assert.equal(o.facts.size, 0);
});

test('partial multi-metric ingestion never ACKs early and retries each event/metric independently', async (t) => {
  const o = await fixture(t, true);
  await o.f.seed();
  o.setMode('lost-ack');
  const activated = await activateExperimentConversionProducer(o.f.open(), o.options);
  t.after(() => activated.producer.stop());
  assert.equal((await activated.producer.tick()).status, 'unknown');
  assert.equal(o.facts.size, 1);
  assert.equal((await o.probe.inspect())[0].state, 'unknown');
  o.clock(1010);
  o.setMode('up');
  assert.equal((await activated.producer.tick()).status, 'accepted');
  assert.equal(o.facts.size, 2);
  assert.deepEqual([...o.facts.values()].map((value) => value.metric).sort(), ['adverse', 'assigned']);
  assert.equal(new Set([...o.facts.values()].map((value) => value.sourceKey)).size, 1);
});

test('native actor verification cannot be replaced by a claimed subject; authority and abort reobserve at commit', async (t) => {
  const o = await fixture(t),
    [event] = await o.f.seed();
  const badOwner = {
    ...o.options.owner,
    async observeCommittedActor(envelope: CommandEventEnvelope) {
      return { ...(await o.options.owner.observeCommittedActor(envelope)), subjectId: 'payload-claimed-subject' };
    },
  };
  const bad = await createExperimentConversionTransport({ ...o.options, owner: badOwner });
  await assert.rejects(bad.transport(o.publication(event)), /verified command provenance/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(o.bridge.transport(o.publication(event, aborted.signal)));
  await assert.rejects(o.bridge.transport({ ...o.publication(event), deadline: 999 }));
  const inFlight = new AbortController();
  o.beforeCommit(() => inFlight.abort());
  await assert.rejects(o.bridge.transport(o.publication(event, inFlight.signal)));
  assert.equal(o.facts.size, 0);
  o.beforeCommit(() => o.revoke());
  await assert.rejects(o.bridge.transport(o.publication(event)), /authority revoked/);
  assert.equal(o.facts.size, 0);
});

test('outbox owner supplies discovery gaps, pending/failed delivery and watermark; wall clock cannot finalize', async (t) => {
  const o = await fixture(t);
  await o.f.seed();
  o.clock(9_000_000);
  const undiscovered = await o.bridge.publishResults();
  assert.equal(undiscovered.delivery.throughMs, o.declaration.startsAtMs);
  assert.equal(undiscovered.delivery.pending, 1);
  assert.equal(undiscovered.statistics.finalized, false);
  const activated = await activateExperimentConversionProducer(o.f.open(), o.options);
  t.after(() => activated.producer.stop());
  o.setMode('down');
  for (const now of [1000, 1010, 1030]) {
    o.clock(now);
    assert.equal((await activated.producer.tick()).status, 'unknown');
  }
  const failed = await o.bridge.publishResults();
  assert.equal(failed.delivery.failed, 1);
  assert.equal(failed.statistics.finalized, false);
  o.watermark(o.declaration.endsAtMs + o.declaration.conversionWindowMs + o.declaration.deliveryGraceMs);
  const watermarkAlone = await o.bridge.publishResults();
  assert.equal(watermarkAlone.statistics.finalized, false);
  o.beforeCommit(() => o.incomplete(1));
  await assert.rejects(o.bridge.publishResults(), /completeness lease changed/);
});

test('completion lease must cover the exact epoch, destination and ingested revision', async (t) => {
  const o = await fixture(t);
  for (const change of [
    { destinationId: 'foreign' },
    { dataRevision: 99 },
    { epoch: { key: '0'.repeat(64), fingerprint: o.epoch.fingerprint } },
  ]) {
    const owner = {
      ...o.options.owner,
      async captureCompleteness(request: Parameters<ExperimentOutboxOwner['captureCompleteness']>[0]) {
        return { ...(await o.options.owner.captureCompleteness(request)), ...change };
      },
    };
    const bridge = await createExperimentConversionTransport({ ...o.options, owner });
    await assert.rejects(bridge.publishResults());
  }
});

test('destination identity changes with epoch and routing policy, so old ACKs cannot become new evidence', async (t) => {
  const o = await fixture(t);
  const input = {
    epoch: o.epoch,
    source: o.options.policy.source,
    serviceId: o.options.policy.serviceId,
    commandIds: ['assign'],
    evaluationTenantId: 'north',
    limits: o.options.policy.limits,
  };
  assert.equal(experimentDeliveryPolicy(o.options.registry, input).destinationId, o.options.policy.destinationId);
  for (const change of [
    { epoch: identifyEpoch(o.options.store.binding, { ...o.declaration, version: 'v2' }) },
    { serviceId: 'other-service' },
    { limits: { ...input.limits, maxAttempts: 4 } },
  ]) {
    assert.notEqual(experimentDeliveryPolicy(o.options.registry, { ...input, ...change }).destinationId, o.options.policy.destinationId);
  }
  await assert.rejects(
    createExperimentConversionTransport({ ...o.options, policy: { ...o.options.policy, destinationId: 'reused-destination' } }),
  );
});
