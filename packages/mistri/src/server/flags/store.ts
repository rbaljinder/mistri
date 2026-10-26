/** Trusted control-store contracts. Store access is not authorization. A
 * revision covers the WHOLE (App, environment, tenant) snapshot, not one flag. */
import {
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  flagValuesEqual,
  type FlagCatalog,
  type FlagOverride,
  type FlagOverrideSnapshot,
  type FlagProvider,
  type FlagScope,
  type FlagValue,
} from '../../shared/appFlags.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';

export interface FlagStoreBinding {
  readonly suiteId: string;
  readonly deploymentId: string;
}
export type FlagMutationOperation = 'set' | 'kill' | 'revert' | 'decide';
/** Immutable control-audit reference to separately stored statistical evidence. */
interface FlagDecisionEvidence {
  readonly epochFingerprint: string;
  readonly resultsRevision: number;
  readonly winnerVariant: FlagValue;
}
interface MutationBase {
  readonly scope: FlagScope;
  readonly catalog: FlagCatalog;
  readonly flagId: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly reason: string;
}
export type FlagStoreMutation = MutationBase &
  (
    | { readonly operation: 'set'; readonly override: FlagOverride }
    | { readonly operation: 'kill' }
    | { readonly operation: 'decide'; readonly evidence: FlagDecisionEvidence }
    /** Zero restores the original absence of an override. Other revisions must
     * be historical changes to this exact flag in this exact scope. */
    | { readonly operation: 'revert'; readonly revertRevision: number }
  );
export interface FlagHistoryEntry {
  readonly scope: FlagScope;
  readonly revision: number;
  readonly flagId: string;
  readonly operation: FlagMutationOperation;
  readonly actorId: string;
  readonly reason: string;
  readonly at: string;
  readonly revertRevision: number | null;
  readonly evidence?: FlagDecisionEvidence;
  readonly before: FlagOverrideSnapshot;
  readonly after: FlagOverrideSnapshot;
}
export interface FlagHistoryQuery {
  readonly flagId: string;
  readonly beforeRevision?: number;
  readonly limit?: number;
}
interface FlagHistoryPage {
  readonly entries: readonly FlagHistoryEntry[];
  readonly nextBeforeRevision: number | null;
}
export interface FlagStore {
  readonly binding: FlagStoreBinding;
  readonly read: (scope: FlagScope, catalog: FlagCatalog) => Promise<FlagOverrideSnapshot>;
  /** Both exact control owners from one database snapshot. A legacy provider
   * without this method cannot safely compose tenant controls with global kills. */
  readonly readRequestScopes?: (
    scope: FlagScope,
    catalog: FlagCatalog,
  ) => Promise<{
    readonly global: FlagOverrideSnapshot;
    readonly tenant: FlagOverrideSnapshot | null;
  }>;
  readonly history: (scope: FlagScope, catalog: FlagCatalog, query: FlagHistoryQuery) => Promise<FlagHistoryPage>;
  /** The guard is a trusted authority lease, observed after all writes and
   * immediately before COMMIT. Throwing rolls back state AND history. */
  readonly mutate: (change: FlagStoreMutation, beforeCommit: () => void | Promise<void>) => Promise<FlagHistoryEntry>;
  readonly close: () => Promise<void>;
}
export class FlagStoreUnavailable extends Error {
  constructor(message = 'Flag control storage is unavailable or has an unrecognized owner or layout.') {
    super(message);
    this.name = 'FlagStoreUnavailable';
  }
}
export class FlagRevisionConflict extends Error {
  constructor() {
    super('The flag scope revision changed. Read its current snapshot before retrying.');
    this.name = 'FlagRevisionConflict';
  }
}
export class FlagManagementDenied extends Error {
  constructor() {
    super('Flag management authority is unavailable.');
    this.name = 'FlagManagementDenied';
  }
}

