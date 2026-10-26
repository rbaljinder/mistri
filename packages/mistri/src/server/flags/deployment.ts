/** One explicit suite-owned control-store lifetime. No provisioning, implicit
 * store discovery, raw transaction port or caller-selected deployment. */
import type { IncomingMessage } from 'node:http';
import {
  flagValuesEqual,
  normalizeFlagCatalog,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagOverride,
  type FlagOverrideSnapshot,
  type FlagScope,
} from '../../shared/appFlags.js';
import { captureAppAuthRuntime } from '../auth/auth.js';
import { tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { captureExperimentDecisionEpochs, createExperimentDecisionManager } from '../experiments/decisions.js';
import {
  ExperimentStoreUnavailable,
  ensure,
  normalizeBinding,
  type ExperimentEpoch,
  type ExperimentStore,
} from '../experiments/contracts.js';
import {
  createFlagAuthority,
  normalizeFlagAuthorityCatalog,
  normalizeFlagRoleCapabilities,
  requiredFlagCapabilities,
  type FlagAuthorityOptions,
} from './authority.js';
import {
  createFlagManagement,
  type FlagAuthorizationRequest,
  type FlagManagementAuthority,
  type FlagManagementChange,
} from './management.js';
import {
  FlagManagementDenied,
  FlagStoreUnavailable,
  flagStoreIdentifier,
  flagStoreRecord,
  normalizeFlagStoreBinding,
  type FlagStore,
} from './store.js';
import { openPostgresFlagStore } from './storePostgres.js';

export interface FlagDeploymentOptions {
  readonly suiteId: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly storeUrl: string;
  readonly targets: readonly FlagDeploymentTargetOptions[];
}
export interface FlagDeploymentTargetOptions extends Omit<FlagAuthorityOptions, 'environment'> {
  /** Trusted startup inputs only. The results store is borrowed: its owner must
   * drain/close this deployment before closing that independently owned store. */
  readonly experimentEvidence?: {
    readonly epochs: readonly ExperimentEpoch[];
    readonly store: ExperimentStore;
    readonly resolveEpoch?: (tenantId: string | null, flagId: string) => ExperimentEpoch;
  };
}
export class FlagDeploymentRetired extends Error {}
export class FlagSignInRequired extends Error {}
export class FlagAccountChanged extends Error {}
export class FlagInputInvalid extends Error {}
/** Private evaluation port for already-admitted request/job owners. Reading
 * controls is not access authorization; this object never goes in an App DTO. */
export interface FlagRequestReadPort {
  readonly appId: string;
  readonly environment: string;
  readonly catalog: FlagCatalog;
  readonly experiments?: import('../experiments/requestPort.js').ExperimentRequestPort;
  readRequestScopes(scope: FlagScope): Promise<{ readonly global: FlagOverrideSnapshot; readonly tenant: FlagOverrideSnapshot | null }>;
}

function captureOptions(input: FlagDeploymentOptions) {
  const raw = tenantOptions(input, ['suiteId', 'deploymentId', 'environment', 'storeUrl', 'targets']);
  const binding = normalizeFlagStoreBinding({ suiteId: raw.suiteId, deploymentId: raw.deploymentId });
  const environment = flagStoreIdentifier(raw.environment);
  if (typeof raw.storeUrl !== 'string' || raw.storeUrl !== raw.storeUrl.trim() || raw.storeUrl.includes('${'))
    throw new FlagStoreUnavailable();
  let url: URL;
  try {
    url = new URL(raw.storeUrl);
  } catch {
    throw new FlagStoreUnavailable();
  }
  // The connection owner receives an explicit host/database/user, never a
  // discovered store or an unresolved environment reference.
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2 ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length > 1
  )
    throw new FlagStoreUnavailable();
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 256) throw new FlagStoreUnavailable();
  const targets = raw.targets.map((input) => {
    const target = tenantOptions(input, [
      'appId',
      'catalog',
      'roles',
      'tenantApp',
      'auth',
      'assertCurrent',
      'observeMembership',
      'experimentEvidence',
    ]);
    const appId = flagStoreIdentifier(target.appId),
      catalog = normalizeFlagAuthorityCatalog(target.catalog);
    if (typeof target.tenantApp !== 'boolean' || typeof target.assertCurrent !== 'function') throw new FlagManagementDenied();
    const roles = normalizeFlagRoleCapabilities(target.roles, catalog, target.tenantApp);
    let experimentEvidence: FlagDeploymentTargetOptions['experimentEvidence'];
    if (Object.hasOwn(target, 'experimentEvidence')) {
      const evidence = tenantOptions(target.experimentEvidence, ['epochs', 'store', 'resolveEpoch']);
      const store = evidence.store as ExperimentStore;
      if (
        !store ||
        normalizeBinding(store.binding).suiteId !== binding.suiteId ||
        ['readEpoch', 'readResults', 'readDataRevision', 'appendDecisionEvidence'].some(
          (method) => typeof store[method as keyof ExperimentStore] !== 'function',
        )
      )
        throw new ExperimentStoreUnavailable();
      const epochs = captureExperimentDecisionEpochs({
        appId,
        environment,
        catalog,
        epochs: evidence.epochs as readonly ExperimentEpoch[],
        binding: store.binding,
      });
      if (evidence.resolveEpoch !== undefined && typeof evidence.resolveEpoch !== 'function') throw new ExperimentStoreUnavailable();
      experimentEvidence = Object.freeze({
        store,
        epochs: Object.freeze(epochs.map((epoch) => epoch.declaration)),
        ...(evidence.resolveEpoch
          ? { resolveEpoch: evidence.resolveEpoch as NonNullable<FlagDeploymentTargetOptions['experimentEvidence']>['resolveEpoch'] }
          : {}),
      });
    }
    return { ...target, appId, catalog, roles, environment, experimentEvidence } as unknown as FlagAuthorityOptions &
      Pick<FlagDeploymentTargetOptions, 'experimentEvidence'>;
  });
  if (new Set(targets.map((target) => target.appId)).size !== targets.length) throw new FlagStoreUnavailable();
  return { binding, environment, url: raw.storeUrl, targets };
}

