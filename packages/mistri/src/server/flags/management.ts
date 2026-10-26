/** Target-App authorization owns this port. Console admission and root roles
 * are absent by construction. Request bodies cannot choose App/environment,
 * actor identity, declared owner, or the authority re-observation function. */
import { normalizeFlagCatalog, normalizeFlagScope, type FlagOverride, type FlagScope } from '../../shared/appFlags.js';
import {
  assertFlagExperimentOverride,
  normalizeFlagAuthorityCatalog,
  requiredFlagCapabilities,
  type FlagAuthorityCatalog,
  type FlagRequiredCapability,
} from './authority.js';
import {
  FlagManagementDenied,
  flagStoreIdentifier,
  flagStoreRecord,
  normalizeFlagHistoryQuery,
  normalizeFlagStoreMutation,
  type FlagHistoryEntry,
  type FlagHistoryQuery,
  type FlagMutationOperation,
  type FlagStore,
  type FlagStoreMutation,
} from './store.js';

export interface FlagAuthorizationRequest {
  readonly operation: FlagMutationOperation | 'view' | 'experiment-view' | 'decide';
  readonly scope: FlagScope;
  readonly flagId: string;
  readonly owner: string;
  readonly requiredCapabilities: readonly FlagRequiredCapability[];
}
interface FlagAuthorizationProof {
  readonly actorId: string;
  /** Throws if native session, App grant, membership, or scoped capability was
   * revoked. The owner captures its own verified evidence; no body roles. */
  readonly reobserve: () => void | Promise<void>;
}
export type FlagManagementAuthority = (
  request: FlagAuthorizationRequest,
) => FlagAuthorizationProof | null | Promise<FlagAuthorizationProof | null>;
interface ManagementBase {
  readonly tenantId: string | null;
  readonly flagId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}
export type FlagManagementChange = ManagementBase &
  (
    | { readonly operation: 'set'; readonly override: FlagOverride }
    | { readonly operation: 'kill' }
    | { readonly operation: 'revert'; readonly revertRevision: number }
  );
export interface FlagManagementAcknowledgement {
  readonly flagId: string;
  readonly revision: number;
  readonly operation: FlagMutationOperation;
}
/** Per-flag projection: even authorized history must not leak other owners'
 * flags from the store's whole-scope before/after snapshots. */
interface FlagManagementHistory extends Omit<FlagHistoryEntry, 'before' | 'after'> {
  readonly before: FlagOverride | null;
  readonly after: FlagOverride | null;
}
const project = (entry: FlagHistoryEntry): FlagManagementHistory =>
  Object.freeze({ ...entry, before: entry.before.overrides[entry.flagId] ?? null, after: entry.after.overrides[entry.flagId] ?? null });

export function createFlagManagement(options: {
  readonly appId: string;
  readonly environment: string;
  readonly catalog: FlagAuthorityCatalog;
  readonly store: FlagStore;
  readonly authorize: FlagManagementAuthority;
}) {
  const fixed = normalizeFlagScope({ appId: options.appId, environment: options.environment, tenantId: null });
  const declarations = normalizeFlagAuthorityCatalog(options.catalog);
  const catalog = normalizeFlagCatalog({ flags: declarations.flags, roles: declarations.roles, audiences: declarations.audiences });
  const store = options.store,
    authorize = options.authorize;
  if (typeof authorize !== 'function') throw new FlagManagementDenied();
  const admit = async (scope: FlagScope, flagId: string, operation: FlagAuthorizationRequest['operation']) => {
    const definition = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
    if (!definition || (scope.tenantId !== null && !definition.tenantManaged)) throw new FlagManagementDenied();
    const requiredCapabilities = requiredFlagCapabilities(declarations, flagId, operation);
    const proof = await authorize(Object.freeze({ scope, flagId, operation, owner: definition.owner, requiredCapabilities }));
    if (!proof || typeof proof.reobserve !== 'function') throw new FlagManagementDenied();
    const actorId = flagStoreIdentifier(proof.actorId),
      observe = proof.reobserve;
    // Capture callable and receiver now; mutating a returned proof later cannot
    // substitute another actor or a weaker check.
    return Object.freeze({ actorId, reobserve: () => observe.call(proof) });
  };
  return Object.freeze({
    async change(input: FlagManagementChange, beforeCommit?: () => void | Promise<void>): Promise<FlagManagementAcknowledgement> {
      // A trusted enclosing owner (such as Console) can add its currentness
      // fence. Transport bodies cannot supply or replace this callable.
      if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw new FlagManagementDenied();
      const raw = flagStoreRecord(input, ['tenantId', 'flagId', 'expectedRevision', 'reason', 'operation', 'override', 'revertRevision']);
      const scope = normalizeFlagScope({ ...fixed, tenantId: raw.tenantId }),
        flagId = flagStoreIdentifier(raw.flagId);
      if (!['set', 'kill', 'revert'].includes(raw.operation as string)) throw new FlagManagementDenied();
      const proof = await admit(scope, flagId, raw.operation as FlagMutationOperation);
      const { tenantId: _tenantId, ...fields } = raw;
      const change = normalizeFlagStoreMutation({ ...fields, scope, catalog, actorId: proof.actorId });
      if (change.operation === 'set') assertFlagExperimentOverride(declarations, flagId, change.override);
      if (change.operation === 'revert' && change.revertRevision !== 0) {
        // Audit entries are immutable. Check the exact historical allocation;
        // the store still resolves and CAS-checks it under its own write lock.
        if (change.revertRevision > change.expectedRevision) throw new FlagManagementDenied();
        const page = await store.history(scope, catalog, { flagId, beforeRevision: change.revertRevision + 1, limit: 1 });
        const entry = page.entries[0];
        if (
          !entry ||
          entry.revision !== change.revertRevision ||
          entry.flagId !== flagId ||
          entry.scope.appId !== scope.appId ||
          entry.scope.environment !== scope.environment ||
          entry.scope.tenantId !== scope.tenantId
        )
          throw new FlagManagementDenied();
        assertFlagExperimentOverride(declarations, flagId, entry.after.overrides[flagId]);
      }
      const reobserve = async () => {
        await proof.reobserve();
        await beforeCommit?.();
      };
      await reobserve();
      const entry = await store.mutate(change as FlagStoreMutation, reobserve);
      return Object.freeze({ flagId, revision: entry.revision, operation: change.operation });
    },
    async history(input: FlagHistoryQuery & { readonly tenantId: string | null }): Promise<{
      readonly entries: readonly FlagManagementHistory[];
      readonly nextBeforeRevision: number | null;
    }> {
      const raw = flagStoreRecord(input, ['tenantId', 'flagId', 'beforeRevision', 'limit']);
      const scope = normalizeFlagScope({ ...fixed, tenantId: raw.tenantId });
      const { tenantId: _tenantId, ...fields } = raw;
      const query = normalizeFlagHistoryQuery(fields, catalog),
        proof = await admit(scope, query.flagId, 'view');
      const page = await store.history(scope, catalog, query);
      await proof.reobserve();
      return Object.freeze({ entries: Object.freeze(page.entries.map(project)), nextBeforeRevision: page.nextBeforeRevision });
    },
  });
}
