/** Bounded aggregate-to-evidence projection. No raw unit/event IDs leave here. */
import { computeExperimentStatistics, type ExperimentStatisticsInput } from './statistics.js';
import {
  addTime,
  ensure,
  integer,
  normalizeEpoch,
  normalizeReference,
  record,
  time,
  type DeliveryCompleteness,
  type EpochReference,
  type ExperimentEpoch,
  type ExperimentResult,
} from './contracts.js';

export interface ArmAggregate {
  readonly arm: string;
  readonly exposed: number;
  readonly mature: number;
  readonly primary: number;
  readonly guardrails: readonly number[];
}
export function normalizeDelivery(input: unknown): DeliveryCompleteness {
  const raw = record(input, ['throughMs', 'pending', 'failed', 'incomplete']);
  return Object.freeze({
    throughMs: time(raw.throughMs),
    pending: integer(raw.pending),
    failed: integer(raw.failed),
    incomplete: integer(raw.incomplete),
  });
}
export function buildExperimentResult(input: {
  readonly epoch: EpochReference;
  readonly declaration: ExperimentEpoch;
  readonly dataRevision: number;
  readonly evidenceRevision: number;
  readonly capturedAtMs: number;
  readonly delivery: DeliveryCompleteness;
  readonly diagnostics: ExperimentResult['diagnostics'];
  readonly aggregates: readonly ArmAggregate[];
}): ExperimentResult {
  const epoch = normalizeReference(input.epoch),
    declaration = normalizeEpoch(input.declaration);
  const capturedAtMs = time(input.capturedAtMs),
    delivery = normalizeDelivery(input.delivery);
  const dataRevision = integer(input.dataRevision),
    evidenceRevision = integer(input.evidenceRevision, 1);
  ensure(delivery.throughMs <= capturedAtMs);
  ensure(Array.isArray(input.aggregates) && input.aggregates.length === declaration.arms.length);
  const diagnostics = Object.freeze({
    pendingConversions: integer(input.diagnostics.pendingConversions),
    unattributedConversions: integer(input.diagnostics.unattributedConversions),
    lateConversions: integer(input.diagnostics.lateConversions),
    lateExposures: integer(input.diagnostics.lateExposures),
  });
  const finalizesAtMs = addTime(declaration.endsAtMs, declaration.conversionWindowMs, declaration.deliveryGraceMs);
  const seen = new Set<string>();
  const arms = Object.freeze(
    input.aggregates.map((aggregate: ArmAggregate) => {
      const declared = declaration.arms.find((arm) => arm.id === aggregate.arm);
      ensure(declared && !seen.has(aggregate.arm));
      seen.add(aggregate.arm);
      const exposed = integer(aggregate.exposed),
        mature = integer(aggregate.mature, 0, exposed);
      ensure(aggregate.guardrails.length === declaration.guardrails.length);
      return Object.freeze({
        id: aggregate.arm,
        weight: declared.weight,
        exposed,
        mature,
        immature: exposed - mature,
        primary: integer(aggregate.primary, 0, mature),
        guardrails: Object.freeze(aggregate.guardrails.map((value) => integer(value, 0, mature))),
      });
    }),
  );
  const statistics: ExperimentStatisticsInput = Object.freeze({
    epochId: epoch.key,
    evidenceRevision,
    control: declaration.control,
    startsAtMs: declaration.startsAtMs,
    endsAtMs: declaration.endsAtMs,
    conversionWindowMs: declaration.conversionWindowMs,
    deliveryGraceMs: declaration.deliveryGraceMs,
    nowMs: capturedAtMs,
    guardrails: declaration.guardrails,
    completeness: Object.freeze({
      pending: integer(delivery.pending + diagnostics.pendingConversions),
      failed: delivery.failed,
      incomplete: integer(delivery.incomplete + (delivery.throughMs < Math.min(capturedAtMs, finalizesAtMs) ? 1 : 0)),
    }),
    arms,
  });
  // Validate every aggregate before persisting its immutable evidence revision.
  const evidence = computeExperimentStatistics(statistics);
  return Object.freeze({
    epoch,
    declaration,
    dataRevision,
    evidenceRevision,
    capturedAtMs,
    delivery,
    diagnostics,
    input: statistics,
    statisticsVersion: 'an2-binary-v1',
    statistics: evidence,
  });
}
export function experimentResultStatistics(result: ExperimentResult): ExperimentResult['statistics'] {
  ensure(result.statisticsVersion === 'an2-binary-v1');
  return result.statistics;
}
