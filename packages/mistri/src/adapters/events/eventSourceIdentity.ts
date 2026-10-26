import type { CommandEventEnvelope } from './commandEventTypes.js';
import { captureCommandEventStoreBinding, type CommandEventStoreBinding } from './commandEventSchema.js';
import { deliveryFail, deliveryText } from './eventDeliveryTypes.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

/**
 * A source enrollment is deployment-owned identity, not a request or event
 * field.  The event store metadata is the durable binding; this captured
 * value is the explicit authority required before a producer can open it.
 */
export interface EventSourceEnrollment {
  readonly source: CommandEventStoreBinding;
  readonly producerId: string;
  readonly correlationNamespace: string;
}

function exact(value: object, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    deliveryFail();
}

/** Capture an explicit source enrollment without invoking configuration hooks. */
export function captureEventSourceEnrollment(input: EventSourceEnrollment): EventSourceEnrollment {
  try {
    const value = JSON.parse(canonicalCommandJson(input, 8_192)) as EventSourceEnrollment;
    exact(value, ['source', 'producerId', 'correlationNamespace']);
    exact(value.source, ['appId', 'storeId', 'sourceId']);
    const source = captureCommandEventStoreBinding(value.source);
    deliveryText(value.producerId, 128);
    deliveryText(value.correlationNamespace, 128);
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.producerId) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.correlationNamespace))
      return deliveryFail();
    return Object.freeze({ source, producerId: value.producerId, correlationNamespace: value.correlationNamespace });
  } catch {
    return deliveryFail();
  }
}

export function sameEventSource(a: CommandEventStoreBinding, b: CommandEventStoreBinding): boolean {
  return a.appId === b.appId && a.storeId === b.storeId && a.sourceId === b.sourceId;
}

/**
 * Validate runtime provenance immediately before a trusted transport callback.
 * These values are historical facts from the source journal; this helper never
 * fills in a missing actor, tenant, correlation, or causation value.
 */
export function assertEventSourceEnvelope(envelope: CommandEventEnvelope, source: CommandEventStoreBinding): void {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return deliveryFail();
    if (
      envelope.appId !== source.appId ||
      envelope.storeId !== source.storeId ||
      envelope.sourceId !== source.sourceId ||
      envelope.envelopeVersion !== 2 ||
      envelope.correlationId !== envelope.requestId ||
      envelope.causation.kind !== 'command' ||
      envelope.causation.receiptId !== envelope.receiptId
    )
      return deliveryFail();
    // A tenant exactly in tenant scope; an App-scope event names none.
    if (envelope.scope === 'tenant') {
      deliveryText(envelope.tenantId, 128);
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(envelope.tenantId)) return deliveryFail();
    } else if (envelope.scope !== 'app' || Object.hasOwn(envelope, 'tenantId')) return deliveryFail();
    deliveryText(envelope.actorId, 512);
    deliveryText(envelope.receiptId, 128);
    deliveryText(envelope.requestId, 128);
    deliveryText(envelope.correlationId, 128);
    deliveryText(envelope.eventId, 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(envelope.eventId)) return deliveryFail();
  } catch {
    return deliveryFail();
  }
}
