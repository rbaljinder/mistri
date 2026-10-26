import { isPromise } from 'node:util/types';
import type { Identity } from '../auth/auth.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  TenantRequestFault,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { evidenceRefused, type AdmissionCache } from './tenantAdmissionCache.js';

/**
 * The reason recorded on a refusal whose evidence no longer matches the
 * membership as it stands: none, revoked, suspended, closed, changed or
 * expired. Never sent to a caller (it travels as a refusal's recorded cause);
 * it lets the owner that answers tell the membership's own refusal from a
 * store or catalog that could not be attested, which refuses the same way.
 */
export class TenantMembershipLapsed extends Error {
  constructor() {
    super('The membership no longer holds as its evidence says.');
    this.name = 'TenantMembershipLapsed';
  }
}

export interface TenantMembershipRecord {
  readonly appId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly tenantStatus: 'active' | 'suspended' | 'closed';
  readonly tenantVersion: string;
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly status: 'active' | 'revoked' | 'invited';
  readonly roles: readonly string[];
  /** Source authority's maximum admission expiry, milliseconds since epoch. */
  readonly validUntil: number;
}
export interface TenantMembershipLookup {
  readonly appId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly source: TenantOwnershipSnapshot['source'];
  readonly deployment: string;
}
/** Admission-time evidence, not a credential, writer fence or data capability. */
export interface TenantMembershipEvidence extends TenantMembershipLookup {
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly tenantVersion: string;
  readonly roles: readonly string[];
  readonly verifiedAt: number;
  readonly validUntil: number;
}
export interface TenantMembershipOptions<Request> {
  readonly ownership: TenantOwnershipSnapshot;
  readonly deployment: string;
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly membership: {
    readonly source: TenantOwnershipSnapshot['source'];
    readonly read: (lookup: TenantMembershipLookup) => TenantMembershipRecord | null | Promise<TenantMembershipRecord | null>;
  };
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts); absent, every admission reads. */
  readonly admissions?: AdmissionCache;
}

/** Canonical opaque IDs avoid whitespace/case aliases in the initial strategy.
 * Callers must supply all URL selector values; duplicates never pick a winner. */
export function parseTenantSelector(values: readonly string[]): string {
  const captured = captureTenantData(values);
  if (
    !Array.isArray(captured) ||
    captured.length !== 1 ||
    typeof captured[0] !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(captured[0])
  )
    return denyTenant();
  return captured[0];
}

/** Capture sync results before yielding; custom thenables are not provider data. */
function delivered<T>(result: T | Promise<T>): T | Promise<T> {
  if (isPromise(result))
    return Promise.prototype.then.call(
      result,
      (value: T) => captureTenantData(value),
      (error: unknown) => denyTenantFor(error),
    ) as Promise<T>;
  return captureTenantData(result);
}

function revision(value: unknown): void {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9][0-9]*)$/.test(value)) denyTenant();
}

/** Private single-source admission. No routes, membership storage, mutation,
 * source acquisition or public enrollment is installed here. The read callback
 * is trusted host code bound to the declared source; its database implementation
 * and same-writer revocation fence must be proved before data enablement. */
