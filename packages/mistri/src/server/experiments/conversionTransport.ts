/** Actual durable-outbox transport bridge. No business transaction calls this
 * module. Publication is ACKed by the existing publisher only after ingestion.
 */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { CommandEventEnvelope } from '../../adapters/events/commandEventTypes.js';
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import {
  assertEventSourceEnvelope,
  captureEventSourceEnrollment,
  sameEventSource,
  type EventSourceEnrollment,
} from '../../adapters/events/eventSourceIdentity.js';
import { parseEventPayload } from '../commands/businessEvents.js';
import { activateEventProducer } from '../events/eventProducer.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import {
  addTime,
  digest,
  ensure,
  identifyEpoch,
  integer,
  normalizeReference,
  opaqueIdentifier,
  record,
  time,
  type CommitGuard,
  type DeliveryCompleteness,
  type EpochReference,
  type ExperimentStore,
  type RegisteredEpoch,
} from './contracts.js';
import {
  registeredConversion,
  registeredConversionEvent,
  validateExperimentDeliveryPolicy,
  type ExperimentConversionRegistry,
} from './conversionRegistry.js';
import { normalizeDelivery } from './results.js';

interface ExperimentCommittedActorObservation {
  readonly eventId: string;
  readonly receiptId: string;
  readonly appId: string;
  readonly environment: string;
  readonly evaluationTenantId: string | null;
  readonly realm: 'app' | 'tenant';
  readonly subjectId?: string;
  readonly visitorId?: string | null;
  readonly reobserve: CommitGuard;
}
export interface ExperimentOutboxOwner {
  /** Trusted native source owner verifies the committed receipt/audit and
   * resolves its historical actor as a subject, under current service authority.
   * This is not an App payload projector or an end-user session callback. */
  readonly observeCommittedActor: (envelope: CommandEventEnvelope) => Promise<ExperimentCommittedActorObservation>;
  /** This owner must include undiscovered source receipts, leased/retry/unknown
   * deliveries, failures, exposure coverage, and retention gaps. An idle tick or
   * a caller clock is not a source watermark. Reobserve fences this exact lease.
   * The adapter never manufactures a throughMs value or assumes zero backlog. */
  readonly captureCompleteness: (request: {
    readonly epoch: EpochReference;
    readonly policy: EventDeliveryPolicy;
    readonly dataRevision: number;
  }) => Promise<{
    readonly epoch: EpochReference;
    readonly destinationId: string;
    readonly dataRevision: number;
    readonly delivery: DeliveryCompleteness;
    readonly reobserve: CommitGuard;
    /** Native owners hold source fences until result-store COMMIT/rollback. */
    readonly release?: () => void | Promise<void>;
  }>;
}
interface ExperimentConversionTransportOptions {
  readonly store: ExperimentStore;
  readonly epoch: RegisteredEpoch;
  readonly registry: ExperimentConversionRegistry;
  readonly enrollment: EventSourceEnrollment;
  readonly policy: EventDeliveryPolicy;
  readonly owner: ExperimentOutboxOwner;
  readonly clock?: () => number;
}
export async function createExperimentConversionTransport(options: ExperimentConversionTransportOptions) {
  const { store, registry } = options,
    clock = options.clock ?? Date.now;
  const reference = normalizeReference(options.epoch),
    epoch = identifyEpoch(store.binding, options.epoch.declaration);
  ensure(epoch.key === reference.key && epoch.fingerprint === reference.fingerprint);
  const enrollment = captureEventSourceEnrollment(options.enrollment),
    policy = captureEventDeliveryPolicy(options.policy);
  ensure(sameEventSource(enrollment.source, policy.source) && enrollment.source.appId === epoch.declaration.scope.appId);
  validateExperimentDeliveryPolicy(registry, policy, reference, epoch.declaration.scope.evaluationTenantId);
  const metrics = [epoch.declaration.primary, ...epoch.declaration.guardrails];
  for (const metric of metrics) {
    const conversion = registeredConversion(registry, metric.id);
    ensure(
      conversion.on.name === metric.event &&
        conversion.on.version === metric.eventVersion &&
        epoch.declaration.unit === conversion.unit.kind &&
        metric.unitField === (epoch.declaration.unit === 'subject' ? 'actorId' : 'visitorId'),
    );
    ensure(
      policy.routes.some((route) => route.manifest.some((event) => event.name === metric.event && event.version === metric.eventVersion)),
      'Destination omits an epoch metric.',
    );
  }
  const observeActor = options.owner.observeCommittedActor,
    captureCompleteness = options.owner.captureCompleteness;
  ensure(typeof observeActor === 'function' && typeof captureCompleteness === 'function' && typeof clock === 'function');
  const registered = await store.readEpoch(reference);
  ensure(registered.key === epoch.key && registered.fingerprint === epoch.fingerprint);
  // Stable durable source identity: producer/correlation labels, destination
  // IDs, leases and attempt tokens cannot create a new deduplication namespace.
  const source = digest(['mistri.experiments.outbox-source.v1', store.binding, enrollment.source]);
  const transport: EventPublicationTransport = async (publication) => {
    ensure(publication.destinationId === policy.destinationId && publication.serviceId === policy.serviceId);
    ensure(publication.signal instanceof AbortSignal);
    const signal = publication.signal,
      deadline = time(publication.deadline);
    const checkAttempt = () => {
      signal.throwIfAborted();
      ensure(time(clock()) < deadline, 'Publication deadline passed.');
    };
    checkAttempt();
    const envelope = snapshot(publication.envelope, 65_536).value as unknown as CommandEventEnvelope;
    record(envelope, [
      'appId',
      'storeId',
      'sourceId',
      'scope',
      'tenantId',
      'actorId',
      'commandId',
      'commandVersion',
      'resource',
      'key',
      'receiptId',
      'requestId',
      'occurredAt',
      'correlationId',
      'causation',
      'envelopeVersion',
      'eventId',
      'ordinal',
      'name',
      'version',
      'payloadJson',
    ]);
    assertEventSourceEnvelope(envelope, enrollment.source);
    ensure(publication.idempotencyKey === envelope.eventId, 'Publication key is not the source event ID.');
    const route = policy.routes.find(
      (route) =>
        route.commandId === envelope.commandId &&
        route.commandVersion === envelope.commandVersion &&
        (route.scope === 'app'
          ? envelope.scope === 'app'
          : route.scope === 'tenant' && envelope.scope === 'tenant' && route.tenantId === envelope.tenantId),
    );
    ensure(route);
    const ordinal = integer(envelope.ordinal, 0, route.manifest.length - 1),
      expected = route.manifest[ordinal];
    ensure(expected.name === envelope.name && expected.version === envelope.version);
    const event = registeredConversionEvent(registry, envelope.name, envelope.version);
    parseEventPayload(event, envelope.payloadJson);
    const occurredAtMs = time(Date.parse(envelope.occurredAt));
    ensure(new Date(occurredAtMs).toISOString() === envelope.occurredAt);
    const selected = metrics.filter((metric) => metric.event === envelope.name && metric.eventVersion === envelope.version);
    // The route's complete manifest may include explicitly registered non-metric
    // facts. Their schemas were checked above; they are intentionally filtered.
    if (
      !selected.length ||
      occurredAtMs < epoch.declaration.startsAtMs ||
      occurredAtMs >= addTime(epoch.declaration.endsAtMs, epoch.declaration.conversionWindowMs)
    ) {
      checkAttempt();
      return 'accepted';
    }
    const observed = await observeActor(envelope);
    const actor = record(observed, [
      'eventId',
      'receiptId',
      'appId',
      'environment',
      'evaluationTenantId',
      'realm',
      'subjectId',
      'visitorId',
      'reobserve',
    ]);
    ensure(
      actor.eventId === envelope.eventId &&
        actor.receiptId === envelope.receiptId &&
        actor.appId === epoch.declaration.scope.appId &&
        actor.environment === epoch.declaration.scope.environment &&
        actor.evaluationTenantId === epoch.declaration.scope.evaluationTenantId &&
        actor.realm === (envelope.scope === 'tenant' ? 'tenant' : 'app') &&
        typeof actor.reobserve === 'function',
    );
    const unitKind = epoch.declaration.unit;
    const unitId =
      unitKind === 'visitor' && actor.visitorId === null
        ? null
        : opaqueIdentifier(unitKind === 'subject' ? actor.subjectId : actor.visitorId);
    ensure(
      unitKind === 'subject'
        ? unitId === envelope.actorId && actor.visitorId === undefined
        : actor.subjectId === undefined && envelope.actorId.startsWith('public:'),
      'Conversion unit differs from verified command provenance.',
    );
    const reobserve = actor.reobserve as CommitGuard;
    const beforeCommit = async () => {
      checkAttempt();
      await reobserve();
      checkAttempt();
    };
    await beforeCommit();
    // Explicitly unconsented public intake has no experimental unit. Its
    // durable source fact is delivered without fabricating a conversion.
    if (unitId === null) return 'accepted';
    for (const metric of selected) {
      await store.ingestConversion(
        reference,
        {
          unit: { kind: unitKind, id: unitId },
          source,
          eventId: envelope.eventId,
          event: envelope.name,
          eventVersion: envelope.version,
          metric: metric.id,
          occurredAtMs,
        },
        beforeCommit,
      );
    }
    // Partial metric commits or an ambiguous commit outcome are replay-safe:
    // source event + metric are independently deduplicated by the durable store.
    checkAttempt();
    return 'accepted';
  };
  return Object.freeze({
    enrollment,
    policy,
    epoch,
    transport,
    async publishResults() {
      const dataRevision = await store.readDataRevision(reference);
      const lease = await captureCompleteness(Object.freeze({ epoch: reference, policy, dataRevision }));
      try {
        const raw = record(lease, ['epoch', 'destinationId', 'dataRevision', 'delivery', 'reobserve', 'release']);
        const covered = normalizeReference(raw.epoch);
        ensure(
          covered.key === reference.key &&
            covered.fingerprint === reference.fingerprint &&
            raw.destinationId === policy.destinationId &&
            raw.dataRevision === dataRevision &&
            typeof raw.reobserve === 'function' &&
            (raw.release === undefined || typeof raw.release === 'function'),
        );
        const delivery = normalizeDelivery(raw.delivery),
          reobserve = raw.reobserve as CommitGuard;
        await reobserve();
        return await store.publishResults(reference, { expectedDataRevision: dataRevision, delivery }, reobserve);
      } finally {
        if (typeof lease.release === 'function') await lease.release();
      }
    },
  });
}

/** Takes ownership of an already provisioned/opened outbox destination, using
 * the existing producer's source attestation, lease, retry and ACK machinery.
 * It does not own/close the separately shared experiment store. */
export async function activateExperimentConversionProducer(
  deliveryStore: EventDeliveryStore,
  options: ExperimentConversionTransportOptions,
) {
  const clock = options.clock;
  const bridge = await createExperimentConversionTransport(options);
  ensure(JSON.stringify(captureEventDeliveryPolicy(deliveryStore.policy)) === JSON.stringify(bridge.policy));
  const producer = activateEventProducer(deliveryStore, {
    enrollment: bridge.enrollment,
    transport: bridge.transport,
    ...(clock ? { clock } : {}),
  });
  return Object.freeze({ producer, publishResults: bridge.publishResults });
}
