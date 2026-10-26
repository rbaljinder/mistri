/**
 * The platform realm's membership. Platform staff hold one membership in the
 * tenant store's reserved `@platform` row, never a tenant membership. Its
 * evidence carries no tenant id, so every tenant-only consumer (each captures
 * exact keys) fails closed on it, and tenant evidence, which has no `realm`,
 * fails closed here. Platform roles are the platform realm's own: never
 * unioned with a tenant membership's or Better Auth's global role.
 */
import { isPromise } from 'node:util/types';
import type { Identity } from '../auth/auth.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { evidenceRefused, type AdmissionCache } from './tenantAdmissionCache.js';
import { revision, roles, time, type TenantStoreBinding } from './tenantStoreContract.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';

/** The reserved store row of the platform realm. `@` fails parseTenantSelector,
 * so no `?tenant=`, tenant creation or ownership injection can name it. */
export { PLATFORM_TENANT_ID };

export interface PlatformMembershipLookup {
  readonly realm: 'platform';
  readonly appId: string;
  readonly accountId: string;
  readonly source: TenantOwnershipSnapshot['source'];
  readonly deployment: string;
}
export interface PlatformMembershipRecord {
  readonly realm: 'platform';
  readonly appId: string;
  readonly accountId: string;
  readonly platformStatus: 'active' | 'suspended' | 'closed';
  readonly platformVersion: string;
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly status: 'active' | 'invited';
  readonly roles: readonly string[];
  /** Source authority's maximum admission expiry, milliseconds since epoch. */
  readonly validUntil: number;
}
/** Admission-time evidence, not a credential, writer fence or data capability. */
export interface PlatformMembershipEvidence extends PlatformMembershipLookup {
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly platformVersion: string;
  readonly roles: readonly string[];
  readonly verifiedAt: number;
  readonly validUntil: number;
}
export const PLATFORM_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'realm',
  'appId',
  'accountId',
  'source',
  'deployment',
  'membershipId',
  'membershipVersion',
  'platformVersion',
  'roles',
  'verifiedAt',
  'validUntil',
]);

/** The store-side lookup: bound to the store's App and source, never to a request's. */
export function platformLookup(input: PlatformMembershipLookup, owner: TenantStoreBinding): PlatformMembershipLookup {
  const value = captureTenantData(input);
  tenantRecord(value, ['realm', 'appId', 'accountId', 'source', 'deployment']);
  tenantRecord(value.source, ['id', 'connection']);
  if (value.realm !== 'platform') return denyTenant();
  tenantIdentifier(value.accountId, 1024);
  tenantIdentifier(value.deployment);
  if (value.appId !== owner.appId || value.source.id !== owner.source.id || value.source.connection !== owner.source.connection)
    return denyTenant();
  return value;
}
export function platformMembershipRecord(
  owner: TenantStoreBinding,
  accountId: string,
  row: Record<string, unknown>,
): PlatformMembershipRecord {
  revision(row.platform_version);
  revision(row.version);
  tenantIdentifier(row.id, 1024);
  time(row.valid_until);
  if (
    !['active', 'suspended', 'closed'].includes(row.platform_status as string) ||
    !['active', 'invited'].includes(row.status as string) ||
    typeof row.roles_json !== 'string'
  )
    return denyTenant();
  const granted: unknown = JSON.parse(row.roles_json);
  roles(granted);
  return captureTenantData({
    realm: 'platform',
    appId: owner.appId,
    accountId,
    platformStatus: row.platform_status as PlatformMembershipRecord['platformStatus'],
    platformVersion: row.platform_version,
    membershipId: row.id,
    membershipVersion: row.version,
    status: row.status as PlatformMembershipRecord['status'],
    roles: granted,
    validUntil: row.valid_until,
  });
}
export function platformEvidenceQuery(value: PlatformMembershipEvidence, owner: TenantStoreBinding): PlatformMembershipLookup {
  tenantRecord(value, PLATFORM_EVIDENCE_KEYS);
  const query = platformLookup(
    { realm: value.realm, appId: value.appId, accountId: value.accountId, source: value.source, deployment: value.deployment },
    owner,
  );
  tenantIdentifier(value.membershipId, 1024);
  revision(value.membershipVersion);
  revision(value.platformVersion);
  roles(value.roles);
  time(value.verifiedAt);
  time(value.validUntil);
  return query;
}
/** The platform twin of assertCurrentRecord: the same membership, the same
 * platform row version, both still active, the roles not widened. */
export function assertCurrentPlatformRecord(
  value: PlatformMembershipEvidence,
  current: PlatformMembershipRecord | null,
  instant: number,
): void {
  if (
    instant < value.verifiedAt ||
    instant >= value.validUntil ||
    !current ||
    current.platformStatus !== 'active' ||
    current.status !== 'active' ||
    instant >= current.validUntil ||
    value.validUntil > current.validUntil ||
    current.membershipId !== value.membershipId ||
    current.membershipVersion !== value.membershipVersion ||
    current.platformVersion !== value.platformVersion ||
    current.roles.length !== value.roles.length ||
    current.roles.some((role) => !value.roles.includes(role))
  )
    denyTenant();
}

