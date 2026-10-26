/** Trusted host integration. Registration precedes control activation; request
 * capture never provisions/registers. Only explicit recordUse creates exposure.
 */
import { captureFlagDeclaration, normalizeExperimentDeclarations } from '../../shared/appExperiments.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import {
  flagValuesEqual,
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagSnapshot,
  type FlagContext,
  type FlagEvaluation,
  type FlagOverride,
  type FlagOverrideSnapshot,
} from '../../shared/appFlags.js';
import type { AppFlagCatalog } from '../flags/appCatalog.js';
import { createFlagEvaluator } from '../flags/evaluation.js';
import {
  ExperimentConflict,
  ExperimentExposurePending,
  ensure,
  identifier,
  identifyEpoch,
  normalizeEpoch,
  opaqueIdentifier,
  record,
  time,
  type CommitGuard,
  type ExperimentEpoch,
  type ExperimentStore,
  type RegisteredEpoch,
} from './contracts.js';
import { registeredConversion, type ExperimentConversionRegistry } from './conversionRegistry.js';
import { epochAdmits } from './eligibility.js';

interface ExperimentScopeSelection {
  readonly controlTenantId: string | null;
  readonly evaluationTenantId: string | null;
}
export interface ExperimentRequestObservation {
  readonly appId: string;
  readonly environment: string;
  readonly evaluationTenantId: string | null;
  readonly realm: 'app' | 'tenant' | 'platform';
  readonly context: FlagContext;
  /** Native owner obtains this pair through the flag store's atomic scope read. */
  readonly snapshots: { readonly global: FlagOverrideSnapshot; readonly tenant: FlagOverrideSnapshot | null };
  readonly reobserve: CommitGuard;
}
export function createExperimentRuntime(options: {
  readonly appId: string;
  readonly environment: string;
  readonly graph: AppFlagCatalog;
  readonly conversions: ExperimentConversionRegistry;
  readonly store: ExperimentStore;
  readonly clock?: () => number;
}) {
  const appId = identifier(options.appId),
    environment = identifier(options.environment),
    { store, conversions } = options;
  const catalog = normalizeFlagCatalog(options.graph.catalog),
    experiments = normalizeExperimentDeclarations(options.graph.experiments, catalog);
  const tenantApp = options.graph.tenantApp,
    roleRealms = new Map(Object.entries(options.graph.roles).map(([id, role]) => [id, role.realm]));
  const clock = options.clock ?? Date.now;
  ensure(typeof clock === 'function');
  const selection = (flagId: string, input: ExperimentScopeSelection) => {
    const raw = record(input, ['controlTenantId', 'evaluationTenantId']);
    const controlTenantId = raw.controlTenantId === null ? null : identifier(raw.controlTenantId);
    const evaluationTenantId = raw.evaluationTenantId === null ? null : identifier(raw.evaluationTenantId);
    ensure(tenantApp || (controlTenantId === null && evaluationTenantId === null));
    ensure(controlTenantId === null || (catalog.flags[flagId]?.tenantManaged && controlTenantId === evaluationTenantId));
    return Object.freeze({ controlTenantId, evaluationTenantId });
  };
  const declaration = (flagId: string, input: ExperimentScopeSelection): ExperimentEpoch => {
    identifier(flagId);
    ensure(Object.hasOwn(experiments, flagId), 'Undeclared experiment.');
    const epoch = experiments[flagId],
      scope = selection(flagId, input),
      flag = catalog.flags[flagId];
    const metric = (id: string) => {
      const conversion = registeredConversion(conversions, id);
      ensure(epoch.unit === conversion.unit.kind, 'Conversion unit kind differs from epoch.');
      return {
        id,
        event: conversion.on.name,
        eventVersion: conversion.on.version,
        unitField: conversion.unit.kind === 'subject' ? 'actorId' : 'visitorId',
      };
    };
    const arms = flag.variants!.map((value, index) => ({
      id: `variant-${index}`,
      value,
      weight: epoch.allocation.find((arm) => flagValuesEqual(arm.value, value))!.weight,
    }));
    return normalizeEpoch({
      scope: { appId, environment, ...scope },
      flagId,
      version: epoch.version,
      owner: flag.owner,
      unit: epoch.unit,
      control: arms.find((arm) => flagValuesEqual(arm.value, epoch.control))!.id,
      arms,
      eligibility: {
        rollout: epoch.eligibility.rollout ?? 100,
        audiences: Object.fromEntries((epoch.eligibility.audiences ?? []).map((name) => [name, catalog.audiences[name]])),
      },
      startsAtMs: Date.parse(epoch.startsAt),
      endsAtMs: Date.parse(epoch.endsAt),
      conversionWindowMs: parseDuration(epoch.conversionWindow)!,
      deliveryGraceMs: parseDuration(epoch.deliveryGrace)!,
      primary: metric(epoch.primary.conversion),
      guardrails: (epoch.guardrails ?? []).map((g) => ({ ...metric(g.conversion), maxIncrease: g.maxIncrease })),
    });
  };
  // Validate every metric and exact millisecond boundary at startup, without I/O.
  for (const flagId of Object.keys(experiments)) declaration(flagId, { controlTenantId: null, evaluationTenantId: null });
  const validateOverride = (flagId: string, input: FlagOverride, scope: ExperimentScopeSelection): FlagOverride => {
    const epoch = declaration(flagId, scope);
    const normalized = normalizeFlagSnapshot(
      { appId, environment, tenantId: scope.controlTenantId, revision: 0, overrides: { [flagId]: input } },
      catalog,
    ).overrides[flagId];
    ensure(
      normalized.experiment && normalized.experiment.version === epoch.version,
      'Activation must reference the declared epoch version.',
    );
    ensure(normalized.value === undefined && !normalized.rules?.length, 'Active experiments cannot force variant values.');
    ensure((normalized.rollout ?? 100) === epoch.eligibility.rollout, 'Runtime rollout differs from frozen eligibility.');
    ensure(
      epoch.arms.every((arm) =>
        normalized.experiment!.weights.some((weight) => flagValuesEqual(weight.value, arm.value as never) && weight.weight === arm.weight),
      ),
      'Runtime allocation differs from declared epoch.',
    );
    return normalized;
  };
  return Object.freeze({
    declaration,
    async registerForActivation(flagId: string, scope: ExperimentScopeSelection, input: FlagOverride, beforeCommit: CommitGuard) {
      const epoch = declaration(flagId, scope),
        override = validateOverride(flagId, input, scope);
      ensure(typeof beforeCommit === 'function');
      const registered = await store.registerEpoch(epoch, beforeCommit);
      const expected = identifyEpoch(store.binding, epoch);
      ensure(registered.key === expected.key && registered.fingerprint === expected.fingerprint);
      return Object.freeze({ epoch: registered, override });
    },
    /** The caller is the existing management owner. Its activation callback must
     * perform its own current capabilities/CAS/audit; registration grants none. */
    async activate<T>(
      input: { readonly flagId: string; readonly scope: ExperimentScopeSelection; readonly override: FlagOverride },
      owner: {
        readonly reobserve: CommitGuard;
        readonly commitControl: (registered: RegisteredEpoch, override: FlagOverride) => Promise<T>;
      },
    ): Promise<T> {
      ensure(typeof owner.reobserve === 'function' && typeof owner.commitControl === 'function');
      const reobserve = owner.reobserve,
        commit = owner.commitControl;
      const epoch = declaration(input.flagId, input.scope),
        override = validateOverride(input.flagId, input.override, input.scope);
      const registered = await store.registerEpoch(epoch, reobserve);
      const expected = identifyEpoch(store.binding, epoch);
      ensure(registered.key === expected.key && registered.fingerprint === expected.fingerprint);
      await reobserve();
      return commit(registered, override);
    },
    /** A global activation is registered before control commit. Its per-tenant
     * observations get separate canonical epochs under current native authority;
     * this cannot manufacture activation or combine tenant evidence. */
    async ensureEvaluationEpoch(flagId: string, scope: ExperimentScopeSelection, beforeCommit: CommitGuard) {
      const epoch = declaration(flagId, scope),
        reference = identifyEpoch(store.binding, epoch);
      await beforeCommit();
      try {
        return await store.readEpoch(reference);
      } catch (error) {
        if (!(error instanceof ExperimentConflict) || scope.controlTenantId !== null || scope.evaluationTenantId === null) throw error;
        const global = declaration(flagId, { controlTenantId: null, evaluationTenantId: null });
        const activation = await store.readEpoch(identifyEpoch(store.binding, global));
        ensure(activation.fingerprint === identifyEpoch(store.binding, global).fingerprint);
        await beforeCommit();
        return store.registerEpoch(epoch, beforeCommit);
      }
    },
    async captureRequest(observe: () => ExperimentRequestObservation | Promise<ExperimentRequestObservation>) {
      ensure(typeof observe === 'function');
      const observation = await observe();
      const raw = record(observation, ['appId', 'environment', 'evaluationTenantId', 'realm', 'context', 'snapshots', 'reobserve']);
      ensure(raw.appId === appId && raw.environment === environment && typeof raw.reobserve === 'function');
      const tenantId = raw.evaluationTenantId === null ? null : identifier(raw.evaluationTenantId);
      ensure(tenantApp ? raw.realm === (tenantId === null ? 'platform' : 'tenant') : raw.realm === 'app' && tenantId === null);
      const incoming = normalizeFlagContext(raw.context, catalog);
      ensure(incoming.tenantId === undefined || incoming.tenantId === tenantId);
      for (const role of incoming.roles ?? [])
        ensure(roleRealms.has(role) && (!tenantApp || roleRealms.get(role) === raw.realm), 'Role comes from another realm.');
      if (incoming.identity) opaqueIdentifier(incoming.identity.id);
      const context = normalizeFlagContext({ ...incoming, ...(tenantId === null ? {} : { tenantId }) }, catalog);
      const pair = record(captureFlagDeclaration(raw.snapshots), ['global', 'tenant']);
      const global = normalizeFlagSnapshot(pair.global, catalog),
        tenant = pair.tenant === null ? null : normalizeFlagSnapshot(pair.tenant, catalog);
      ensure(global.appId === appId && global.environment === environment && global.tenantId === null);
      ensure(
        tenantId === null ? tenant === null : tenant?.appId === appId && tenant.environment === environment && tenant.tenantId === tenantId,
      );
      for (const snapshot of [global, tenant])
        if (snapshot)
          for (const [flagId, override] of Object.entries(snapshot.overrides)) {
            if (override.experiment)
              validateOverride(flagId, override, { controlTenantId: snapshot.tenantId, evaluationTenantId: tenantId });
          }
      const reobserve = raw.reobserve as CommitGuard,
        admittedAtMs = time(clock());
      const globalEvaluator = createFlagEvaluator({ catalog, scope: { appId, environment, tenantId: null }, context, snapshot: global });
      const tenantEvaluator =
        tenant && createFlagEvaluator({ catalog, scope: { appId, environment, tenantId }, context, snapshot: tenant });
      const decisions = new Map<
        string,
        Promise<{
          readonly evaluation: FlagEvaluation;
          readonly epoch: RegisteredEpoch | null;
          readonly recordDelivery: (() => Promise<void>) | null;
          readonly recordUse: (() => ReturnType<ExperimentStore['ingestExposure']>) | null;
        }>
      >();
      return Object.freeze({
        version: Object.freeze({ global: global.revision, tenant: tenant?.revision ?? null }),
        decision(flagId: string) {
          if (decisions.has(flagId)) return decisions.get(flagId)!;
          ensure(Object.hasOwn(catalog.flags, flagId));
          const task = (async () => {
            const eligible = (answer: FlagEvaluation, controlTenantId: string | null): FlagEvaluation => {
              if (answer.reason !== 'experiment') return answer;
              const epoch = declaration(flagId, { controlTenantId, evaluationTenantId: tenantId });
              return admittedAtMs >= epoch.startsAtMs &&
                admittedAtMs < epoch.endsAtMs &&
                epochAdmits(epoch, context, tenantId) &&
                context.identity?.kind === epoch.unit
                ? answer
                : Object.freeze({
                    value: catalog.flags[flagId].default,
                    reason: 'default',
                    revision: answer.revision,
                    diagnostics: Object.freeze([]),
                  });
            };
            let evaluation = eligible(globalEvaluator.evaluate(flagId), null),
              controlTenantId: string | null = null;
            if (evaluation.reason !== 'disabled' && catalog.flags[flagId].tenantManaged && tenantEvaluator) {
              const local = eligible(tenantEvaluator.evaluate(flagId), tenantId);
              if (local.reason !== 'default') {
                evaluation = local;
                controlTenantId = tenantId;
              }
            }
            const passive = (answer = evaluation) =>
              Object.freeze({ evaluation: answer, epoch: null, recordDelivery: null, recordUse: null });
            if (evaluation.reason !== 'experiment') return passive();
            const epoch = declaration(flagId, { controlTenantId, evaluationTenantId: tenantId });
            const registered = await store.readEpoch(identifyEpoch(store.binding, epoch));
            const expected = identifyEpoch(store.binding, epoch);
            ensure(registered.key === expected.key && registered.fingerprint === expected.fingerprint);
            const arm = epoch.arms.find((arm) => flagValuesEqual(arm.value as never, evaluation.value));
            ensure(arm && context.identity);
            const unit = Object.freeze({ kind: context.identity.kind, id: context.identity.id });
            const recordDelivery = async () => {
              await reobserve();
              await store.enrollExposure(registered, { unit, arm: arm.id }, reobserve);
            };
            return Object.freeze({
              evaluation,
              epoch: registered,
              recordDelivery,
              async recordUse() {
                const usedAtMs = time(clock());
                ensure(usedAtMs >= epoch.startsAtMs && usedAtMs < epoch.endsAtMs);
                await recordDelivery();
                try {
                  return await store.ingestExposure(registered, { unit, arm: arm.id, usedAtMs }, reobserve);
                } catch {
                  await reobserve();
                  throw new ExperimentExposurePending();
                }
              },
            });
          })();
          decisions.set(flagId, task);
          return task;
        },
      });
    },
  });
}
