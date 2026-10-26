/** Narrow committed-outbox destination, not a public conversion receiver. */
import {
  addTime,
  digest,
  ensure,
  identifier,
  integer,
  normalizeReference,
  record,
  time,
  unitKey,
  type CommitGuard,
  type ConversionFact,
  type EpochReference,
  type ExperimentEpoch,
  type ExperimentStore,
} from './contracts.js';

export function prepareConversion(reference: EpochReference, epoch: ExperimentEpoch, input: ConversionFact, receivedAtMs: number) {
  const raw = record(input, ['unit', 'source', 'eventId', 'event', 'eventVersion', 'metric', 'occurredAtMs']);
  const unit = unitKey(reference, raw.unit as ConversionFact['unit'], epoch.unit);
  const metric = identifier(raw.metric),
    event = identifier(raw.event),
    occurredAtMs = time(raw.occurredAtMs);
  const declared = [epoch.primary, ...epoch.guardrails].find((value) => value.id === metric);
  ensure(
    declared && declared.event === event && declared.eventVersion === integer(raw.eventVersion, 1),
    'Undeclared conversion event/version/metric.',
  );
  time(receivedAtMs);
  ensure(
    occurredAtMs >= epoch.startsAtMs && occurredAtMs < addTime(epoch.endsAtMs, epoch.conversionWindowMs) && occurredAtMs <= receivedAtMs,
    'Conversion event time is outside this epoch.',
  );
  return Object.freeze({
    unitKey: unit,
    metric,
    occurredAtMs,
    receivedAtMs,
    sourceKey: digest(['mistri.experiments.source.v1', identifier(raw.source), identifier(raw.eventId)]),
    late: receivedAtMs > addTime(epoch.endsAtMs, epoch.conversionWindowMs, epoch.deliveryGraceMs),
  });
}
/** Equal timestamps do not prove that conversion followed exposure. The lower
 * boundary is strict; the upper conversion-window boundary is inclusive. */
export function conversionIsAttributed(exposedAtMs: number, occurredAtMs: number, windowMs: number): boolean {
  time(exposedAtMs);
  time(occurredAtMs);
  time(windowMs);
  return occurredAtMs > exposedAtMs && occurredAtMs <= addTime(exposedAtMs, windowMs);
}

export function createExperimentConversionDestination(options: {
  readonly store: ExperimentStore;
  readonly epoch: EpochReference;
  /** Must project a durable committed event and its verified actor/intake field,
   * never an unrestricted command payload field. Scope is captured by this port. */
  readonly projectCommittedEvent: (delivery: unknown) => Promise<{ readonly fact: ConversionFact; readonly reobserve: CommitGuard }>;
}) {
  const epoch = normalizeReference(options.epoch),
    { store, projectCommittedEvent } = options;
  ensure(typeof projectCommittedEvent === 'function');
  return Object.freeze({
    async deliver(delivery: unknown) {
      const projected = await projectCommittedEvent(delivery);
      ensure(projected && typeof projected.reobserve === 'function', 'Committed event projection is required.');
      // Resolution means result-store COMMIT completed. The outbox owner then ACKs.
      // Rejection (including unknown commit outcome) must leave delivery retryable.
      return store.ingestConversion(epoch, projected.fact, projected.reobserve);
    },
  });
}
