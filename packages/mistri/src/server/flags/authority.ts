/** Target-owned flag authority. Serialized capabilities are declarations, never
 * credentials. Only a genuine target-App session and current membership owner
 * supply roles; Console admission and native administrator roles add no powers. */
import { isPromise } from 'node:util/types';
import {
  flagValuesEqual,
  normalizeFlagCatalog,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagExperiment,
  type FlagOverride,
  type FlagScope,
} from '../../shared/appFlags.js';
import type { AppAuthRuntime, VerifiedSessionInstance } from '../auth/auth.js';
import { captureTenantData, tenantIdentifier, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import type { FlagAuthorizationRequest } from './management.js';
import { FlagManagementDenied, flagStoreIdentifier, flagStoreRecord } from './store.js';

type FlagCapabilityAction = 'view' | 'manage' | 'killswitch';
type ExperimentCapabilityAction = 'view' | 'manage' | 'decide';
export type FlagRequiredCapability = `flags.${FlagCapabilityAction}` | `experiments.${ExperimentCapabilityAction}`;
export interface FlagCapability<A extends string = FlagCapabilityAction> {
  readonly actions: readonly A[];
  readonly environments: readonly string[];
  readonly owners: readonly string[];
  readonly ids?: readonly string[];
}
export interface FlagRoleCapabilities {
  readonly realm?: 'tenant' | 'platform';
  readonly flags?: readonly FlagCapability[];
  readonly experiments?: readonly FlagCapability<ExperimentCapabilityAction>[];
}
/** Immutable authority projection of authored declarations. The DSL integrator
 * projects each experiment's version/allocation to the existing runtime epoch
 * shape here; metric/lifecycle metadata does not belong in this matcher. */
export interface FlagAuthorityCatalog extends FlagCatalog {
  readonly experiments?: Readonly<Record<string, FlagExperiment>>;
}
const deny = (): never => {
  throw new FlagManagementDenied();
};
const record = (input: unknown, fields: readonly string[]) => flagStoreRecord(input, fields);
function names(input: unknown, allowed?: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || !input.length || input.length > 256) return deny();
  const values = input.map(flagStoreIdentifier);
  if (new Set(values).size !== values.length || (allowed && values.some((value) => !allowed.includes(value)))) return deny();
  return Object.freeze(values);
}

export function normalizeFlagAuthorityCatalog(input: unknown): FlagAuthorityCatalog {
  const raw = record(input, ['flags', 'roles', 'audiences', 'experiments']);
  const catalog = normalizeFlagCatalog({ flags: raw.flags, roles: raw.roles, audiences: raw.audiences });
  const experiments = Object.hasOwn(raw, 'experiments') ? record(raw.experiments, Object.keys(catalog.flags)) : {};
  const normalized = Object.fromEntries(
    Object.entries(experiments).map(([id, experiment]) => {
      const snapshot = normalizeFlagSnapshot(
        { appId: 'declaration', environment: 'declaration', tenantId: null, revision: 0, overrides: { [id]: { experiment } } },
        catalog,
      );
      return [id, snapshot.overrides[id].experiment!];
    }),
  );
  return Object.freeze({ ...catalog, experiments: Object.freeze(normalized) });
}