/** No targeting roles/tenant selectors/segment rules or experiment allocation
 * definitions leave this adapter. A future editor needs its own checked DTO. */
function control(override: FlagOverride | null | undefined) {
  if (!override) return null;
  return Object.freeze({
    ...(Object.hasOwn(override, 'value') ? { value: override.value } : {}),
    ...(override.disabled === undefined ? {} : { disabled: override.disabled }),
    ...(override.rollout === undefined ? {} : { rollout: override.rollout }),
    targetingRuleCount: override.rules?.length ?? 0,
    experimentAllocated: override.experiment !== undefined,
  });
}
function pagination(input: unknown, fields: readonly string[]) {
  let raw: Record<string, unknown>;
  try {
    raw = flagStoreRecord(input, fields);
  } catch {
    throw new FlagInputInvalid();
  }
  const limit = raw.limit ?? 25;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new FlagInputInvalid();
  return { raw, limit: limit as number };
}

async function build(options: ReturnType<typeof captureOptions>, acquire: () => Promise<FlagStore>) {
  let retired = false,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const active = () => {
    if (retired) throw new FlagDeploymentRetired();
  };
  // Validate all targets, native provenance and capabilities before opening DB.
  const prepared = await Promise.all(
    options.targets.map(async (target) => {
      const current = target.assertCurrent;
      const { experimentEvidence: _evidence, ...authorityOptions } = target;
      const authority = await createFlagAuthority({
        ...authorityOptions,
        assertCurrent() {
          active();
          current();
        },
      });
      return { target, authority, auth: captureAppAuthRuntime(target.auth) };
    }),
  );
  const store = await acquire();
  try {
    const binding = normalizeFlagStoreBinding(store.binding);
    if (
      binding.suiteId !== options.binding.suiteId ||
      binding.deploymentId !== options.binding.deploymentId ||
      typeof store.read !== 'function' ||
      typeof store.history !== 'function' ||
      typeof store.mutate !== 'function' ||
      typeof store.close !== 'function'
    )
      throw new FlagStoreUnavailable();
    for (const { target, auth } of prepared) {
      target.assertCurrent();
      auth.assertCurrent();
    }
  } catch (error) {
    await store.close();
    throw error;
  }
  const targets = new Map(
    prepared.map(({ target, authority, auth }) => {
      const catalog = normalizeFlagCatalog({
        flags: target.catalog.flags,
        roles: target.catalog.roles,
        audiences: target.catalog.audiences,
      });
      const fixed = { appId: target.appId, environment: options.environment };
      const readPort = Object.freeze<FlagRequestReadPort>({
        ...fixed,
        catalog,
        async readRequestScopes(input) {
          active();
          target.assertCurrent();
          const scope = normalizeFlagScope(input);
          if (scope.appId !== fixed.appId || scope.environment !== fixed.environment || (!target.tenantApp && scope.tenantId !== null))
            throw new FlagManagementDenied();
          let finish!: () => void;
          const held = new Promise<void>((resolve) => {
            finish = resolve;
          });
          pending.add(held);
          try {
            if (!store.readRequestScopes) throw new FlagStoreUnavailable();
            const pair = await store.readRequestScopes(scope, catalog);
            active();
            target.assertCurrent();
            const global = normalizeFlagSnapshot(pair.global, catalog),
              tenant = pair.tenant === null ? null : normalizeFlagSnapshot(pair.tenant, catalog);
            if (
              global.appId !== fixed.appId ||
              global.environment !== fixed.environment ||
              global.tenantId !== null ||
              (scope.tenantId === null
                ? tenant !== null
                : !tenant || tenant.appId !== fixed.appId || tenant.environment !== fixed.environment || tenant.tenantId !== scope.tenantId)
            )
              throw new FlagStoreUnavailable();
            return Object.freeze({ global, tenant });
          } finally {
            pending.delete(held);
            finish();
          }
        },
      });
      const handle = Object.freeze({
        appId: target.appId,
        environment: options.environment,
        readPort,
        /** Admission precedes body/auth waits. The callback may not retain the
         * session; every method is fenced to this request's active lifetime. */
        async withRequest<T>(
          incoming: IncomingMessage,
          expectedAccount: string,
          assertCurrent: () => void,
          work: (session: FlagControlSession) => Promise<T>,
        ): Promise<T> {
          active();
          let finish!: () => void,
            live = true;
          const operations = new Set<Promise<unknown>>();
          const held = new Promise<void>((resolve) => {
            finish = resolve;
          });
          pending.add(held);
          const guard = () => {
            active();
            if (!live) throw new FlagManagementDenied();
            target.assertCurrent();
            auth.assertCurrent();
            assertCurrent();
          };
          try {
            guard();
            const proof = await auth.sessionInstance(incoming);
            guard();
            if (!proof) throw new FlagSignInRequired();
            if (expectedAccount !== proof.identity.id) throw new FlagAccountChanged();
            const authorizeTarget = authority.forSession(proof);
            const authorize: FlagManagementAuthority = async (request) => {
              guard();
              const admitted = await authorizeTarget(request);
              guard();
              return {
                actorId: admitted.actorId,
                async reobserve() {
                  guard();
                  await admitted.reobserve();
                  guard();
                },
              };
            };
            const manager = createFlagManagement({ ...fixed, catalog: target.catalog, store, authorize });
            const decisions =
              target.experimentEvidence &&
              createExperimentDecisionManager({
                ...fixed,
                catalog: target.catalog,
                flags: store,
                experiments: target.experimentEvidence.store,
                epochs: target.experimentEvidence.epochs,
                resolveEpoch: target.experimentEvidence.resolveEpoch,
                authorize,
              });
            const scopeOf = (tenantId: string | null) => normalizeFlagScope({ ...fixed, tenantId });
            const admit = async (scope: FlagScope, flagId: string, operation: FlagAuthorizationRequest['operation']) => {
              const definition = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
              if (!definition) throw new FlagManagementDenied();
              const admitted = await authorize({
                scope,
                flagId,
                owner: definition.owner,
                operation,
                requiredCapabilities: requiredFlagCapabilities(target.catalog, flagId, operation),
              });
              if (!admitted) throw new FlagManagementDenied();
              return admitted;
            };
            const read = async (scope: FlagScope) => {
              guard();
              const value = await store.read(scope, catalog);
              guard();
              let snapshot;
              try {
                snapshot = normalizeFlagSnapshot(value, catalog);
              } catch {
                throw new FlagStoreUnavailable();
              }
              if (snapshot.appId !== scope.appId || snapshot.environment !== scope.environment || snapshot.tenantId !== scope.tenantId)
                throw new FlagStoreUnavailable();
              return snapshot;
            };
            const row = (scope: FlagScope, flagId: string, revision: number, override: FlagOverride | undefined) =>
              Object.freeze({
                ...scope,
                flagId,
                revision,
                definition: catalog.flags[flagId],
                control: control(override),
              });
            const methods: FlagControlSession = {
              async current() {
                guard();
                try {
                  await auth.observeSession(proof);
                  auth.assertSessionCurrent(proof);
                } catch {
                  throw new FlagManagementDenied();
                }
                guard();
              },
              async list(input) {
                const { raw, limit } = pagination(input, ['tenantId', 'limit', 'after']);
                const scope = scopeOf(raw.tenantId as string | null);
                const after = raw.after === undefined ? undefined : flagStoreIdentifier(raw.after);
                const selected: { id: string; proof: Awaited<ReturnType<typeof admit>> }[] = [];
                for (const id of Object.keys(catalog.flags).sort()) {
                  if (after !== undefined && id <= after) continue;
                  try {
                    selected.push({ id, proof: await admit(scope, id, 'view') });
                  } catch (error) {
                    if (!(error instanceof FlagManagementDenied)) throw error;
                    guard();
                  }
                  if (selected.length > limit) break;
                }
                if (!selected.length) {
                  await session.current();
                  return Object.freeze({ items: Object.freeze([]), nextAfter: null });
                }
                const snapshot = await read(scope),
                  page = selected.slice(0, limit);
                for (const item of selected) await item.proof.reobserve();
                guard();
                return Object.freeze({
                  items: Object.freeze(page.map((item) => row(scope, item.id, snapshot.revision, snapshot.overrides[item.id]))),
                  nextAfter: selected.length > limit ? page.at(-1)!.id : null,
                });
              },
              async get(input) {
                const raw = flagStoreRecord(input, ['tenantId', 'flagId']),
                  scope = scopeOf(raw.tenantId as string | null);
                const flagId = flagStoreIdentifier(raw.flagId),
                  admitted = await admit(scope, flagId, 'view');
                const snapshot = await read(scope);
                await admitted.reobserve();
                guard();
                return row(scope, flagId, snapshot.revision, snapshot.overrides[flagId]);
              },
              async editor(input) {
                const raw = flagStoreRecord(input, ['tenantId', 'flagId']),
                  scope = scopeOf(raw.tenantId as string | null);
                const flagId = flagStoreIdentifier(raw.flagId),
                  admitted = await admit(scope, flagId, 'view');
                const snapshot = await read(scope),
                  override = snapshot.overrides[flagId];
                await admitted.reobserve();
                guard();
                // Targeting is flag data. Experiment allocation remains behind its
                // independent capability and cannot leak through this editor.
                return Object.freeze({
                  ...row(scope, flagId, snapshot.revision, override),
                  control: override ? Object.freeze({ ...control(override)!, ...(override.rules ? { rules: override.rules } : {}) }) : null,
                  audiences: catalog.audiences,
                });
              },
              async capabilities(input) {
                const raw = flagStoreRecord(input, ['tenantId', 'flagId']),
                  scope = scopeOf(raw.tenantId as string | null);
                const flagId = flagStoreIdentifier(raw.flagId),
                  allowed: { action: 'view' | 'manage' | 'kill'; proof: Awaited<ReturnType<typeof admit>> }[] = [];
                for (const [action, operation] of [
                  ['view', 'view'],
                  ['manage', 'set'],
                  ['kill', 'kill'],
                ] as const) {
                  if (action === 'kill' && catalog.flags[flagId]?.safeValue === undefined) continue;
                  try {
                    allowed.push({ action, proof: await admit(scope, flagId, operation) });
                  } catch (error) {
                    if (!(error instanceof FlagManagementDenied)) throw error;
                    guard();
                  }
                }
                if (!allowed.length) throw new FlagManagementDenied();
                const snapshot = await read(scope);
                for (const item of allowed) await item.proof.reobserve();
                guard();
                return Object.freeze({
                  ...scope,
                  flagId,
                  revision: snapshot.revision,
                  actions: Object.freeze(allowed.map((item) => item.action)),
                });
              },
              async history(input) {
                const raw = flagStoreRecord(input, ['tenantId', 'flagId', 'beforeRevision', 'limit']);
                const page = await manager.history(raw as unknown as Parameters<typeof manager.history>[0]);
                guard();
                const scope = scopeOf(raw.tenantId as string | null),
                  flagId = flagStoreIdentifier(raw.flagId);
                return Object.freeze({
                  ...scope,
                  flagId,
                  owner: catalog.flags[flagId].owner,
                  entries: Object.freeze(
                    page.entries.map((entry) => Object.freeze({ ...entry, before: control(entry.before), after: control(entry.after) })),
                  ),
                  nextBeforeRevision: page.nextBeforeRevision,
                });
              },
              async change(input, beforeCommit) {
                guard();
                if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw new FlagManagementDenied();
                if (input.operation === 'set' && input.override?.experiment) {
                  const evidence = target.experimentEvidence;
                  if (!evidence) throw new ExperimentStoreUnavailable();
                  const epoch =
                    evidence.resolveEpoch?.(input.tenantId, input.flagId) ??
                    evidence.epochs.find(
                      (epoch) =>
                        epoch.flagId === input.flagId &&
                        epoch.scope.controlTenantId === input.tenantId &&
                        epoch.scope.evaluationTenantId === input.tenantId,
                    );
                  if (!epoch) throw new ExperimentStoreUnavailable();
                  ensure(
                    epoch.scope.controlTenantId === input.tenantId && epoch.scope.evaluationTenantId === input.tenantId,
                    'Activate this experiment in its control scope.',
                  );
                  const override = normalizeFlagSnapshot(
                    { ...scopeOf(input.tenantId), revision: 0, overrides: { [input.flagId]: input.override } },
                    catalog,
                  ).overrides[input.flagId];
                  ensure(
                    override.experiment?.version === epoch.version &&
                      override.value === undefined &&
                      !override.rules?.length &&
                      (override.rollout ?? 100) === epoch.eligibility.rollout &&
                      epoch.arms.every((arm) =>
                        override.experiment!.weights.some(
                          (weight) => weight.weight === arm.weight && flagValuesEqual(weight.value, arm.value as never),
                        ),
                      ),
                    'Activation differs from the immutable epoch.',
                  );
                  const admitted = await admit(scopeOf(input.tenantId), input.flagId, 'set');
                  await evidence.store.registerEpoch(epoch, async () => {
                    guard();
                    await beforeCommit?.();
                    await admitted.reobserve();
                    guard();
                  });
                }
                return manager.change(
                  input,
                  beforeCommit === undefined
                    ? undefined
                    : async () => {
                        guard();
                        await beforeCommit();
                        guard();
                      },
                );
              },
              async experimentCapabilities(input) {
                const raw = flagStoreRecord(input, ['tenantId', 'flagId']),
                  scope = scopeOf(raw.tenantId as string | null);
                const flagId = flagStoreIdentifier(raw.flagId);
                const viewed = await admit(scope, flagId, 'experiment-view');
                let canDecide = false;
                try {
                  const proof = await admit(scope, flagId, 'decide');
                  await proof.reobserve();
                  canDecide = true;
                } catch (error) {
                  if (!(error instanceof FlagManagementDenied)) throw error;
                }
                await viewed.reobserve();
                guard();
                return Object.freeze({ canDecide });
              },
              async results(input) {
                guard();
                if (!decisions) throw new ExperimentStoreUnavailable();
                const result = await decisions.results(input);
                guard();
                return result;
              },
              async decide(input, beforeCommit) {
                guard();
                if (!decisions) throw new ExperimentStoreUnavailable();
                if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw new FlagManagementDenied();
                return decisions.decide(
                  input,
                  beforeCommit === undefined
                    ? undefined
                    : async () => {
                        guard();
                        await beforeCommit();
                        guard();
                      },
                );
              },
            };
            const track =
              <A extends readonly unknown[], R>(method: (...args: A) => Promise<R>) =>
              (...args: A): Promise<R> => {
                const result = (async () => {
                  guard();
                  return method(...args);
                })();
                operations.add(result);
                void result.then(
                  () => operations.delete(result),
                  () => operations.delete(result),
                );
                return result;
              };
            const session = Object.freeze<FlagControlSession>({
              current: track(methods.current),
              list: track(methods.list),
              get: track(methods.get),
              editor: track(methods.editor),
              capabilities: track(methods.capabilities),
              history: track(methods.history),
              change: track(methods.change),
              experimentCapabilities: track(methods.experimentCapabilities),
              results: track(methods.results),
              decide: track(methods.decide),
            });
            return await work(session);
          } finally {
            live = false;
            // Even a callback that forgot to await an accepted operation cannot
            // let the shared store close underneath that operation.
            await Promise.allSettled([...operations]);
            pending.delete(held);
            finish();
          }
        },
      });
      return [target.appId, handle] as const;
    }),
  );
  return Object.freeze({
    environment: options.environment,
    target(appId: string) {
      active();
      const target = targets.get(appId);
      if (!target) throw new FlagManagementDenied();
      return target;
    },
    /** Stop admission synchronously. In-flight work reaches its next fence and
     * settles before the shared store closes. Native auth remains host-owned. */
    close(): Promise<void> {
      retired = true;
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        await store.close();
      })());
    },
  });
}

