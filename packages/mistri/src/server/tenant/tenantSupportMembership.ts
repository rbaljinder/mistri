/** Private linked support facts. None of these data objects grant admission. */
import { isDeepStrictEqual } from 'node:util';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import type { SupportMembershipEvidence } from './tenantSupportLease.js';
import { binding, revision, roles, time, type TenantStoreBinding } from './tenantStoreContract.js';

export interface SupportMembershipLookup {
  readonly supportId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly at: number;
}
export interface SupportMembershipObservation {
  readonly stage: 'support-membership-observation';
  readonly authorization: 'pending';
  readonly binding: TenantStoreBinding;
  readonly supportId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly tenantVersion: string;
  readonly supportVersion: string;
  readonly parentId: string;
  readonly parentVersion: string;
  readonly platformVersion: string;
  readonly roles: readonly string[];
  readonly supportValidUntil: number;
  readonly parentValidUntil: number;
  readonly validUntil: number;
  readonly observedAt: number;
}

function id(value: unknown, maximum = 1024): asserts value is string {
  tenantIdentifier(value, maximum);
  if (/\p{Cs}/u.test(value)) denyTenant();
}
export function captureSupportLookup(input: SupportMembershipLookup): SupportMembershipLookup {
  const value = captureTenantData(input);
  tenantRecord(value, ['supportId', 'accountId', 'tenantId', 'at']);
  id(value.supportId);
  id(value.accountId);
  id(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  time(value.at);
  return Object.freeze(value);
}
const row = (input: unknown): Record<string, unknown> => {
  const value = captureTenantData(input);
  tenantRecord(value);
  return value;
};
function nativeTime(value: unknown): number {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return denyTenant();
    value = Number(value);
  }
  time(value);
  return value;
}
/** An unlocked PG locator is not evidence; the locked row must match it later. */
export function supportParentLocator(input: unknown, lookup: SupportMembershipLookup): string {
  const value = row(input);
  if (
    value.id !== lookup.supportId ||
    value.account_id !== lookup.accountId ||
    value.tenant_id !== lookup.tenantId ||
    value.kind !== 'support' ||
    value.status !== 'active'
  )
    return denyTenant();
  id(value.parent_id);
  return value.parent_id;
}

export function supportMembershipObservation(
  owner: TenantStoreBinding,
  lookup: SupportMembershipLookup,
  supportInput: unknown,
  parentInput: unknown,
  platformInput: unknown,
  tenantInput: unknown,
  locatedParent: string,
): SupportMembershipObservation {
  owner = binding(owner);
  lookup = captureSupportLookup(lookup);
  const support = row(supportInput),
    parent = row(parentInput),
    platform = row(platformInput),
    tenant = row(tenantInput);
  if (
    supportParentLocator(support, lookup) !== locatedParent ||
    parent.id !== locatedParent ||
    parent.kind !== 'member' ||
    parent.account_id !== lookup.accountId ||
    parent.tenant_id !== '@platform' ||
    parent.status !== 'active' ||
    parent.parent_id !== null ||
    parent.parent_version !== null ||
    parent.platform_version !== null ||
    platform.id !== '@platform' ||
    platform.kind !== 'platform' ||
    platform.status !== 'active' ||
    tenant.id !== lookup.tenantId ||
    tenant.kind !== 'tenant' ||
    tenant.status !== 'active'
  )
    return denyTenant();
  for (const value of [support.version, support.parent_version, support.platform_version, parent.version, platform.version, tenant.version])
    revision(value);
  if (support.parent_version !== parent.version || support.platform_version !== platform.version) return denyTenant();
  const supportValidUntil = nativeTime(support.valid_until),
    parentValidUntil = nativeTime(parent.valid_until);
  const validUntil = Math.min(supportValidUntil, parentValidUntil);
  if (lookup.at >= validUntil || typeof support.roles_json !== 'string' || typeof parent.roles_json !== 'string') return denyTenant();
  let supportRoles: unknown, parentRoles: unknown;
  try {
    supportRoles = JSON.parse(support.roles_json);
    parentRoles = JSON.parse(parent.roles_json);
  } catch {
    return denyTenant();
  }
  roles(supportRoles);
  roles(parentRoles);
  if (!supportRoles.length) return denyTenant();
  for (const value of [...supportRoles, ...parentRoles]) id(value);
  return Object.freeze({
    stage: 'support-membership-observation',
    authorization: 'pending',
    binding: Object.freeze({ ...owner, source: Object.freeze({ ...owner.source }) }),
    supportId: lookup.supportId,
    accountId: lookup.accountId,
    tenantId: lookup.tenantId,
    tenantVersion: tenant.version as string,
    supportVersion: support.version as string,
    parentId: locatedParent,
    parentVersion: parent.version as string,
    platformVersion: platform.version as string,
    roles: Object.freeze([...supportRoles]),
    supportValidUntil,
    parentValidUntil,
    validUntil,
    observedAt: lookup.at,
  });
}

