/** Strict historical support changes, not policy admission or MAC verification.
 * The future native owner supplies times, current roles and transaction authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import { binding, nextRevision, revision, roles, time, type TenantStoreBinding } from './tenantStoreContract.js';
import { validateSupportSession, validateSupportInstant, SUPPORT_REASON_BYTES, type SupportSession } from './tenantSupportAuditContract.js';
import {
  identifier,
  validateAudit,
  validateReceipt,
  type AdministrationAudit,
  type StoredAdministrationReceipt,
} from './tenantAdministrationJournalValidation.js';

/** One platform role's reach: which dealers (`'all'` means every ACTIVE
 * dealer) and which of their roles a session there may hold, one at a time. */
interface SupportGrant {
  readonly platformRole: string;
  readonly tenants: 'all' | readonly string[];
  readonly dealerRoles: readonly string[];
}
/** The `support` block of a tenant policy. Policy is explicit operator
 * configuration, not a proof: timing is fixed in code, not here. */
export interface SupportPolicy {
  readonly id: string;
  readonly version: string;
  readonly grants: readonly SupportGrant[];
}
export type SupportIntent =
  | { readonly operation: 'openSupport'; readonly tenantId: string; readonly dealerRole: string; readonly reason: string }
  | { readonly operation: 'exitSupport'; readonly tenantId: string; readonly supportId: string; readonly expectedSupportVersion: string };
export interface SupportPair {
  readonly membership: {
    readonly membershipId: string;
    readonly tenantId: string;
    readonly accountId: string;
    readonly kind: 'support';
    readonly version: string;
    readonly status: 'active' | 'revoked';
    readonly roles: readonly string[];
    readonly validUntil: number;
    readonly parentId: string;
    readonly parentVersion: string;
    readonly platformVersion: string;
  };
  readonly session: SupportSession & { readonly endedAt: string | null; readonly endReason: 'exit' | 'superseded' | null };
}
export type SupportChange =
  | {
      readonly operation: 'openSupport';
      readonly after: SupportPair;
      readonly replaced: { readonly before: SupportPair; readonly after: SupportPair } | null;
    }
  | { readonly operation: 'exitSupport'; readonly before: SupportPair; readonly after: SupportPair };

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, fields);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function tenant(value: unknown): asserts value is string {
  identifier(value, 128);
  parseTenantSelector([value]);
}
const utf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function names(value: unknown, maximum: number, check: (item: unknown) => void): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) return denyTenant();
  for (const item of value) {
    check(item);
    if (item === '*') denyTenant();
  }
  if (new Set(value).size !== value.length) return denyTenant();
  return [...(value as string[])].sort(utf8);
}
/** Closed policy shape only; the App's role realms and the caller's native
 * membership are checked by startup and by the owner. Duplicates refuse
 * rather than normalise a possibly mistaken policy. One grant per platform
 * role: its reach is read in one place, never merged from two. */
export function captureSupportPolicy(input: unknown): SupportPolicy {
  const value = captureTenantData(input);
  exact(value, ['id', 'version', 'grants']);
  identifier(value.id);
  identifier(value.version);
  // Recorded for the operator's console alone (evidence.ts): what is wrong, which the fixed sentence never named.
  const refuse = (reason: string): never => denyTenant(new Error(`The tenant policy's support.${reason}`));
  if (!Array.isArray(value.grants) || !value.grants.length || value.grants.length > 256)
    return refuse('grants is a list of 1 to 256 { platformRole, tenants, dealerRoles }.');
  const seen = new Set<string>();
  const grants = value.grants.map((grant) => {
    exact(grant, ['platformRole', 'tenants', 'dealerRoles']);
    identifier(grant.platformRole);
    if (grant.platformRole === '*') return refuse('grants names platformRole "*"; it names one platform role.');
    if (seen.has(grant.platformRole)) return refuse(`grants names platform role "${grant.platformRole}" twice; one grant per role.`);
    seen.add(grant.platformRole);
    return {
      platformRole: grant.platformRole,
      tenants: grant.tenants === 'all' ? ('all' as const) : names(grant.tenants, 1024, tenant),
      dealerRoles: names(grant.dealerRoles, 256, (role) => identifier(role)),
    };
  });
  grants.sort((a, b) => utf8(a.platformRole, b.platformRole));
  return captureTenantData({ id: value.id, version: value.version, grants });
}
/** One grant, matched whole: a role the parent holds, this dealer, this dealer
 * role. No role is unioned from two grants or from the platform role itself. */
