import { createHash } from 'node:crypto';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantStoreBinding } from './tenantStore.js';
import {
  INVITATION_EMAIL_PRINCIPAL,
  INVITATION_ISSUER_OPERATIONS,
  type InvitationIntent,
  type InvitationIssuerOperation,
} from '../../shared/tenantInvitations.js';
import { nativeAccountEmail } from '../auth/authAccounts.js';
import { captureDelegates, type DelegateRule } from './tenantDelegation.js';

export interface InvitationPolicy {
  readonly id: string;
  readonly version: string;
  readonly maxMembershipLifetimeMs: number;
  readonly maxRedemptionLifetimeMs: number;
  /** Pending rows include expired reservations until explicit revoke/reissue. */
  readonly maxPendingPerTenant: number;
  readonly operators: readonly {
    readonly accountId: string;
    readonly tenants: readonly string[];
    readonly operations: readonly InvitationIssuerOperation[];
    readonly roles: readonly string[];
  }[];
  /** A tenant's own members issuing its invitations (tenantDelegation.ts). */
  readonly delegates?: readonly DelegateRule<InvitationIssuerOperation>[];
}
type InvitationGrant = InvitationPolicy['operators'][number];
const day = 24 * 60 * 60 * 1000;
const common = ['operation', 'tenantId', 'expectedTenantVersion'];
const pair = ['invitationId', 'expectedInvitationVersion', 'membershipId', 'expectedMembershipVersion'];
const terms = ['roles', 'redeemUntil', 'validUntil'];
const fields = {
  issueInvitation: [...common, 'accountId', ...terms],
  revokeInvitation: [...common, ...pair],
  reissueInvitation: [...common, ...pair, ...terms],
  acceptInvitation: [...common, ...pair],
  claimInvitation: [...common, ...pair],
} as const;
/** The email variant of issuance names an address where the account variant names an id. */
const emailIssue = [...common, 'email', ...terms];

/* An email invitation's reservation is held for the address's principal,
   `email:<address>`. No native account can be one: Better Auth's ids are
   generated and never hold a colon, and an account-id intent may not name one. */
function invitationEmailPrincipal(email: string): string {
  return `${INVITATION_EMAIL_PRINCIPAL}${nativeAccountEmail(email)}`;
}
/** The invited address, when this is an email invitation's principal; null for an account id. */
export function invitationPrincipalEmail(accountId: string): string | null {
  if (!accountId.startsWith(INVITATION_EMAIL_PRINCIPAL)) return null;
  const email = accountId.slice(INVITATION_EMAIL_PRINCIPAL.length);
  try {
    return nativeAccountEmail(email) === email ? email : denyTenant();
  } catch {
    return denyTenant();
  }
}
/** The principal an issuance intent reserves for. */
export function invitationIssuePrincipal(intent: InvitationIntent): string {
  if (intent.operation !== 'issueInvitation') return denyTenant();
  return 'email' in intent ? invitationEmailPrincipal(intent.email) : intent.accountId;
}

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, fields);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function id(value: unknown, maximum = 256): asserts value is string {
  tenantIdentifier(value, maximum);
  if (Buffer.byteLength(value) > maximum || /[\uD800-\uDFFF]/u.test(value)) denyTenant();
}
function revision(value: unknown): void {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,127}$/.test(value)) denyTenant();
}
function uuid(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) denyTenant();
}
function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
function roles(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || new Set(value).size !== value.length) return denyTenant();
  for (const entry of value) id(entry);
}
function grant(value: unknown): asserts value is InvitationGrant {
  exact(value, ['accountId', 'tenants', 'operations', 'roles']);
  id(value.accountId, 1024);
  if (
    !Array.isArray(value.tenants) ||
    !value.tenants.length ||
    value.tenants.length > 256 ||
    new Set(value.tenants).size !== value.tenants.length
  )
    return denyTenant();
  for (const tenant of value.tenants) {
    id(tenant, 128);
    parseTenantSelector([tenant]);
  }
  if (
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > 3 ||
    new Set(value.operations).size !== value.operations.length ||
    value.operations.some((op) => !INVITATION_ISSUER_OPERATIONS.includes(op))
  )
    return denyTenant();
  roles(value.roles);
}
/* A policy's refusal names its key and its limit, recorded for the operator's console alone (evidence.ts): the fixed
   tenant sentence named nothing, and a seven-day cap was found by reading dist. */
