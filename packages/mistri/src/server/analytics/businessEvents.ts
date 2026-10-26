/**
 * Business events into the analytics stream, over the existing outbox.
 *
 * A funnel step `{ event: '<defineEvent name>' }` subscribes the App to that
 * event; delivery is a destination on the `command-events` outbox, the way
 * AN2 conversions are delivered. Only the name, version, occurredAt, the
 * actor's unit and the source event id are copied. The payload is never
 * parsed, copied or looked at: what a business event says is the business
 * database's, not behavior telemetry's. The source event id is the row's
 * `source_event_id`, so a redelivery after a lost acknowledgement is a no-op.
 */
import type { CommandEventEnvelope } from '../../adapters/events/commandEventTypes.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import {
  assertEventSourceEnvelope,
  captureEventSourceEnrollment,
  sameEventSource,
  type EventSourceEnrollment,
} from '../../adapters/events/eventSourceIdentity.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import type { AnalyticsStore } from './store.js';

interface AnalyticsBusinessTransportOptions {
  readonly store: AnalyticsStore;
  /** The business event names some funnel names; every other event is accepted and ignored. */
  readonly events: ReadonlySet<string>;
  readonly enrollment: EventSourceEnrollment;
  readonly policy: EventDeliveryPolicy;
  readonly environment: string;
  readonly clock?: () => number;
}

export function createAnalyticsBusinessTransport(options: AnalyticsBusinessTransportOptions) {
  const clock = options.clock ?? Date.now;
  const enrollment = captureEventSourceEnrollment(options.enrollment),
    policy = captureEventDeliveryPolicy(options.policy);
  if (!sameEventSource(enrollment.source, policy.source)) throw new Error('The analytics destination is not this source.');
  const transport: EventPublicationTransport = async (publication) => {
    if (publication.destinationId !== policy.destinationId || publication.serviceId !== policy.serviceId)
      throw new Error('Not this destination.');
    publication.signal.throwIfAborted();
    const envelope = publication.envelope as CommandEventEnvelope;
    assertEventSourceEnvelope(envelope, enrollment.source);
    if (publication.idempotencyKey !== envelope.eventId) throw new Error('Publication key is not the source event ID.');
    if (!options.events.has(envelope.name)) return 'accepted';
    const occurredAt = Date.parse(envelope.occurredAt);
    if (!Number.isFinite(occurredAt)) throw new Error('Event time is not a time.');
    // A public actor ("public:...") is no one: counted, never joined to a unit.
    const subject = !envelope.actorId.startsWith('public:');
    await options.store.append(
      [
        {
          occurredAt,
          environment: options.environment,
          tenantId: envelope.scope === 'tenant' ? envelope.tenantId : null,
          kind: 'business',
          name: envelope.name,
          step: String(envelope.version),
          unitKind: subject ? 'subject' : null,
          unitId: subject ? envelope.actorId : null,
          sourceEventId: envelope.eventId,
        },
      ],
      clock(),
    );
    return 'accepted';
  };
  return Object.freeze({ enrollment, policy, transport });
}
