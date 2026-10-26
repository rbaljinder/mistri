import { isDeepStrictEqual } from 'node:util';
import type { AdministrationTenantImage } from '../../shared/tenantAdministration.js';
import type { InvitationChange, InvitationIntent, InvitationPair } from '../../shared/tenantInvitations.js';
import type { AdministrationAudit, StoredAdministrationReceipt } from './tenantAdministrationJournal.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { captureInvitationIntent, invitationIssuePrincipal, invitationPrincipalEmail } from './tenantInvitationModel.js';
import { parseTenantSelector } from './tenantMembership.js';

function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  tenantRecord(value, [...fields, ...optional]);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function id(value: unknown, maximum = 256): asserts value is string {
  tenantIdentifier(value, maximum);
  if (Buffer.byteLength(value) > maximum || /[\uD800-\uDFFF]/u.test(value)) denyTenant();
}
function tenantId(value: unknown): asserts value is string {
  id(value, 128);
  parseTenantSelector([value]);
}
function uuid(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    denyTenant();
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim() || !/^[1-9][0-9]{0,127}$/.test(value)) denyTenant();
}
function next(value: string): string {
  const result = String(BigInt(value) + 1n);
  revision(result);
  return result;
}
function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
function roles(value: unknown, minimum = 1, maximum = 256): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || new Set(value).size !== value.length)
    return denyTenant();
  for (const role of value) id(role);
}
const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((role) => b.includes(role));
function tenantImage(value: unknown): asserts value is AdministrationTenantImage {
  exact(value, ['tenantId', 'status', 'version']);
  tenantId(value.tenantId);
  revision(value.version);
  if (!['active', 'suspended', 'closed'].includes(value.status as string)) denyTenant();
}
function pairImage(value: unknown): asserts value is InvitationPair {
  exact(value, ['invitation', 'membership']);
  const invitation = value.invitation,
    member = value.membership;
  exact(invitation, [
    'invitationId',
    'version',
    'tenantId',
    'membershipId',
    'accountId',
    'inviterId',
    'roles',
    'expectedTenantVersion',
    'policyId',
    'policyVersion',
    'issuanceOperation',
    'createdAt',
    'redeemUntil',
    'validUntil',
    'status',
  ]);
  uuid(invitation.invitationId);
  uuid(invitation.membershipId);
  tenantId(invitation.tenantId);
  id(invitation.accountId, 1024);
  id(invitation.inviterId, 1024);
  revision(invitation.version);
  revision(invitation.expectedTenantVersion);
  id(invitation.policyId);
  id(invitation.policyVersion);
  roles(invitation.roles);
  time(invitation.createdAt);
  time(invitation.redeemUntil);
  time(invitation.validUntil);
  if (
    !['issueInvitation', 'reissueInvitation'].includes(invitation.issuanceOperation as string) ||
    !['pending', 'accepted', 'revoked'].includes(invitation.status as string) ||
    invitation.createdAt >= invitation.redeemUntil ||
    invitation.redeemUntil > invitation.validUntil
  )
    return denyTenant();
  exact(member, ['membershipId', 'tenantId', 'accountId', 'status', 'version', 'roles', 'validUntil']);
  uuid(member.membershipId);
  tenantId(member.tenantId);
  id(member.accountId, 1024);
  revision(member.version);
  roles(member.roles);
  time(member.validUntil);
  if (
    member.membershipId !== invitation.membershipId ||
    member.tenantId !== invitation.tenantId ||
    member.accountId !== invitation.accountId ||
    member.validUntil !== invitation.validUntil ||
    !sameRoles(member.roles, invitation.roles) ||
    member.status !==
      ({ pending: 'invited', accepted: 'active', revoked: 'revoked' } as const)[invitation.status as 'pending' | 'accepted' | 'revoked']
  )
    denyTenant();
}
function changeImage(value: unknown): asserts value is InvitationChange {
  exact(value, ['operation', 'tenant', 'before', 'after'], ['revoked']);
  if (
    !['issueInvitation', 'revokeInvitation', 'acceptInvitation', 'reissueInvitation', 'claimInvitation'].includes(value.operation as string)
  )
    return denyTenant();
  tenantImage(value.tenant);
  pairImage(value.after);
  if (value.before !== null) pairImage(value.before);
  if (Object.hasOwn(value, 'revoked')) pairImage(value.revoked);
}
function pending(value: InvitationPair): void {
  if (value.invitation.status !== 'pending' || value.membership.status !== 'invited') denyTenant();
}
function transition(before: InvitationPair, after: InvitationPair, status: 'accepted' | 'revoked'): void {
  const invitation = before.invitation,
    member = before.membership;
  // Compare the complete immutable images, allowing only role-set ordering to differ.
  if (
    !isDeepStrictEqual(
      captureTenantData({ ...invitation, status, version: next(invitation.version), roles: after.invitation.roles }),
      after.invitation,
    ) ||
    !sameRoles(invitation.roles, after.invitation.roles) ||
    !isDeepStrictEqual(
      captureTenantData({
        ...member,
        status: status === 'accepted' ? 'active' : 'revoked',
        version: next(member.version),
        roles: after.membership.roles,
      }),
      after.membership,
    ) ||
    !sameRoles(member.roles, after.membership.roles)
  )
    denyTenant();
}