export function normalizeFlagRoleCapabilities(
  input: unknown,
  catalog: FlagAuthorityCatalog,
  tenantApp: boolean,
): Readonly<Record<string, FlagRoleCapabilities>> {
  const raw = record(input, catalog.roles);
  if (Object.keys(raw).length !== catalog.roles.length) return deny();
  const owners = [...new Set(Object.values(catalog.flags).map((flag) => flag.owner))];
  return Object.freeze(
    Object.fromEntries(
      Object.entries(raw).map(([role, value]) => {
        const entry = record(value, ['realm', 'flags', 'experiments']);
        if (tenantApp ? !['tenant', 'platform'].includes(entry.realm as string) : Object.hasOwn(entry, 'realm')) return deny();
        for (const family of ['flags', 'experiments'] as const) {
          if (!Object.hasOwn(entry, family)) continue;
          const list = entry[family];
          if (!Array.isArray(list) || !list.length || list.length > 256) return deny();
          for (const capability of list) {
            const item = record(capability, ['actions', 'environments', 'owners', 'ids']);
            names(item.actions, family === 'flags' ? ['view', 'manage', 'killswitch'] : ['view', 'manage', 'decide']);
            names(item.environments);
            const owned = names(item.owners, owners);
            if (Object.hasOwn(item, 'ids')) {
              const ids = names(item.ids, family === 'flags' ? Object.keys(catalog.flags) : Object.keys(catalog.experiments ?? {}));
              if (ids.some((id) => !owned.includes(catalog.flags[id].owner))) return deny();
            }
          }
        }
        return [role, entry as unknown as FlagRoleCapabilities];
      }),
    ),
  );
}

/** Classified solely from the captured declaration, never an override body. */
export function requiredFlagCapabilities(
  catalog: FlagAuthorityCatalog,
  flagId: string,
  operation: FlagAuthorizationRequest['operation'],
): readonly FlagRequiredCapability[] {
  if (!Object.hasOwn(catalog.flags, flagId)) return deny();
  if (operation === 'view') return Object.freeze(['flags.view']);
  if (operation === 'kill') return Object.freeze(['flags.killswitch']);
  if (operation === 'experiment-view' || operation === 'decide') {
    if (!Object.hasOwn(catalog.experiments ?? {}, flagId)) return deny();
    return Object.freeze(
      operation === 'experiment-view' ? ['experiments.view'] : ['flags.manage', 'experiments.manage', 'experiments.decide'],
    );
  }
  if (operation !== 'set' && operation !== 'revert') return deny();
  return Object.freeze(Object.hasOwn(catalog.experiments ?? {}, flagId) ? ['flags.manage', 'experiments.manage'] : ['flags.manage']);
}

/** Also used for a historical override before reverting it. An old allocation
 * cannot reactivate an undeclared or changed immutable epoch. */
export function assertFlagExperimentOverride(catalog: FlagAuthorityCatalog, flagId: string, override: FlagOverride | undefined): void {
  if (!override?.experiment) return;
  const declared = catalog.experiments?.[flagId],
    actual = override.experiment;
  if (
    !declared ||
    declared.version !== actual.version ||
    declared.weights.length !== actual.weights.length ||
    declared.weights.some(
      (weight) => !actual.weights.some((item) => item.weight === weight.weight && flagValuesEqual(item.value, weight.value)),
    )
  )
    deny();
}

/** Pure declaration matcher; the caller must obtain roles from its authority
 * owner. Unknown roles invalidate the whole observation rather than a subset. */
export function matchFlagCapabilities(
  roles: Readonly<Record<string, FlagRoleCapabilities>>,
  granted: readonly string[],
  realm: 'app' | 'tenant' | 'platform',
  request: Pick<FlagAuthorizationRequest, 'scope' | 'owner' | 'flagId' | 'requiredCapabilities'>,
): boolean {
  try {
    const observed = names(captureTenantData(granted));
    if (observed.some((role) => !Object.hasOwn(roles, role) || (roles[role].realm ?? 'app') !== realm)) return false;
    const required = captureTenantData(request.requiredCapabilities);
    if (!Array.isArray(required) || !required.length || required.length > 6 || new Set(required).size !== required.length) return false;
    return required.every((capability: unknown) => {
      if (typeof capability !== 'string') return false;
      const [family, action, extra] = capability.split('.');
      if (
        extra !== undefined ||
        (family !== 'flags' && family !== 'experiments') ||
        !(family === 'flags' ? ['view', 'manage', 'killswitch'] : ['view', 'manage', 'decide']).includes(action)
      )
        return false;
      return observed.some((role) =>
        roles[role][family]?.some(
          (entry) =>
            (entry.actions as readonly string[]).includes(action) &&
            entry.environments.includes(request.scope.environment) &&
            entry.owners.includes(request.owner) &&
            (entry.ids === undefined || entry.ids.includes(request.flagId)),
        ),
      );
    });
  } catch {
    return false;
  }
}

