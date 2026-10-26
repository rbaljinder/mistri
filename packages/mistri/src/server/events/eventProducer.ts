import { isProxy } from 'node:util/types';
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import {
  assertEventSourceEnvelope,
  captureEventSourceEnrollment,
  sameEventSource,
  type EventSourceEnrollment,
} from '../../adapters/events/eventSourceIdentity.js';
import { deliveryFail, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import { createEventPublisher, type EventPublicationTransport, type PublicationTick } from './eventPublisher.js';

interface EventProducerOptions {
  readonly enrollment: EventSourceEnrollment;
  readonly transport: EventPublicationTransport;
  readonly clock?: () => number;
}

export interface EventProducer {
  readonly source: EventSourceEnrollment;
  readonly policy: EventDeliveryPolicy;
  readonly tick: () => Promise<PublicationTick>;
  readonly status: () => ReturnType<ReturnType<typeof createEventPublisher>['status']>;
  readonly stop: () => Promise<void>;
}

function captureProducerOptions(input: EventProducerOptions): EventProducerOptions {
  if (!input || typeof input !== 'object' || isProxy(input)) return deliveryFail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return deliveryFail();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string' || !['enrollment', 'transport', 'clock'].includes(key))) return deliveryFail();
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return deliveryFail();
    return descriptor.value;
  };
  const transport = read('transport');
  const clock = Object.hasOwn(input, 'clock') ? read('clock') : undefined;
  if (typeof transport !== 'function' || isProxy(transport) || (clock !== undefined && (typeof clock !== 'function' || isProxy(clock)))) {
    return deliveryFail();
  }
  return Object.freeze({
    enrollment: read('enrollment') as EventSourceEnrollment,
    transport: transport as EventPublicationTransport,
    ...(clock === undefined ? {} : { clock: clock as () => number }),
  });
}

/**
 * Explicit producer activation over an opened delivery store, which the
 * store attested against its source when it opened and does again in every
 * transaction. The enrollment must name that same source. This function does
 * not open a broker, start a timer, provision a database, or expose an
 * endpoint; the producer owns the store from here and closes it on stop.
 */
export function activateEventProducer(store: EventDeliveryStore, input: EventProducerOptions): EventProducer {
  try {
    if (!store || typeof store !== 'object' || isProxy(store) || typeof store.claim !== 'function') return deliveryFail();
    const options = captureProducerOptions(input);
    const enrollment = captureEventSourceEnrollment(options.enrollment);
    const policy = store.policy;
    if (!sameEventSource(enrollment.source, policy.source)) return deliveryFail();
    const publisher = createEventPublisher(
      store,
      (publication) => {
        assertEventSourceEnvelope(publication.envelope, enrollment.source);
        return options.transport(publication);
      },
      options.clock,
    );
    return Object.freeze({ source: enrollment, policy, tick: publisher.tick, status: publisher.status, stop: publisher.stop });
  } catch {
    return deliveryFail();
  }
}
