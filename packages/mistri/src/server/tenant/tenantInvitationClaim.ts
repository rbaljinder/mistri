/**
 * Claiming an account-creating invitation. An invitation issued to an email
 * address reserves its membership for the address's principal,
 * `email:<address>`, which no native account can ever be (Better Auth's ids
 * are generated and never hold a colon), so the reservation admits nobody. A
 * claim is the one step that turns it into a real account's membership: in
 * one administration transaction, after every fence the caller holds, the
 * placeholder pair ends — revoked, exactly as reissue ends a pair — and the
 * same terms begin, accepted, for the account: a fresh invitation id and an
 * active membership, with the inviter, policy, roles and expiries unchanged.
 * Every linked-invitation invariant holds at both ends of the transaction.
 *
 * The email address is not verified. The one-time token is what vouches for
 * the person; it was bound to the principal at issue and is spent here.
 */
import { randomUUID } from 'node:crypto';
import type { AdministrationTenantImage } from '../../shared/tenantAdministration.js';
import type { InvitationPair } from '../../shared/tenantInvitations.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import { invitationPrincipalEmail } from './tenantInvitationModel.js';
import type { StoredTenantInvitation } from './tenantInvitationStore.js';
import type { InvitationTransaction } from './tenantInvitationTransaction.js';
import { mintInvitationToken } from './tenantInvitationToken.js';
import type { TenantStoreBinding } from './tenantStore.js';

const next = (value: string) => String(BigInt(value) + 1n);

/** The claim's two writes. The caller has already proved the token, the
 * account's address, the tenant, the terms and the inviter's authority. */
export async function applyInvitationClaim(
  transaction: InvitationTransaction,
  binding: TenantStoreBinding,
  old: StoredTenantInvitation,
  before: InvitationPair,
  tenant: AdministrationTenantImage,
  accountId: string,
  now: number,
  active: () => void,
): Promise<Readonly<{ revoked: InvitationPair; after: InvitationPair }>> {
  if (
    invitationPrincipalEmail(old.accountId) === null ||
    invitationPrincipalEmail(accountId) !== null ||
    old.status !== 'pending' ||
    before.invitation.invitationId !== old.invitationId ||
    before.membership.status !== 'invited' ||
    tenant.tenantId !== old.tenantId ||
    tenant.status !== 'active' ||
    tenant.version !== old.expectedTenantVersion ||
    now < old.createdAt ||
    now >= old.redeemUntil ||
    now >= old.validUntil
  )
    return denyTenant();
  const { invitations: store, administration } = transaction;
  const ended = { ...before.membership, status: 'revoked' as const, version: next(before.membership.version) };
  const { version: _ended, ...end } = ended;
  await administration.putMembership({ ...end, expectedVersion: before.membership.version });
  await store.transition({ invitationId: old.invitationId, expectedVersion: old.version, status: 'revoked' });
  const revoked: InvitationPair = {
    invitation: { ...before.invitation, status: 'revoked', version: next(old.version) },
    membership: ended,
  };
  active();
  const invitationId = randomUUID(),
    membershipId = randomUUID();
  // A digest the column requires; its token is never returned, and an accepted row is never redeemed.
  const row: StoredTenantInvitation = {
    invitationId,
    membershipId,
    tenantId: old.tenantId,
    accountId,
    inviterId: old.inviterId,
    issuanceOperation: old.issuanceOperation,
    roles: old.roles,
    expectedTenantVersion: tenant.version,
    policyId: old.policyId,
    policyVersion: old.policyVersion,
    createdAt: now,
    redeemUntil: old.redeemUntil,
    validUntil: old.validUntil,
    status: 'pending',
    version: '1',
    digest: mintInvitationToken(binding, invitationId, accountId).digest,
  };
  const membership = {
    membershipId,
    tenantId: old.tenantId,
    accountId,
    status: 'active' as const,
    version: '1',
    roles: old.roles,
    validUntil: old.validUntil,
  };
  const { version: _member, ...begin } = membership;
  await administration.putMembership({ ...begin, expectedVersion: null });
  await store.insert(row);
  await store.transition({ invitationId, expectedVersion: '1', status: 'accepted' });
  active();
  const { digest: _digest, ...visible } = row;
  return captureTenantData({ revoked, after: { invitation: { ...visible, status: 'accepted', version: '2' }, membership } });
}