/** Pure historical validation: no clock, native account lookup, or current-state authority. */
export function captureInvitationChange(input: unknown, inputIntent: InvitationIntent, inputCeiling: readonly string[]): InvitationChange {
  const value = captureTenantData(input),
    intent = captureInvitationIntent(inputIntent),
    ceiling = captureTenantData(inputCeiling);
  roles(ceiling, 0, 65_536);
  changeImage(value);
  if (
    value.operation !== intent.operation ||
    value.tenant.tenantId !== intent.tenantId ||
    value.tenant.version !== intent.expectedTenantVersion
  )
    return denyTenant();
  for (const pair of [value.before, value.after, value.revoked]) {
    if (pair && (pair.invitation.tenantId !== intent.tenantId || pair.invitation.roles.some((role) => !ceiling.includes(role))))
      return denyTenant();
  }
  if (intent.operation !== 'reissueInvitation' && intent.operation !== 'claimInvitation' && Object.hasOwn(value, 'revoked'))
    return denyTenant();
  const after = value.after;
  if (intent.operation === 'issueInvitation' || intent.operation === 'reissueInvitation') {
    pending(after);
    if (
      value.tenant.status !== 'active' ||
      after.invitation.version !== '1' ||
      after.membership.version !== '1' ||
      after.invitation.expectedTenantVersion !== intent.expectedTenantVersion ||
      after.invitation.issuanceOperation !== intent.operation ||
      !sameRoles(after.invitation.roles, intent.roles) ||
      after.invitation.redeemUntil !== intent.redeemUntil ||
      after.invitation.validUntil !== intent.validUntil
    )
      return denyTenant();
  }
  if (intent.operation === 'issueInvitation') {
    if (value.before !== null || after.invitation.accountId !== invitationIssuePrincipal(intent)) return denyTenant();
  } else if (intent.operation === 'claimInvitation') {
    // The placeholder pair ends as reissue ends one; the same terms begin,
    // accepted, for a real account (tenantInvitationClaim.ts).
    const before = value.before;
    if (!before || !value.revoked) return denyTenant();
    pending(before);
    const was = before.invitation,
      now = after.invitation;
    if (
      was.invitationId !== intent.invitationId ||
      was.version !== intent.expectedInvitationVersion ||
      before.membership.membershipId !== intent.membershipId ||
      before.membership.version !== intent.expectedMembershipVersion ||
      invitationPrincipalEmail(was.accountId) === null ||
      invitationPrincipalEmail(now.accountId) !== null ||
      value.tenant.status !== 'active' ||
      was.expectedTenantVersion !== value.tenant.version ||
      now.expectedTenantVersion !== value.tenant.version ||
      now.invitationId === was.invitationId ||
      after.membership.membershipId === before.membership.membershipId ||
      now.status !== 'accepted' ||
      now.version !== '2' ||
      after.membership.status !== 'active' ||
      after.membership.version !== '1' ||
      now.inviterId !== was.inviterId ||
      now.policyId !== was.policyId ||
      now.policyVersion !== was.policyVersion ||
      now.issuanceOperation !== was.issuanceOperation ||
      !sameRoles(now.roles, was.roles) ||
      now.redeemUntil !== was.redeemUntil ||
      now.validUntil !== was.validUntil ||
      now.createdAt < was.createdAt ||
      now.createdAt >= now.redeemUntil
    )
      return denyTenant();
    transition(before, value.revoked, 'revoked');
  } else {
    const before = value.before;
    if (!before) return denyTenant();
    pending(before);
    if (
      before.invitation.invitationId !== intent.invitationId ||
      before.invitation.version !== intent.expectedInvitationVersion ||
      before.membership.membershipId !== intent.membershipId ||
      before.membership.version !== intent.expectedMembershipVersion
    )
      return denyTenant();
    if (intent.operation === 'reissueInvitation') {
      if (
        !value.revoked ||
        after.invitation.invitationId === before.invitation.invitationId ||
        after.membership.membershipId === before.membership.membershipId ||
        after.invitation.accountId !== before.invitation.accountId
      )
        return denyTenant();
      transition(before, value.revoked, 'revoked');
    } else {
      if (
        intent.operation === 'acceptInvitation' &&
        (value.tenant.status !== 'active' || before.invitation.expectedTenantVersion !== value.tenant.version)
      )
        return denyTenant();
      transition(before, after, intent.operation === 'acceptInvitation' ? 'accepted' : 'revoked');
    }
  }
  return value;
}

