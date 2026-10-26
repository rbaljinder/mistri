/** Target-bound explicit winner decisions. Result-store correlations commit
 * first and may be orphaned on flag CAS/authority/commit failure. Only a flag
 * audit `decide` row proves application. There is no cross-database atomicity:
 * evidence is checked again at the flag commit fence, but a later correction
 * creates new evidence and never rewrites the recorded control decision. */
import { randomUUID } from 'node:crypto';
import { flagValuesEqual, normalizeFlagCatalog, normalizeFlagScope, type FlagScope, type FlagValue } from '../../shared/appFlags.js';
import { normalizeFlagAuthorityCatalog, requiredFlagCapabilities, type FlagAuthorityCatalog } from '../flags/authority.js';
import type { FlagAuthorizationRequest, FlagManagementAuthority } from '../flags/management.js';
import {
  FlagManagementDenied,
  FlagRevisionConflict,
  flagStoreIdentifier,
  flagStoreRecord,
  normalizeFlagStoreMutation,
  type FlagStore,
} from '../flags/store.js';
import {
  ExperimentConflict,
  ensure,
  identifyEpoch,
  integer,
  type ExperimentBinding,
  type ExperimentEpoch,
  type ExperimentResult,
  type ExperimentStore,
  type RegisteredEpoch,
} from './contracts.js';

export interface ExperimentDecisionRequest {
  readonly tenantId: string | null;
  readonly flagId: string;
  readonly epochFingerprint: string;
  readonly expectedRevision: number;
  readonly expectedResultRevision: number;
  readonly winnerVariant: FlagValue;
  readonly reason: string;
}

/** Startup-only declaration capture, shared with the deployment owner. Each
 * fingerprint uses the independently configured results-store binding. */
export function captureExperimentDecisionEpochs(options: {
  readonly appId: string;
  readonly environment: string;
  readonly catalog: FlagAuthorityCatalog;
  readonly epochs: readonly ExperimentEpoch[];
  readonly binding: ExperimentBinding;
}): readonly RegisteredEpoch[] {
  const fixed = normalizeFlagScope({ appId: options.appId, environment: options.environment, tenantId: null });
  const catalog = normalizeFlagAuthorityCatalog(options.catalog);
  ensure(Array.isArray(options.epochs));
  const epochs = options.epochs.map((input) => {
    const registered = identifyEpoch(options.binding, input),
      epoch = registered.declaration;
    const declared = catalog.experiments?.[epoch.flagId];
    ensure(
      epoch.scope.appId === fixed.appId &&
        epoch.scope.environment === fixed.environment &&
        catalog.flags[epoch.flagId]?.owner === epoch.owner &&
        declared?.version === epoch.version &&
        declared.weights.length === epoch.arms.length &&
        epoch.arms.every((arm) =>
          declared.weights.some((weight) => weight.weight === arm.weight && flagValuesEqual(weight.value, arm.value as FlagValue)),
        ),
      'Epoch differs from the code-declared flag allocation.',
    );
    return registered;
  });
  ensure(new Set(epochs.map((epoch) => epoch.key)).size === epochs.length);
  return Object.freeze(epochs);
}

