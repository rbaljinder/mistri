/** Actual-use adapter. The trusted verifier must validate the server assignment
 * receipt, current session/visitor proof, exact epoch and real consumption.
 * A flag evaluation alone must never invoke this port. No identity is minted.
 */
import {
  addTime,
  ensure,
  identifier,
  normalizeReference,
  record,
  time,
  unitKey,
  type CommitGuard,
  type EpochReference,
  type ExperimentEpoch,
  type ExperimentStore,
  type ExposureFact,
  type IngestionReceipt,
} from './contracts.js';

export function prepareExposure(reference: EpochReference, epoch: ExperimentEpoch, input: ExposureFact, receivedAtMs: number) {
  const raw = record(input, ['unit', 'arm', 'usedAtMs']);
  const unit = unitKey(reference, raw.unit as ExposureFact['unit'], epoch.unit),
    arm = identifier(raw.arm),
    usedAtMs = time(raw.usedAtMs);
  time(receivedAtMs);
  ensure(usedAtMs >= epoch.startsAtMs && usedAtMs < epoch.endsAtMs && usedAtMs <= receivedAtMs, 'Exposure outside enrollment horizon.');
  ensure(
    epoch.arms.some((value) => value.id === arm && value.weight > 0),
    'Exposure assignment is not in this epoch.',
  );
  return Object.freeze({
    unitKey: unit,
    arm,
    usedAtMs,
    receivedAtMs,
    late: receivedAtMs > addTime(epoch.endsAtMs, epoch.conversionWindowMs, epoch.deliveryGraceMs),
  });
}

export function createExperimentExposureRecorder(options: {
  readonly store: ExperimentStore;
  readonly epoch: EpochReference;
  readonly verifyUse: (receipt: unknown) => Promise<{ readonly fact: ExposureFact; readonly reobserve: CommitGuard }>;
}) {
  const epoch = normalizeReference(options.epoch),
    { store, verifyUse } = options;
  ensure(typeof verifyUse === 'function');
  return Object.freeze({
    async recordUse(receipt: unknown): Promise<IngestionReceipt> {
      const verified = await verifyUse(receipt);
      ensure(verified && typeof verified.reobserve === 'function', 'Verified actual use is required.');
      return store.ingestExposure(epoch, verified.fact, verified.reobserve);
    },
  });
}
