/** One captured server request, one immutable decision snapshot. No evaluator
 * result grants permission; callers still enforce the App's access model. */
import {
  flagValuesEqual,
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagContext,
  type FlagDiagnostic,
  type FlagEvaluation,
  type FlagEvaluationInput,
  type FlagOverrideSnapshot,
  type FlagRequestSnapshot,
  type FlagTarget,
  type FlagValue,
} from '../../shared/appFlags.js';
import { flagAssignmentBucket } from './assignment.js';
import { inAnyAudience } from './audience.js';

export function createFlagEvaluator(input: FlagEvaluationInput): FlagRequestSnapshot {
  const catalog = normalizeFlagCatalog(input.catalog),
    scope = normalizeFlagScope(input.scope);
  const diagnostics: FlagDiagnostic[] = [];
  let context: FlagContext | undefined, snapshot: FlagOverrideSnapshot | undefined;
  try {
    context = normalizeFlagContext(input.context, catalog);
    if (scope.tenantId !== null && context.tenantId !== undefined && context.tenantId !== scope.tenantId) {
      context = undefined;
      diagnostics.push('invalid_context');
    }
  } catch {
    diagnostics.push('invalid_context');
  }
  if (input.failure) {
    if (!diagnostics.includes(input.failure)) diagnostics.push(input.failure);
  } else if (input.snapshot !== null) {
    try {
      const candidate = normalizeFlagSnapshot(input.snapshot, catalog);
      if (candidate.appId !== scope.appId || candidate.environment !== scope.environment || candidate.tenantId !== scope.tenantId)
        diagnostics.push('scope_mismatch');
      else snapshot = candidate;
    } catch {
      diagnostics.push('invalid_snapshot');
    }
  }
  const revision = snapshot?.revision ?? null;
  const evaluationTenant = context?.tenantId ?? scope.tenantId;
  const matches = (rule: FlagTarget): boolean =>
    inAnyAudience(rule.audiences, catalog.audiences, {
      appId: scope.appId,
      environment: scope.environment,
      tenantId: evaluationTenant,
      context: context!,
    });
  return Object.freeze({
    scope,
    revision,
    evaluate(flagId: string): FlagEvaluation {
      if (!Object.hasOwn(catalog.flags, flagId)) throw new Error('Undeclared flag.');
      const declared = catalog.flags[flagId];
      const answer = (value: FlagValue, reason: FlagEvaluation['reason'], extra: Partial<FlagEvaluation> = {}): FlagEvaluation =>
        Object.freeze({ value, reason, revision, diagnostics: Object.freeze([...diagnostics]), ...extra });
      const fallback = (missing = false) =>
        answer(declared.default, 'default', missing ? { diagnostics: Object.freeze([...diagnostics, 'missing_identity']) } : {});
      if (!context || diagnostics.length || !snapshot) return fallback();
      const override = snapshot.overrides[flagId];
      if (!override) return fallback();
      if (override.disabled) return answer(declared.safeValue!, 'disabled');
      for (const rule of override.rules ?? []) if (matches(rule)) return answer(rule.value, 'target');
      const assignment = {
        ...scope,
        tenantId: evaluationTenant,
        flagId,
        experimentVersion: override.experiment?.version ?? null,
        ...(context.identity ? { identity: context.identity } : {}),
      };
      if (override.rollout !== undefined) {
        const bucket = flagAssignmentBucket({ ...assignment, purpose: 'rollout' });
        if (bucket === null) return fallback(true);
        if (bucket >= override.rollout) return fallback();
      }
      if (override.experiment) {
        const bucket = flagAssignmentBucket({ ...assignment, purpose: 'variant' });
        if (bucket === null) return fallback(true);
        // Definition order is canonical; reordering provider weights cannot
        // reshuffle existing subjects.
        let boundary = 0;
        for (const [variant, value] of declared.variants!.entries()) {
          const weight = override.experiment.weights.find((item) => flagValuesEqual(item.value, value))!.weight;
          boundary += weight;
          if (weight > 0 && bucket < boundary)
            return answer(value, 'experiment', { variant, experimentVersion: override.experiment.version });
        }
        return fallback();
      }
      return override.value !== undefined ? answer(override.value, override.rollout === undefined ? 'override' : 'rollout') : fallback();
    },
  });
}