/**
 * The observed row must be the very session the evidence names, still live, and
 * no wider: one role, and the versions it was admitted on.
 *
 * One rule, used by every support fence — the audited writer's and the read
 * source's alike. A second copy of this comparison could drift from the first,
 * and a drift here is not a failing test but a session reading or writing on
 * versions it was never admitted for.
 */
export function assertSupportEvidenceObserved(
  observed: SupportMembershipObservation,
  evidence: Readonly<{
    supportId: string;
    accountId: string;
    tenantId: string;
    membershipVersion: string;
    tenantVersion: string;
    parentId: string;
    parentVersion: string;
    platformVersion: string;
    roles: readonly string[];
    validUntil: number;
  }>,
  at: number,
): void {
  if (
    observed.supportId !== evidence.supportId ||
    observed.accountId !== evidence.accountId ||
    observed.tenantId !== evidence.tenantId ||
    observed.supportVersion !== evidence.membershipVersion ||
    observed.tenantVersion !== evidence.tenantVersion ||
    observed.parentId !== evidence.parentId ||
    observed.parentVersion !== evidence.parentVersion ||
    observed.platformVersion !== evidence.platformVersion ||
    observed.roles.length !== 1 ||
    observed.roles[0] !== evidence.roles[0] ||
    at >= observed.validUntil ||
    evidence.validUntil > observed.validUntil
  )
    denyTenant();
}

/** Comparison of captured facts, not authenticity verification or permission. */
export function assertSupportObservationCurrent(
  expected: SupportMembershipObservation,
  current: SupportMembershipObservation,
  at: number,
): void {
  const previous = captureTenantData(expected),
    fresh = captureTenantData(current);
  time(at);
  const fields = [
    'stage',
    'authorization',
    'binding',
    'supportId',
    'accountId',
    'tenantId',
    'tenantVersion',
    'supportVersion',
    'parentId',
    'parentVersion',
    'platformVersion',
    'roles',
    'supportValidUntil',
    'parentValidUntil',
    'validUntil',
    'observedAt',
  ];
  for (const value of [previous, fresh]) {
    tenantRecord(value, fields);
    if (value.stage !== 'support-membership-observation' || value.authorization !== 'pending') return denyTenant();
    binding(value.binding);
    captureSupportLookup({ supportId: value.supportId, accountId: value.accountId, tenantId: value.tenantId, at: value.observedAt });
    id(value.parentId);
    roles(value.roles);
    if (!value.roles.length) return denyTenant();
    for (const role of value.roles) id(role);
    for (const name of ['tenantVersion', 'supportVersion', 'parentVersion', 'platformVersion'] as const) revision(value[name]);
    for (const name of ['supportValidUntil', 'parentValidUntil', 'validUntil'] as const) time(value[name]);
    if (value.validUntil !== Math.min(value.supportValidUntil, value.parentValidUntil)) return denyTenant();
  }
  const { observedAt: before, ...a } = previous,
    { observedAt: after, ...b } = fresh;
  if (!isDeepStrictEqual(a, b) || after < before || at < after || at >= fresh.validUntil) denyTenant();
}

/**
 * A support session's evidence as the tenant scope composer and the App's own
 * row rules read it: the dealer it is inside, and the one dealer role it holds.
 * This is a view, not a second kind of membership — nothing admits on it, and
 * the fence that admits is the support row itself. It exists so that a dealer's
 * rows are governed by one policy rule rather than two that can disagree; a
 * second rule would surface as a leak, not as a failing test. Both the read
 * source and the support read runtime compose scope through this one view.
 */
export function supportAsMember(evidence: SupportMembershipEvidence): TenantMembershipEvidence {
  return {
    appId: evidence.appId,
    accountId: evidence.accountId,
    tenantId: evidence.tenantId,
    source: evidence.source,
    deployment: evidence.deployment,
    membershipId: evidence.membershipId,
    membershipVersion: evidence.membershipVersion,
    tenantVersion: evidence.tenantVersion,
    roles: [...evidence.roles],
    verifiedAt: evidence.verifiedAt,
    validUntil: evidence.validUntil,
  };
}