export interface FlagMembershipObservation {
  /** Narrow observation protocol supplied by the target membership owner;
   * flags never import or construct a native membership capability. */
  readonly record: Readonly<
    {
      appId: string;
      accountId: string;
      membershipId: string;
      membershipVersion: string;
      status: string;
      roles: readonly string[];
      validUntil: number;
    } & (
      | { realm: 'platform'; platformStatus: string; platformVersion: string }
      | { tenantId: string; tenantStatus: string; tenantVersion: string }
    )
  >;
  /** Existing membership owner's final synchronous fence, including lifetime
   * and retirement. Must throw if its observed membership is no longer current. */
  readonly assertCurrent: () => void;
}
export interface FlagAuthorityOptions {
  readonly appId: string;
  readonly environment: string;
  readonly catalog: FlagAuthorityCatalog;
  /** Closed projection of auth.roles: include every role, with only the fields
   * in FlagRoleCapabilities. Ordinary resource grants remain with their owner. */
  readonly roles: Readonly<Record<string, FlagRoleCapabilities>>;
  readonly tenantApp: boolean;
  readonly auth: AppAuthRuntime;
  readonly assertCurrent: () => void;
  /** Bound by the target deployment to its existing tenant/platform owner.
   * Every call must freshly observe, not return admission-cache evidence. */
  readonly observeMembership?: (
    scope: FlagScope,
    accountId: string,
  ) => FlagMembershipObservation | null | Promise<FlagMembershipObservation | null>;
}

/** Bind once per target deployment. forSession accepts only the exact proof
 * handle issued by captureAppAuthRuntime(targetAuth), never a copied identity,
 * native/root proof or Console proof. The proof itself supplies no role grant. */