export function supportGranted(policy: SupportPolicy, platformRoles: readonly string[], tenantId: string, dealerRole: string): boolean {
  return policy.grants.some(
    (grant) =>
      platformRoles.includes(grant.platformRole) &&
      (grant.tenants === 'all' || grant.tenants.includes(tenantId)) &&
      grant.dealerRoles.includes(dealerRole),
  );
}

/** The exact open or exit a browser asked for, validated before any wait. */
export function captureSupportIntent(input: unknown): SupportIntent {
  return intent(input);
}
function intent(input: unknown): SupportIntent {
  const value = captureTenantData(input);
  tenantRecord(value);
  if (value.operation === 'openSupport') {
    exact(value, ['operation', 'tenantId', 'dealerRole', 'reason']);
    tenant(value.tenantId);
    identifier(value.dealerRole);
    identifier(value.reason, SUPPORT_REASON_BYTES);
    if (value.dealerRole === '*' || !value.reason.trim()) return denyTenant();
  } else if (value.operation === 'exitSupport') {
    exact(value, ['operation', 'tenantId', 'supportId', 'expectedSupportVersion']);
    tenant(value.tenantId);
    identifier(value.supportId, 1024);
    revision(value.expectedSupportVersion);
  } else return denyTenant();
  return value as unknown as SupportIntent;
}

function pair(value: unknown): asserts value is SupportPair {
  exact(value, ['membership', 'session']);
  const member = value.membership;
  exact(member, [
    'membershipId',
    'tenantId',
    'accountId',
    'kind',
    'version',
    'status',
    'roles',
    'validUntil',
    'parentId',
    'parentVersion',
    'platformVersion',
  ]);
  identifier(member.membershipId, 1024);
  identifier(member.accountId, 1024);
  tenant(member.tenantId);
  identifier(member.parentId, 1024);
  revision(member.version);
  revision(member.parentVersion);
  revision(member.platformVersion);
  roles(member.roles);
  time(member.validUntil);
  if (member.kind !== 'support' || !['active', 'revoked'].includes(member.status as string) || member.roles.length !== 1)
    return denyTenant();
  identifier(member.roles[0]);
  tenantRecord(value.session);
  const { endedAt, endReason, ...fixed } = value.session;
  // Existing storage validator checks the complete fixed header, including extras.
  validateSupportSession(fixed as unknown as SupportSession);
  if (endedAt !== null) validateSupportInstant(endedAt);
  if (
    member.membershipId !== fixed.id ||
    member.tenantId !== fixed.tenantId ||
    member.accountId !== fixed.accountId ||
    member.roles[0] !== fixed.dealerRole ||
    member.validUntil !== fixed.validUntil ||
    member.parentId !== fixed.parentMembershipId ||
    member.parentVersion !== fixed.parentMembershipVersion ||
    member.platformVersion !== fixed.platformVersion
  )
    return denyTenant();
  const opened = Date.parse(fixed.openedAt as string);
  time(opened);
  if (!(fixed.reason as string).trim() || member.validUntil <= opened || member.validUntil - opened > 1800000) return denyTenant();
  if (member.status === 'active') {
    if (endedAt !== null || endReason !== null) return denyTenant();
  } else if (typeof endedAt !== 'string' || !['exit', 'superseded'].includes(endReason as string) || Date.parse(endedAt) < opened)
    return denyTenant();
}

function closure(before: SupportPair, after: SupportPair, endReason: 'exit' | 'superseded'): void {
  if (before.membership.status !== 'active' || after.membership.status !== 'revoked' || after.session.endReason !== endReason)
    return denyTenant();
  const expected = captureTenantData({
    membership: { ...before.membership, status: 'revoked', version: nextRevision(before.membership.version) },
    session: { ...before.session, endedAt: after.session.endedAt, endReason },
  });
  if (!isDeepStrictEqual(expected, after)) denyTenant();
}

