import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventDeliveryUnavailable } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { assertEventSourceEnvelope, captureEventSourceEnrollment } from '../packages/mistri/src/adapters/events/eventSourceIdentity.js';
import { activateEventProducer } from '../packages/mistri/src/server/events/eventProducer.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';

const enrollment = {
  source: { appId: 'publication-proof', storeId: 'publication-store', sourceId: 'business' },
  producerId: 'assignment-producer',
  correlationNamespace: 'assignment-facts',
};

test('source enrollment is explicit, bounded, immutable, and never derives identity from a path', () => {
  const captured = captureEventSourceEnrollment(enrollment);
  assert.deepEqual(captured, enrollment);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.source));
  for (const patch of [
    { producerId: '' },
    { correlationNamespace: 'has whitespace' },
    { source: { ...enrollment.source, sourceId: '../source' } },
    { extra: 'request supplied' },
  ])
    assert.throws(() => captureEventSourceEnrollment({ ...enrollment, ...patch } as never), EventDeliveryUnavailable);
});

test('explicit producer activation over an opened store publishes through the bounded private publisher', async (t) => {
  // The shared limits are tight so timeout and lease tests run fast; a 20 ms send budget is a timeout on a busy CI
  // runner, and this test proves the path that is not one. The limits it keeps prove nothing here.
  const policy = eventDeliveryPolicy();
  const f = eventDeliveryFixture(t, { ...policy, limits: { ...policy.limits, leaseMs: 30_000, timeoutMs: 10_000 } });
  const [event] = await f.seed();
  const received: string[] = [];
  const producer = activateEventProducer(f.open(), {
    enrollment,
    transport: async (publication) => {
      received.push(publication.idempotencyKey);
      assert.equal(publication.envelope.eventId, event.eventId);
      assert.equal(publication.envelope.sourceId, enrollment.source.sourceId);
      assert.equal(publication.envelope.correlationId, publication.envelope.requestId);
      assert.equal(publication.envelope.causation.receiptId, publication.envelope.receiptId);
      return 'accepted';
    },
  });
  try {
    assert.deepEqual(producer.source, enrollment);
    assert.equal(producer.policy.source.sourceId, enrollment.source.sourceId);
    assert.equal((await producer.tick()).status, 'accepted');
    assert.deepEqual(received, [event.eventId]);
  } finally {
    await producer.stop();
  }
});

test('producer activation refuses an enrollment for another source, a missing store, and a policy option', (t) => {
  const f = eventDeliveryFixture(t);
  assert.throws(
    () =>
      activateEventProducer(f.open(), {
        enrollment: { ...enrollment, source: { ...enrollment.source, storeId: 'other-store' } },
        transport: async () => 'accepted',
      }),
    EventDeliveryUnavailable,
  );
  assert.throws(
    () => activateEventProducer(f.open(), { enrollment, policy: f.policy, transport: async () => 'accepted' } as never),
    EventDeliveryUnavailable,
  );
  const unprovisioned = eventDeliveryFixture(t, f.policy, false);
  assert.throws(() => unprovisioned.open(), EventDeliveryUnavailable);
});

test('source envelope provenance is checked without filling or normalizing actor, tenant, or correlation', (t) => {
  const f = eventDeliveryFixture(t);
  return f.seed().then(([event]) => {
    assert.doesNotThrow(() => assertEventSourceEnvelope(event, enrollment.source));
    for (const patch of [
      { actorId: '' },
      { tenantId: '' },
      { scope: 'app' },
      { envelopeVersion: 1 },
      { correlationId: 'different-correlation' },
      { causation: { kind: 'command', receiptId: 'different-receipt' } },
      { sourceId: 'other-source' },
    ])
      assert.throws(() => assertEventSourceEnvelope({ ...event, ...patch } as never, enrollment.source), EventDeliveryUnavailable);
  });
});