type FlagRow = Readonly<
  FlagScope & {
    flagId: string;
    revision: number;
    definition: FlagAuthorityOptions['catalog']['flags'][string];
    control: ReturnType<typeof control>;
  }
>;
export interface FlagControlSession {
  current(): Promise<void>;
  list(input: {
    tenantId: string | null;
    limit?: number;
    after?: string;
  }): Promise<{ readonly items: readonly FlagRow[]; readonly nextAfter: string | null }>;
  get(input: { tenantId: string | null; flagId: string }): Promise<FlagRow>;
  /** Explicit targeting editor DTO, independently authorized as flags.view. */
  editor(input: { tenantId: string | null; flagId: string }): Promise<
    Omit<FlagRow, 'control'> & {
      control: (NonNullable<ReturnType<typeof control>> & { readonly rules?: FlagOverride['rules'] }) | null;
      audiences: FlagCatalog['audiences'];
    }
  >;
  capabilities(input: {
    tenantId: string | null;
    flagId: string;
  }): Promise<Readonly<FlagScope & { flagId: string; revision: number; actions: readonly ('view' | 'manage' | 'kill')[] }>>;
  history(input: { tenantId: string | null; flagId: string; limit?: number; beforeRevision?: number }): Promise<
    FlagScope & {
      readonly flagId: string;
      readonly owner: string;
      readonly entries: readonly (Omit<
        Awaited<ReturnType<ReturnType<typeof createFlagManagement>['history']>>['entries'][number],
        'before' | 'after'
      > & {
        readonly before: ReturnType<typeof control>;
        readonly after: ReturnType<typeof control>;
      })[];
      readonly nextBeforeRevision: number | null;
    }
  >;
  /** Trusted owner guard only; never decoded from a transport body. */
  change(
    input: FlagManagementChange,
    beforeCommit?: () => void | Promise<void>,
  ): ReturnType<ReturnType<typeof createFlagManagement>['change']>;
  /** Both methods use this exact target's native session/current authority.
   * Unconfigured evidence is unavailable, never an empty results projection. */
  experimentCapabilities(input: { tenantId: string | null; flagId: string }): Promise<{ readonly canDecide: boolean }>;
  results: ReturnType<typeof createExperimentDecisionManager>['results'];
  decide: ReturnType<typeof createExperimentDecisionManager>['decide'];
}
type FlagDeployment = Awaited<ReturnType<typeof openFlagDeployment>>;
export type FlagDeploymentTarget = ReturnType<FlagDeployment['target']>;

export function openFlagDeployment(input: FlagDeploymentOptions) {
  const options = captureOptions(input);
  return build(options, () => openPostgresFlagStore({ url: options.url, binding: options.binding }));
}
/** Trusted in-process adapter seam for isolated tests. Ownership transfers on
 * successful acquisition; this port accepts a store, never a transaction. */
export function createFlagDeployment(input: FlagDeploymentOptions, store: FlagStore) {
  const options = captureOptions(input);
  return build(options, async () => store);
}