/** Exact historical transitions. No current clock, eligibility, policy grant or database read. */
export function captureSupportChange(input: unknown, requested: unknown): SupportChange {
  const value = captureTenantData(input),
    expected = intent(requested);
  exact(value, expected.operation === 'openSupport' ? ['operation', 'after', 'replaced'] : ['operation', 'before', 'after']);
  if (value.operation !== expected.operation) return denyTenant();
  pair(value.after);
  const after = value.after;
  if (after.membership.tenantId !== expected.tenantId) return denyTenant();
  if (expected.operation === 'openSupport') {
    if (
      after.membership.version !== '1' ||
      after.membership.status !== 'active' ||
      after.session.dealerRole !== expected.dealerRole ||
      after.session.reason !== expected.reason
    )
      return denyTenant();
    if (value.replaced !== null) {
      exact(value.replaced, ['before', 'after']);
      pair(value.replaced.before);
      pair(value.replaced.after);
      closure(value.replaced.before, value.replaced.after, 'superseded');
      if (
        value.replaced.after.membership.accountId !== after.membership.accountId ||
        value.replaced.after.membership.membershipId === after.membership.membershipId ||
        value.replaced.after.session.endedAt !== after.session.openedAt
      )
        return denyTenant();
    }
  } else {
    pair(value.before);
    closure(value.before, after, 'exit');
    if (value.before.membership.membershipId !== expected.supportId || value.before.membership.version !== expected.expectedSupportVersion)
      return denyTenant();
  }
  return value as unknown as SupportChange;
}

/** Not wired to the journal yet. Validates attribution and matching durable images only. */
export function validateSupportJournalPair(inputReceipt: StoredAdministrationReceipt, inputAudit: AdministrationAudit): void {
  try {
    const receipt = captureTenantData(inputReceipt),
      audit = captureTenantData(inputAudit);
    validateReceipt(receipt);
    validateAudit(audit);
    const result = captureTenantData(JSON.parse(receipt.resultJson)),
      change = captureTenantData(JSON.parse(audit.changeJson));
    tenantRecord(result);
    pair(result.after);
    let requested: SupportIntent;
    if (result.operation === 'openSupport')
      requested = {
        operation: 'openSupport',
        tenantId: result.after.membership.tenantId,
        dealerRole: result.after.session.dealerRole,
        reason: result.after.session.reason,
      };
    else {
      pair(result.before);
      requested = {
        operation: 'exitSupport',
        tenantId: result.before.membership.tenantId,
        supportId: result.before.membership.membershipId,
        expectedSupportVersion: result.before.membership.version,
      };
    }
    const valid = captureSupportChange(result, requested),
      session = valid.after.session;
    // An opening is recorded where it ran. An exit may run in a later
    // deployment (every restart is a new one) than the session opened in.
    if (
      !isDeepStrictEqual(result, change) ||
      receipt.operation !== valid.operation ||
      receipt.operationVersion !== 1 ||
      receipt.actorId !== session.accountId ||
      receipt.tenantId !== session.tenantId ||
      audit.sessionId !== session.nativeSessionId ||
      (valid.operation === 'openSupport' && audit.deployment !== session.deployment) ||
      audit.policyId !== session.policyId ||
      audit.policyVersion !== session.policyVersion ||
      receipt.completedAt !== (valid.operation === 'openSupport' ? session.openedAt : session.endedAt) ||
      (valid.operation === 'openSupport' && receipt.id !== session.openReceiptId)
    )
      return denyTenant();
  } catch {
    return denyTenant();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(utf8)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Complete captured operation scope, never a credential, current grant or idempotency lookup. */
export function supportFingerprint(input: {
  binding: TenantStoreBinding;
  deployment: string;
  actorId: string;
  nativeSessionId: string;
  policy: unknown;
  intent: unknown;
}): string {
  const value = captureTenantData(input);
  exact(value, ['binding', 'deployment', 'actorId', 'nativeSessionId', 'policy', 'intent']);
  const owner = binding(value.binding as TenantStoreBinding),
    policy = captureSupportPolicy(value.policy),
    requested = intent(value.intent);
  identifier(value.deployment);
  identifier(value.actorId, 1024);
  identifier(value.nativeSessionId, 1024);
  return createHash('sha256')
    .update(
      canonical({
        domain: 'mistri.support-operation.v1',
        binding: owner,
        deployment: value.deployment,
        actorId: value.actorId,
        nativeSessionId: value.nativeSessionId,
        policy,
        intent: requested,
      }),
    )
    .digest('hex');
}