export async function createFlagAuthority(options: FlagAuthorityOptions) {
  const raw = tenantOptions(options, [
    'appId',
    'environment',
    'catalog',
    'roles',
    'tenantApp',
    'auth',
    'assertCurrent',
    'observeMembership',
  ]);
  const fixed = normalizeFlagScope({ appId: raw.appId, environment: raw.environment, tenantId: null });
  const catalog = normalizeFlagAuthorityCatalog(raw.catalog);
  if (
    typeof raw.tenantApp !== 'boolean' ||
    typeof raw.assertCurrent !== 'function' ||
    (raw.tenantApp && typeof raw.observeMembership !== 'function') ||
    (!raw.tenantApp && Object.hasOwn(raw, 'observeMembership'))
  )
    return deny();
  const tenantApp = raw.tenantApp,
    roles = normalizeFlagRoleCapabilities(raw.roles, catalog, tenantApp);
  const current = raw.assertCurrent as () => void;
  const membership = raw.observeMembership as FlagAuthorityOptions['observeMembership'];
  // Pure declaration/management users need not load the native auth adapters.
  const { captureAppAuthRuntime } = await import('../auth/auth.js');
  const auth = captureAppAuthRuntime(raw.auth as AppAuthRuntime);
  if (auth.appId !== fixed.appId) return deny();
  const active = () => {
    current();
    auth.assertCurrent();
  };
  active();
  return Object.freeze({
    forSession(proof: VerifiedSessionInstance) {
      active();
      auth.assertSessionCurrent(proof);
      const actorId = flagStoreIdentifier(proof.identity.id);
      return async (input: FlagAuthorizationRequest) => {
        const rawRequest = record(input, ['scope', 'operation', 'owner', 'flagId', 'requiredCapabilities']);
        const scope = normalizeFlagScope(rawRequest.scope),
          flagId = flagStoreIdentifier(rawRequest.flagId);
        const definition = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
        if (
          scope.appId !== fixed.appId ||
          scope.environment !== fixed.environment ||
          !definition ||
          rawRequest.owner !== definition.owner ||
          (scope.tenantId !== null && (!tenantApp || !definition.tenantManaged))
        )
          return deny();
        const operation = rawRequest.operation as FlagAuthorizationRequest['operation'];
        const required = requiredFlagCapabilities(catalog, flagId, operation);
        const supplied = rawRequest.requiredCapabilities;
        if (!Array.isArray(supplied) || supplied.length !== required.length || required.some((value, index) => value !== supplied[index]))
          return deny();
        const request = Object.freeze({ scope, flagId, owner: definition.owner, operation, requiredCapabilities: required });
        const reobserve = async () => {
          try {
            active();
            auth.assertSessionCurrent(proof);
            await auth.observeSession(proof);
            active();
            let granted: readonly string[],
              fence = () => {};
            const realm = tenantApp ? (scope.tenantId === null ? 'platform' : 'tenant') : 'app';
            if (tenantApp) {
              const pending = membership!(scope, actorId);
              // Capture a synchronous provider result before the first yield.
              const capture = (value: FlagMembershipObservation | null) => {
                const observation = tenantOptions(value, ['record', 'assertCurrent']);
                if (typeof observation.assertCurrent !== 'function') return deny();
                return {
                  record: captureTenantData(observation.record) as FlagMembershipObservation['record'],
                  assertCurrent: observation.assertCurrent as () => void,
                };
              };
              const observation = isPromise(pending) ? await pending.then(capture) : capture(pending);
              const value = observation.record;
              if (
                !value ||
                value.appId !== scope.appId ||
                value.accountId !== actorId ||
                value.status !== 'active' ||
                !Number.isSafeInteger(value.validUntil) ||
                Date.now() >= value.validUntil
              )
                return deny();
              tenantIdentifier(value.membershipId, 1024);
              if (typeof value.membershipVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.membershipVersion)) return deny();
              if (realm === 'platform') {
                const platform = record(value, [
                  'realm',
                  'appId',
                  'accountId',
                  'platformStatus',
                  'platformVersion',
                  'membershipId',
                  'membershipVersion',
                  'status',
                  'roles',
                  'validUntil',
                ]);
                if (
                  platform.realm !== 'platform' ||
                  platform.platformStatus !== 'active' ||
                  typeof platform.platformVersion !== 'string' ||
                  !/^(0|[1-9][0-9]*)$/.test(platform.platformVersion)
                )
                  return deny();
              } else {
                const tenant = record(value, [
                  'appId',
                  'accountId',
                  'tenantId',
                  'tenantStatus',
                  'tenantVersion',
                  'membershipId',
                  'membershipVersion',
                  'status',
                  'roles',
                  'validUntil',
                ]);
                if (
                  tenant.tenantId !== scope.tenantId ||
                  tenant.tenantStatus !== 'active' ||
                  typeof tenant.tenantVersion !== 'string' ||
                  !/^(0|[1-9][0-9]*)$/.test(tenant.tenantVersion)
                )
                  return deny();
              }
              granted = value.roles;
              fence = () => {
                observation.assertCurrent();
                if (Date.now() >= value.validUntil) deny();
              };
            } else {
              const account = await auth.lookupEligibleAccountRolesCurrent(actorId);
              if (!account || account.accountId !== actorId) return deny();
              granted = account.roles;
            }
            if (!matchFlagCapabilities(roles, granted, realm, request)) return deny();
            if (tenantApp) await auth.observeSession(proof);
            active();
            auth.assertSessionCurrent(proof);
            fence();
          } catch {
            return deny();
          }
        };
        await reobserve();
        return Object.freeze({ actorId, reobserve });
      };
    },
  });
}