interface PlatformMembershipOptions<Request> {
  readonly ownership: TenantOwnershipSnapshot;
  readonly deployment: string;
  /** The platform realm's roles only. A tenant role never admits here. */
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly membership: {
    readonly source: TenantOwnershipSnapshot['source'];
    readonly read: (lookup: PlatformMembershipLookup) => PlatformMembershipRecord | null | Promise<PlatformMembershipRecord | null>;
  };
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts); absent, every admission reads. */
  readonly admissions?: AdmissionCache;
}

/** Capture sync results before yielding; custom thenables are not provider data. */
function delivered<T>(result: T | Promise<T>): T | Promise<T> {
  if (isPromise(result))
    return Promise.prototype.then.call(
      result,
      (value: T) => captureTenantData(value),
      () => denyTenant(),
    ) as Promise<T>;
  return captureTenantData(result);
}
function issuedRevision(value: unknown): void {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9][0-9]*)$/.test(value)) denyTenant();
}

/** The platform twin of createTenantMembershipIssuer: private single-source
 * admission with no selector, since the realm has exactly one row. The same
 * lifetime clamp, retirement drain and role ceiling apply. */
export function createPlatformMembershipIssuer<Request>(options: PlatformMembershipOptions<Request>) {
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
  const granted = captureTenantData(raw.roles);
  if (!Array.isArray(granted) || granted.length > 256) return denyTenant();
  for (const role of granted) tenantIdentifier(role);
  if (new Set(granted).size !== granted.length) return denyTenant();
  const allowed = new Set(granted);
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
  const read = membership.read as PlatformMembershipOptions<Request>['membership']['read'];
  const verify = raw.verifySession as PlatformMembershipOptions<Request>['verifySession'];
  const now = (raw.now ?? Date.now) as () => number;
  const clock = () => {
    const value = now();
    if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - maxLifetimeMs) return denyTenant();
    return value;
  };
  const admissions = raw.admissions as AdmissionCache | undefined;
  /** Kept evidence this admission may serve, as the tenant issuer's `usable`. */
  const usable = (kept: unknown, lookup: PlatformMembershipLookup, instant: number): PlatformMembershipEvidence | undefined => {
    if (!kept || typeof kept !== 'object' || (kept as { realm?: unknown }).realm !== 'platform') return undefined;
    const value = kept as PlatformMembershipEvidence;
    return value.appId === lookup.appId &&
      value.accountId === lookup.accountId &&
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
  /** The platform membership read in admission's own snapshot, as evidence. */
  const admit = async (lookup: PlatformMembershipLookup, started: number): Promise<PlatformMembershipEvidence> => {
    const beforeRead = clock();
    if (beforeRead < started || beforeRead >= started + maxLifetimeMs) return denyTenant();
    active();
    const membershipResult = delivered(read(lookup));
    const record = isPromise(membershipResult) ? await membershipResult : membershipResult;
    active();
    tenantRecord(record, [
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
      record.realm !== 'platform' ||
      record.appId !== lookup.appId ||
      record.accountId !== lookup.accountId ||
      record.status !== 'active' ||
      record.platformStatus !== 'active'
    )
      return denyTenant();
    tenantIdentifier(record.membershipId, 1024);
    issuedRevision(record.membershipVersion);
    issuedRevision(record.platformVersion);
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
      platformVersion: record.platformVersion,
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
    async retire(): Promise<void> {
      retired = true;
      await Promise.allSettled([...pending]);
    },
    /** Drop the kept evidence of this request's login in the platform realm: it met a refusal. */
    forget(request: Request, evidence: PlatformMembershipEvidence): void {
      admissions?.drop(admissions.find(request, evidence.accountId, PLATFORM_TENANT_ID).key);
    },
    /** As the tenant issuer's: `retry` admits afresh once when kept evidence
     * (tenantAdmissionCache.ts) meets a refusal in a callback that cannot
     * have written; `fresh` never serves kept evidence. */
    async withMembership<T>(
      request: Request,
      callback: (evidence: PlatformMembershipEvidence, kept: boolean) => T | Promise<T>,
      admission: { readonly retry?: boolean; readonly fresh?: boolean } = {},
    ): Promise<T> {
      active();
      if (typeof callback !== 'function') return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
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
          const lookup: PlatformMembershipLookup = captureTenantData({
            realm: 'platform',
            appId: ownership.appId,
            accountId: session.id,
            source: ownership.source,
            deployment,
          });
          const slot = admissions?.find(request, session.id, PLATFORM_TENANT_ID) ?? {};
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
      } catch {
        return denyTenant();
      } finally {
        pending.delete(held);
        finish();
      }
    },
  });
}