export function createExperimentDecisionManager(options: {
  readonly appId: string;
  readonly environment: string;
  readonly catalog: FlagAuthorityCatalog;
  /** Fully projected code declarations, including exact control/evaluation
   * scope and committed-event metric contracts. Never supplied by a request. */
  readonly epochs: readonly ExperimentEpoch[];
  readonly resolveEpoch?: (tenantId: string | null, flagId: string) => ExperimentEpoch;
  readonly flags: FlagStore;
  readonly experiments: ExperimentStore;
  readonly authorize: FlagManagementAuthority;
}) {
  const fixed = normalizeFlagScope({ appId: options.appId, environment: options.environment, tenantId: null });
  const declarations = normalizeFlagAuthorityCatalog(options.catalog);
  const catalog = normalizeFlagCatalog({ flags: declarations.flags, roles: declarations.roles, audiences: declarations.audiences });
  const { flags, experiments, authorize } = options;
  // The databases have independent deployment identities; only suite ownership
  // must agree. The full results binding remains part of every epoch identity.
  ensure(flags.binding.suiteId === experiments.binding.suiteId);
  ensure(typeof authorize === 'function' && Array.isArray(options.epochs));
  const epochs = captureExperimentDecisionEpochs({ ...fixed, catalog: declarations, epochs: options.epochs, binding: experiments.binding });
  const select = (scope: FlagScope, flagId: string, fingerprint: unknown, deciding = false) => {
    const candidates = options.resolveEpoch
      ? captureExperimentDecisionEpochs({
          ...fixed,
          catalog: declarations,
          epochs: [options.resolveEpoch(scope.tenantId, flagId)],
          binding: experiments.binding,
        })
      : epochs;
    const epoch = candidates.find(
      (value) =>
        value.fingerprint === fingerprint &&
        value.declaration.flagId === flagId &&
        (value.declaration.scope.controlTenantId === scope.tenantId || (!deciding && value.declaration.scope.controlTenantId === null)) &&
        value.declaration.scope.evaluationTenantId === scope.tenantId,
    );
    // Global decisions require a separately declared global/null aggregate.
    // A global-control/per-tenant evaluation epoch cannot decide global state.
    if (!epoch) throw new FlagManagementDenied();
    return epoch;
  };
  const admit = async (scope: FlagScope, flagId: string, operation: FlagAuthorizationRequest['operation']) => {
    const definition = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
    if (!definition || (scope.tenantId !== null && !definition.tenantManaged)) throw new FlagManagementDenied();
    const proof = await authorize(
      Object.freeze({
        scope,
        flagId,
        operation,
        owner: definition.owner,
        requiredCapabilities: requiredFlagCapabilities(declarations, flagId, operation),
      }),
    );
    if (!proof || typeof proof.reobserve !== 'function') throw new FlagManagementDenied();
    const actorId = flagStoreIdentifier(proof.actorId),
      observe = proof.reobserve;
    const reobserve = () => observe.call(proof);
    await reobserve(); // Before any pending storage read, including evidence.
    return { actorId, reobserve };
  };
  const readEvidence = async (epoch: RegisteredEpoch): Promise<ExperimentResult> => {
    const registered = await experiments.readEpoch(epoch);
    const actual = identifyEpoch(experiments.binding, registered.declaration);
    if (
      registered.key !== epoch.key ||
      registered.fingerprint !== epoch.fingerprint ||
      actual.key !== epoch.key ||
      actual.fingerprint !== epoch.fingerprint
    )
      throw new ExperimentConflict();
    const result = await experiments.readResults(epoch);
    const declaration = identifyEpoch(experiments.binding, result.declaration);
    if (
      result.epoch.key !== epoch.key ||
      result.epoch.fingerprint !== epoch.fingerprint ||
      declaration.fingerprint !== epoch.fingerprint ||
      declaration.key !== epoch.key
    )
      throw new ExperimentConflict();
    return result;
  };
  const finalEvidence = (result: ExperimentResult, expected: number) => {
    if (result.evidenceRevision !== expected) throw new ExperimentConflict();
    const stats = result.statistics;
    ensure(
      result.statisticsVersion === 'an2-binary-v1' &&
        stats.epochId === result.epoch.key &&
        stats.evidenceRevision === expected &&
        stats.status === 'final-evidence' &&
        stats.finalized &&
        stats.complete &&
        stats.srm.status === 'clear' &&
        stats.blockers.length === 0 &&
        stats.immature === 0 &&
        stats.comparisons.every((comparison) => comparison.guardrail === null || comparison.guardrail === 'safe'),
      'Decision requires complete final evidence, clear SRM and satisfied guardrails.',
    );
  };
  return Object.freeze({
    /** Experiment view is separate from both flag view and decide. */
    async results(input: { readonly tenantId: string | null; readonly flagId: string; readonly epochFingerprint: string }) {
      const raw = flagStoreRecord(input, ['tenantId', 'flagId', 'epochFingerprint']);
      const scope = normalizeFlagScope({ ...fixed, tenantId: raw.tenantId }),
        flagId = flagStoreIdentifier(raw.flagId);
      const proof = await admit(scope, flagId, 'experiment-view'),
        epoch = select(scope, flagId, raw.epochFingerprint);
      const result = await readEvidence(epoch);
      await proof.reobserve();
      return result;
    },
    async decide(
      input: ExperimentDecisionRequest,
      beforeCommit?: () => void | Promise<void>,
    ): Promise<{ readonly flagId: string; readonly revision: number; readonly operation: 'decide' }> {
      if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw new FlagManagementDenied();
      const raw = flagStoreRecord(input, [
        'tenantId',
        'flagId',
        'epochFingerprint',
        'expectedRevision',
        'expectedResultRevision',
        'winnerVariant',
        'reason',
      ]);
      const scope = normalizeFlagScope({ ...fixed, tenantId: raw.tenantId }),
        flagId = flagStoreIdentifier(raw.flagId);
      const proof = await admit(scope, flagId, 'decide'),
        epoch = select(scope, flagId, raw.epochFingerprint, true);
      // Enclosing Console authority is a trusted callable, never body data.
      // Run it before evidence reads and again inside the flag transaction.
      const reobserve = async () => {
        await beforeCommit?.();
        await proof.reobserve();
      };
      await reobserve();
      const expectedResultRevision = integer(raw.expectedResultRevision, 1);
      const change = normalizeFlagStoreMutation({
        scope,
        catalog,
        flagId,
        actorId: proof.actorId,
        reason: raw.reason,
        expectedRevision: raw.expectedRevision,
        operation: 'decide',
        evidence: { epochFingerprint: epoch.fingerprint, resultsRevision: expectedResultRevision, winnerVariant: raw.winnerVariant },
      });
      ensure(change.operation === 'decide');
      const winner = epoch.declaration.arms.find(
        (arm) => arm.weight > 0 && flagValuesEqual(arm.value as FlagValue, change.evidence.winnerVariant),
      );
      ensure(winner, 'Winner is not a positively allocated declared variant.');
      const current = await flags.read(scope, catalog);
      if (current.revision !== change.expectedRevision) throw new FlagRevisionConflict();
      const override = current.overrides[flagId],
        allocation = override?.experiment;
      if (allocation) {
        ensure(
          allocation.version === epoch.declaration.version &&
            allocation.weights.length === epoch.declaration.arms.length &&
            epoch.declaration.arms.every((arm) =>
              allocation.weights.some((weight) => weight.weight === arm.weight && flagValuesEqual(weight.value, arm.value as FlagValue)),
            ) &&
            !override.rules?.length &&
            (override.rollout ?? 100) === epoch.declaration.eligibility.rollout,
          'Current control does not match the declared epoch.',
        );
      } else {
        // A correction can replace a prior decision, never an unrelated fixed
        // value. Latest per-flag history must still prove the same epoch/value.
        const previous = (await flags.history(scope, catalog, { flagId, limit: 1 })).entries[0];
        ensure(
          previous?.operation === 'decide' &&
            previous.evidence?.epochFingerprint === epoch.fingerprint &&
            previous.evidence.resultsRevision < expectedResultRevision &&
            override &&
            Object.keys(override).length === 1 &&
            Object.hasOwn(override, 'value') &&
            flagValuesEqual(override.value!, previous.evidence.winnerVariant),
          'Current control is neither this epoch allocation nor its previous decision.',
        );
      }
      const result = await readEvidence(epoch);
      finalEvidence(result, expectedResultRevision);
      const freshEvidence = async () => {
        const latest = await readEvidence(epoch);
        finalEvidence(latest, expectedResultRevision);
        if (latest.dataRevision !== result.dataRevision || (await experiments.readDataRevision(epoch)) !== result.dataRevision)
          throw new ExperimentConflict();
        await reobserve();
      };
      await freshEvidence();
      await experiments.appendDecisionEvidence(
        epoch,
        {
          decisionId: randomUUID(),
          evidenceRevision: expectedResultRevision,
          expectedDataRevision: result.dataRevision,
          arm: winner.id,
          actorId: proof.actorId,
          reason: change.reason,
          controlRevision: change.expectedRevision + 1,
        },
        reobserve,
      );
      await reobserve();
      // Whole-scope CAS is attempted once. An uncertain commit is surfaced;
      // callers must read current controls/history rather than silently retry.
      const entry = await flags.mutate(change, freshEvidence);
      return Object.freeze({ flagId, revision: entry.revision, operation: 'decide' });
    },
  });
}