function parseJson(value: unknown, maximum: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) return denyTenant();
  try {
    return captureTenantData(JSON.parse(value));
  } catch {
    return denyTenant();
  }
}
function journalEnvelope(receipt: StoredAdministrationReceipt, audit: AdministrationAudit): void {
  exact(receipt, [
    'actorId',
    'tenantId',
    'operation',
    'operationVersion',
    'idempotencyKey',
    'id',
    'fingerprint',
    'resultJson',
    'requestId',
    'completedAt',
  ]);
  exact(audit, ['policyId', 'policyVersion', 'deployment', 'sessionId', 'changeJson']);
  id(receipt.actorId, 1024);
  tenantId(receipt.tenantId);
  id(receipt.id, 1024);
  id(receipt.requestId, 1024);
  id(receipt.idempotencyKey);
  id(receipt.fingerprint);
  id(receipt.completedAt, 32);
  id(audit.policyId);
  id(audit.policyVersion);
  id(audit.deployment);
  id(audit.sessionId, 1024);
  const completed = new Date(receipt.completedAt);
  if (!Number.isFinite(completed.getTime()) || completed.toISOString() !== receipt.completedAt || receipt.operationVersion !== 1)
    return denyTenant();
}
/** Journal envelopes carry a change directly, just like existing administration receipts. */
export function validateInvitationJournalPair(inputReceipt: StoredAdministrationReceipt, inputAudit: AdministrationAudit): void {
  const receipt = captureTenantData(inputReceipt),
    audit = captureTenantData(inputAudit);
  journalEnvelope(receipt, audit);
  const result = parseJson(receipt.resultJson, 16 * 1024),
    change = parseJson(audit.changeJson, 64 * 1024);
  changeImage(result);
  changeImage(change);
  if (receipt.operation !== result.operation || receipt.tenantId !== result.tenant.tenantId || !isDeepStrictEqual(result, change))
    return denyTenant();
  const common = { operation: result.operation, tenantId: result.tenant.tenantId, expectedTenantVersion: result.tenant.version };
  const terms = {
    roles: result.after.invitation.roles,
    redeemUntil: result.after.invitation.redeemUntil,
    validUntil: result.after.invitation.validUntil,
  };
  let intent: InvitationIntent;
  if (result.operation === 'issueInvitation') {
    const email = invitationPrincipalEmail(result.after.invitation.accountId);
    intent = captureInvitationIntent({
      ...common,
      ...(email === null ? { accountId: result.after.invitation.accountId } : { email }),
      ...terms,
    });
  } else {
    if (!result.before) return denyTenant();
    intent = captureInvitationIntent({
      ...common,
      invitationId: result.before.invitation.invitationId,
      expectedInvitationVersion: result.before.invitation.version,
      membershipId: result.before.membership.membershipId,
      expectedMembershipVersion: result.before.membership.version,
      ...(result.operation === 'reissueInvitation' ? terms : {}),
    });
  }
  const ceiling = [...new Set([result.before, result.after, result.revoked].flatMap((pair) => (pair ? pair.invitation.roles : [])))];
  const validated = captureInvitationChange(result, intent, ceiling),
    issuance = validated.after.invitation;
  if (
    validated.operation !== 'revokeInvitation' &&
    (audit.policyId !== issuance.policyId || audit.policyVersion !== issuance.policyVersion)
  )
    return denyTenant();
  if ((validated.operation === 'issueInvitation' || validated.operation === 'reissueInvitation') && receipt.actorId !== issuance.inviterId)
    return denyTenant();
  // A claim's actor is the account it accepted for: the after pair's, never the placeholder.
  if ((validated.operation === 'acceptInvitation' || validated.operation === 'claimInvitation') && receipt.actorId !== issuance.accountId)
    denyTenant();
}