export function createTenantMembershipIssuer<Request>(options: TenantMembershipOptions<Request>) {
  const raw = tenantOptions(options, [
    'ownership',
    'deployment',
    'roles',
    'maxLifetimeMs',
    'verifySession',
    'membership',
    'now',
    'admissions',
  ]);
  const ownership = captureTenantOwnership(raw.ownership as TenantOwnershipSnapshot);
  const deployment = captureTenantData(raw.deployment);
  tenantIdentifier(deployment);
  const roles = captureTenantData(raw.roles);
  if (!Array.isArray(roles) || roles.length > 256) return denyTenant();
  for (const role of roles) tenantIdentifier(role);
  if (new Set(roles).size !== roles.length) return denyTenant();
  const allowed = new Set(roles);
  const maxLifetimeMs = raw.maxLifetimeMs;
  if (typeof maxLifetimeMs !== 'number' || !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 300_000)
    return denyTenant();
  const membership = tenantOptions(raw.membership, ['source', 'read']);
  const source = captureTenantData(membership.source);
  tenantRecord(source, ['id', 'connection']);
  if (source.id !== ownership.source.id || source.connection !== ownership.source.connection) return denyTenant();
  if (
    typeof membership.read !== 'function' ||
    typeof raw.verifySession !== 'function' ||
    (raw.now !== undefined && typeof raw.now !== 'function')
  )
    return denyTenant();
  const read = membership.read as TenantMembershipOptions<Request>['membership']['read'];
  const verify = raw.verifySession as TenantMembershipOptions<Request>['verifySession'];
  const now = (raw.now ?? Date.now) as () => number;
  const clock = () => {
    const value = now();
    // The clock is synchronous. Consume a malformed async clock's rejection
    // without assimilating arbitrary thenables or treating it as time evidence.
    if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - maxLifetimeMs) return denyTenant();
    return value;
  };
  const admissions = raw.admissions as AdmissionCache | undefined;
  /** Kept evidence this admission may serve: the same lookup, roles this
   * issuer grants, and a window the clock is still inside. */
  const usable = (kept: unknown, lookup: TenantMembershipLookup, instant: number): TenantMembershipEvidence | undefined => {
    if (!kept || typeof kept !== 'object' || !('tenantId' in kept)) return undefined;
    const value = kept as TenantMembershipEvidence;
    return value.appId === lookup.appId &&
      value.accountId === lookup.accountId &&
      value.tenantId === lookup.tenantId &&
      value.deployment === lookup.deployment &&
      value.source.id === lookup.source.id &&
      value.source.connection === lookup.source.connection &&
      value.roles.every((role) => allowed.has(role)) &&
      instant >= value.verifiedAt &&
      instant < value.validUntil &&
      value.validUntil - value.verifiedAt <= maxLifetimeMs
      ? value
      : undefined;
  };
  /** The membership read in admission's own snapshot, as evidence. */
  const admit = async (lookup: TenantMembershipLookup, started: number): Promise<TenantMembershipEvidence> => {
    const beforeRead = clock();
    if (beforeRead < started || beforeRead >= started + maxLifetimeMs) return denyTenant();
    active();
    const membershipResult = delivered(read(lookup));
    const record = isPromise(membershipResult) ? await membershipResult : membershipResult;
    active();
    // No membership, or none that is active: the membership's own refusal (TenantMembershipLapsed).
    if (record === null) return denyTenant(new TenantMembershipLapsed());
    tenantRecord(record, [
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
      record.appId !== lookup.appId ||
      record.accountId !== lookup.accountId ||
      record.tenantId !== lookup.tenantId ||
      record.status !== 'active' ||
      record.tenantStatus !== 'active'
    )
      return denyTenant(
        record.appId === lookup.appId && record.accountId === lookup.accountId && record.tenantId === lookup.tenantId
          ? new TenantMembershipLapsed()
          : undefined,
      );
    tenantIdentifier(record.membershipId, 1024);
    revision(record.membershipVersion);
    revision(record.tenantVersion);
    if (
      !Array.isArray(record.roles) ||
      record.roles.length > 256 ||
      new Set(record.roles).size !== record.roles.length ||
      record.roles.some((role) => typeof role !== 'string' || !allowed.has(role))
    )
      return denyTenant();
    const verifiedAt = clock();
    active();
    if (verifiedAt < beforeRead || typeof record.validUntil !== 'number' || !Number.isSafeInteger(record.validUntil)) return denyTenant();
    const validUntil = Math.min(record.validUntil, started + maxLifetimeMs);
    if (verifiedAt >= validUntil) return denyTenant();
    return captureTenantData({
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: record.roles,
      verifiedAt,
      validUntil,
    });
  };
  let retired = false;
  const pending = new Set<Promise<void>>();
  const active = () => {
    if (retired) denyTenant();
  };
  return Object.freeze({
    /** Stop admission synchronously, then drain every already accepted callback.
     * Owners call this outside their own admission callback to avoid self-wait. */
    async retire(): Promise<void> {
      retired = true;
      await Promise.allSettled([...pending]);
    },
    /** Drop the kept evidence of this request's login in the evidence's tenant: it met a refusal. */
    forget(request: Request, evidence: TenantMembershipEvidence): void {
      admissions?.drop(admissions.find(request, evidence.accountId, evidence.tenantId).key);
    },
    /** `retry`: when kept evidence (tenantAdmissionCache.ts) meets a refusal
     * in `callback`, admit afresh and call it once more. Only for a callback
     * that cannot have written: a read's. `fresh`: never serve kept evidence. */
    async withMembership<T>(
      request: Request,
      selectors: readonly string[],
      callback: (evidence: TenantMembershipEvidence, kept: boolean) => T | Promise<T>,
      admission: { readonly retry?: boolean; readonly fresh?: boolean } = {},
    ): Promise<T> {
      active();
      const selected = captureTenantData(selectors);
      if (typeof callback !== 'function') return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // Reserve before invoking host code, including a reentrant retirement.
      pending.add(held);
      try {
        for (let fresh = admission.fresh === true; ; fresh = true) {
          const started = clock();
          active();
          const sessionResult = delivered(verify(request));
          const session = isPromise(sessionResult) ? await sessionResult : sessionResult;
          active();
          tenantRecord(session, ['id', 'who', 'role']);
          tenantIdentifier(session.id, 1024);
          if (typeof session.who !== 'string' || (session.role !== undefined && typeof session.role !== 'string')) return denyTenant();
          const tenantId = parseTenantSelector(selected);
          const lookup = captureTenantData({
            appId: ownership.appId,
            accountId: session.id,
            tenantId,
            source: ownership.source,
            deployment,
          });
          const slot = admissions?.find(request, session.id, tenantId) ?? {};
          const keptEvidence = fresh ? undefined : usable(slot.evidence, lookup, started);
          const evidence = keptEvidence ?? (await admit(lookup, started));
          if (!keptEvidence) admissions?.keep(slot.key, evidence);
          try {
            const result = await callback(evidence, keptEvidence !== undefined);
            active();
            const completedAt = clock();
            active();
            if (completedAt < evidence.verifiedAt || completedAt >= evidence.validUntil) return denyTenant();
            return result;
          } catch (error) {
            // A refusal is never kept, and evidence that met one is not either.
            admissions?.drop(slot.key);
            if (!keptEvidence || admission.retry !== true || !evidenceRefused(error)) throw error;
          }
        }
      } catch (error) {
        // The request's own fault passes, already revalidated (tenantReadRuntime.ts).
        if (error instanceof TenantRequestFault) throw error;
        return denyTenantFor(error);
      } finally {
        pending.delete(held);
        finish();
      }
    },
  });
}