export function flagStoreRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = captureTenantData(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new FlagStoreUnavailable();
  return value as Record<string, unknown>;
}
export function flagStoreIdentifier(input: unknown): string {
  const scope = normalizeFlagScope({ appId: input, environment: 'identifier', tenantId: null });
  return scope.appId;
}
function flagStoreRevision(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > Number.MAX_SAFE_INTEGER)
    throw new FlagStoreUnavailable();
  return input as number;
}
export function normalizeFlagStoreBinding(input: unknown): FlagStoreBinding {
  const value = flagStoreRecord(input, ['suiteId', 'deploymentId']);
  return Object.freeze({ suiteId: flagStoreIdentifier(value.suiteId), deploymentId: flagStoreIdentifier(value.deploymentId) });
}
export function normalizeFlagStoreMutation(input: unknown): FlagStoreMutation {
  const raw = flagStoreRecord(input, [
    'scope',
    'catalog',
    'flagId',
    'expectedRevision',
    'actorId',
    'reason',
    'operation',
    'override',
    'revertRevision',
    'evidence',
  ]);
  const scope = normalizeFlagScope(raw.scope),
    catalog = normalizeFlagCatalog(raw.catalog),
    flagId = flagStoreIdentifier(raw.flagId);
  const declared = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
  if (!declared || (scope.tenantId !== null && !declared.tenantManaged)) throw new FlagManagementDenied();
  normalizeFlagContext({ identity: { kind: 'subject', id: raw.actorId } }, catalog);
  if (
    typeof raw.reason !== 'string' ||
    raw.reason.trim() !== raw.reason ||
    !raw.reason.length ||
    raw.reason.length > 1024 ||
    /[\p{Cc}\p{Cs}]/u.test(raw.reason)
  )
    throw new FlagStoreUnavailable();
  const base = {
    scope,
    catalog,
    flagId,
    expectedRevision: flagStoreRevision(raw.expectedRevision),
    actorId: raw.actorId as string,
    reason: raw.reason,
  };
  if (base.expectedRevision === Number.MAX_SAFE_INTEGER) throw new FlagStoreUnavailable();
  if (raw.operation === 'decide' && !Object.hasOwn(raw, 'override') && !Object.hasOwn(raw, 'revertRevision')) {
    const evidence = flagStoreRecord(raw.evidence, ['epochFingerprint', 'resultsRevision', 'winnerVariant']);
    if (
      typeof evidence.epochFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(evidence.epochFingerprint) ||
      flagStoreRevision(evidence.resultsRevision) < 1
    )
      throw new FlagStoreUnavailable();
    const snapshot = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: { [flagId]: { value: evidence.winnerVariant } } }, catalog);
    const winnerVariant = snapshot.overrides[flagId].value!;
    if (!declared.variants?.some((value) => flagValuesEqual(value, winnerVariant))) throw new FlagManagementDenied();
    return Object.freeze({
      ...base,
      operation: 'decide',
      evidence: Object.freeze({
        epochFingerprint: evidence.epochFingerprint,
        resultsRevision: evidence.resultsRevision as number,
        winnerVariant,
      }),
    });
  }
  if (Object.hasOwn(raw, 'evidence')) throw new FlagStoreUnavailable();
  if (raw.operation === 'set' && Object.hasOwn(raw, 'override') && !Object.hasOwn(raw, 'revertRevision')) {
    const snapshot = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: { [flagId]: raw.override } }, catalog);
    return Object.freeze({ ...base, operation: 'set', override: snapshot.overrides[flagId] });
  }
  if (raw.operation === 'kill' && !Object.hasOwn(raw, 'override') && !Object.hasOwn(raw, 'revertRevision')) {
    if (declared.safeValue === undefined) throw new FlagManagementDenied();
    return Object.freeze({ ...base, operation: 'kill' });
  }
  if (raw.operation === 'revert' && !Object.hasOwn(raw, 'override') && Object.hasOwn(raw, 'revertRevision')) {
    return Object.freeze({ ...base, operation: 'revert', revertRevision: flagStoreRevision(raw.revertRevision) });
  }
  throw new FlagStoreUnavailable();
}
export function normalizeFlagHistoryQuery(input: unknown, catalog: FlagCatalog): FlagHistoryQuery & { readonly limit: number } {
  const raw = flagStoreRecord(input, ['flagId', 'beforeRevision', 'limit']);
  const flagId = flagStoreIdentifier(raw.flagId),
    limit = raw.limit ?? 25;
  if (!Object.hasOwn(catalog.flags, flagId) || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
    throw new FlagStoreUnavailable();
  return Object.freeze({
    flagId,
    limit: limit as number,
    ...(raw.beforeRevision === undefined ? {} : { beforeRevision: flagStoreRevision(raw.beforeRevision) }),
  });
}
/** Polls the current committed snapshot on each request. No cache/NOTIFY claim.
 * The host supplies a verified tenant scope; this is not a public read API. */
export function createFlagStoreProvider(
  store: FlagStore,
  owner: { appId: string; environment: string; catalog: FlagCatalog },
): FlagProvider {
  const scope = normalizeFlagScope({ appId: owner.appId, environment: owner.environment, tenantId: null });
  const catalog = normalizeFlagCatalog(owner.catalog);
  return Object.freeze({
    readSnapshot: async ({ scope: input }) => {
      const requested = normalizeFlagScope(input);
      if (requested.appId !== scope.appId || requested.environment !== scope.environment) throw new FlagManagementDenied();
      return store.read(requested, catalog);
    },
  } satisfies FlagProvider);
}