/** Extend only linked direct revocations; existing unlinked history keeps its own validator. */
export function validateLinkedInvitationRevocation(inputReceipt: StoredAdministrationReceipt, inputAudit: AdministrationAudit): void {
  const receipt = captureTenantData(inputReceipt),
    audit = captureTenantData(inputAudit);
  tenantRecord(receipt);
  tenantRecord(audit);
  const result = parseJson(receipt.resultJson, 16 * 1024),
    change = parseJson(audit.changeJson, 64 * 1024);
  const linked = (value: unknown) => value !== null && typeof value === 'object' && Object.hasOwn(value, 'invitation');
  if (!linked(result) && !linked(change)) return;
  journalEnvelope(receipt, audit);
  exact(result, ['operation', 'before', 'after', 'invitation']);
  exact(change, ['operation', 'before', 'after', 'invitation']);
  if (!isDeepStrictEqual(result, change) || receipt.operation !== 'revokeMembership' || result.operation !== 'revokeMembership')
    return denyTenant();
  exact(result.before, ['tenant', 'membership']);
  exact(result.after, ['tenant', 'membership']);
  exact(result.invitation, ['before', 'after']);
  tenantImage(result.before.tenant);
  tenantImage(result.after.tenant);
  if (!isDeepStrictEqual(result.before.tenant, result.after.tenant) || receipt.tenantId !== result.before.tenant.tenantId)
    return denyTenant();
  const before = { invitation: result.invitation.before, membership: result.before.membership };
  const after = { invitation: result.invitation.after, membership: result.after.membership };
  pairImage(before);
  pairImage(after);
  const intent = captureInvitationIntent({
    operation: 'revokeInvitation',
    tenantId: result.before.tenant.tenantId,
    expectedTenantVersion: result.before.tenant.version,
    invitationId: before.invitation.invitationId,
    expectedInvitationVersion: before.invitation.version,
    membershipId: before.membership.membershipId,
    expectedMembershipVersion: before.membership.version,
  });
  captureInvitationChange({ operation: 'revokeInvitation', tenant: result.before.tenant, before, after }, intent, [
    ...new Set([...before.invitation.roles, ...after.invitation.roles]),
  ]);
}