const policyRefusal = (reason: string): never => denyTenant(new Error(`The tenant policy's invitations.${reason}`));
const days = (ms: number) => `${ms / day} days (${ms} ms)`;
export function captureInvitationPolicy(input: unknown): InvitationPolicy {
  const value = captureTenantData(input);
  const delegated = !!value && typeof value === 'object' && Object.hasOwn(value, 'delegates');
  const keys = [
    'id',
    'version',
    'maxMembershipLifetimeMs',
    'maxRedemptionLifetimeMs',
    'maxPendingPerTenant',
    'operators',
    ...(delegated ? ['delegates'] : []),
  ];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const missing = keys.filter((key) => !Object.hasOwn(value, key));
    const unknown = Object.keys(value).filter((key) => !keys.includes(key) && key !== 'delegates');
    if (missing.length) policyRefusal(`${missing[0]} is missing: it takes ${keys.join(', ')} (and delegates).`);
    if (unknown.length) policyRefusal(`${unknown[0]} is not a key it takes: ${keys.join(', ')} (and delegates).`);
  }
  exact(value, keys);
  id(value.id);
  id(value.version);
  const within = (key: 'maxMembershipLifetimeMs' | 'maxRedemptionLifetimeMs' | 'maxPendingPerTenant', most: number, say: string) => {
    const given = value[key];
    if (typeof given !== 'number' || !Number.isSafeInteger(given) || given < 1 || given > most)
      policyRefusal(`${key} is ${JSON.stringify(given)}; it is a whole number from 1 to ${say}.`);
  };
  within('maxMembershipLifetimeMs', 366 * day, days(366 * day));
  within('maxRedemptionLifetimeMs', 7 * day, `${days(7 * day)}: an invitation is redeemable for a week at most`);
  within('maxPendingPerTenant', 10_000, '10000');
  if (delegated) captureDelegates(value.delegates, INVITATION_ISSUER_OPERATIONS);
  // With delegates, a policy may name no operator at all; without, it grants nothing and is refused.
  const operators = Array.isArray(value.operators)
    ? (value.operators as unknown[])
    : policyRefusal('operators is a list of { accountId, tenants, operations, roles }.');
  if (!operators.length && !delegated) policyRefusal('operators is empty and there are no delegates, so it grants nothing.');
  if (operators.length > 256) policyRefusal(`operators names ${operators.length} grants; at most 256.`);
  const previous: InvitationGrant[] = [];
  for (const entry of operators) {
    grant(entry);
    if (
      previous.some(
        (other) =>
          other.accountId === entry.accountId &&
          other.tenants.some((tenant) => entry.tenants.includes(tenant)) &&
          other.operations.some((op) => entry.operations.includes(op)),
      )
    )
      return policyRefusal(`operators grants ${entry.accountId} the same operation on the same tenant twice.`);
    previous.push(entry);
  }
  return value as unknown as InvitationPolicy;
}
/** No token, recipient identity assertion or caller-selected policy enters intent. */
export function captureInvitationIntent(input: unknown): InvitationIntent {
  const value = captureTenantData(input);
  tenantRecord(value);
  if (typeof value.operation !== 'string' || !Object.hasOwn(fields, value.operation)) return denyTenant();
  const operation = value.operation as InvitationIntent['operation'];
  const byEmail = operation === 'issueInvitation' && Object.hasOwn(value, 'email');
  exact(value, byEmail ? emailIssue : fields[operation]);
  id(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  revision(value.expectedTenantVersion);
  if (byEmail) {
    // Exactly as the account will be created: lower-cased, one canonical spelling.
    let email: string;
    try {
      email = nativeAccountEmail(value.email);
    } catch {
      return denyTenant();
    }
    if (email !== value.email) return denyTenant();
  } else if (operation === 'issueInvitation') {
    id(value.accountId, 1024);
    // An email principal is reserved by the email variant alone.
    if ((value.accountId as string).startsWith(INVITATION_EMAIL_PRINCIPAL)) return denyTenant();
  } else {
    uuid(value.invitationId);
    uuid(value.membershipId);
    revision(value.expectedInvitationVersion);
    revision(value.expectedMembershipVersion);
  }
  if (operation === 'issueInvitation' || operation === 'reissueInvitation') {
    roles(value.roles);
    time(value.redeemUntil);
    time(value.validUntil);
    if (value.redeemUntil > value.validUntil) return denyTenant();
  }
  return value as unknown as InvitationIntent;
}
export function invitationGrant(
  policy: InvitationPolicy,
  accountId: string,
  tenantId: string,
  operation: InvitationIssuerOperation,
): InvitationGrant {
  const captured = captureInvitationPolicy(policy);
  id(accountId, 1024);
  id(tenantId, 128);
  parseTenantSelector([tenantId]);
  if (!INVITATION_ISSUER_OPERATIONS.includes(operation)) return denyTenant();
  return (
    captured.operators.find(
      (entry) => entry.accountId === accountId && entry.tenants.includes(tenantId) && entry.operations.includes(operation),
    ) ?? denyTenant()
  );
}
/** The explicit operator grant, or null: a delegate's is read from the store. */
export function invitationOperatorGrant(
  policy: InvitationPolicy,
  accountId: string,
  tenantId: string,
  operation: InvitationIssuerOperation,
): InvitationGrant | null {
  const captured = captureInvitationPolicy(policy);
  id(accountId, 1024);
  id(tenantId, 128);
  parseTenantSelector([tenantId]);
  if (!INVITATION_ISSUER_OPERATIONS.includes(operation)) return denyTenant();
  return (
    captured.operators.find(
      (entry) => entry.accountId === accountId && entry.tenants.includes(tenantId) && entry.operations.includes(operation),
    ) ?? null
  );
}
/** Exact operation grant, not a union of issue/reissue/revoke role ceilings. */
export function assertInvitationTerms(
  policy: InvitationPolicy,
  accountId: string,
  tenantId: string,
  operation: InvitationIssuerOperation,
  requested: readonly string[],
  redeemUntil: number,
  validUntil: number,
  now: number,
): void {
  assertInvitationTermsWithin(
    policy,
    invitationGrant(policy, accountId, tenantId, operation).roles,
    requested,
    redeemUntil,
    validUntil,
    now,
  );
}
/** The same terms within a ceiling the caller established: an operator's
 * grant, or the one a delegate's own membership earned. */
export function assertInvitationTermsWithin(
  policy: InvitationPolicy,
  ceilingRoles: readonly string[],
  requested: readonly string[],
  redeemUntil: number,
  validUntil: number,
  now: number,
): void {
  const captured = captureInvitationPolicy(policy);
  const ceiling = { roles: captureTenantData(ceilingRoles) };
  roles(ceiling.roles);
  const requestedRoles = captureTenantData(requested);
  roles(requestedRoles);
  time(redeemUntil);
  time(validUntil);
  time(now);
  if (
    requestedRoles.some((role) => !ceiling.roles.includes(role)) ||
    redeemUntil <= now ||
    validUntil < redeemUntil ||
    now > Number.MAX_SAFE_INTEGER - captured.maxRedemptionLifetimeMs ||
    now > Number.MAX_SAFE_INTEGER - captured.maxMembershipLifetimeMs ||
    redeemUntil > now + captured.maxRedemptionLifetimeMs ||
    validUntil > now + captured.maxMembershipLifetimeMs
  )
    denyTenant();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function invitationFingerprint(policy: InvitationPolicy, binding: TenantStoreBinding, input: InvitationIntent): string {
  const captured = captureInvitationPolicy(policy),
    owner = captureTenantData(binding),
    intent = captureInvitationIntent(input);
  exact(owner, ['appId', 'source', 'storeId']);
  id(owner.appId);
  id(owner.storeId);
  exact(owner.source, ['id', 'connection']);
  id(owner.source.id);
  id(owner.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(owner.source.id)) return denyTenant();
  return createHash('sha256')
    .update(
      canonical({
        domain: 'mistri:tenant-invitation-attempt:v1',
        policy: { id: captured.id, version: captured.version },
        binding: { appId: owner.appId, storeId: owner.storeId, sourceId: owner.source.id },
        intent: 'roles' in intent ? { ...intent, roles: [...intent.roles].sort() } : intent,
      }),
    )
    .digest('hex');
}
