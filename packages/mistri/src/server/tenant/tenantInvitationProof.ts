/** Private owner helpers, not proof issuers or enrollment capabilities. */
import type { IncomingMessage } from 'node:http';
import type { AppAuthRuntimeBinding, VerifiedSessionInstance } from '../auth/auth.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import {
  assertInvitationTerms,
  assertInvitationTermsWithin,
  captureInvitationPolicy,
  invitationPrincipalEmail,
  type InvitationPolicy,
} from './tenantInvitationModel.js';
import { captureStoredTenantInvitation, type StoredTenantInvitation } from './tenantInvitationStoreContract.js';

export function createInvitationLifetime({
  auth,
  request,
  proof,
  accountId,
  contextExpiresAt,
  started,
  lifetime,
  clock,
}: {
  auth: AppAuthRuntimeBinding;
  request: IncomingMessage;
  proof: VerifiedSessionInstance;
  accountId: string;
  contextExpiresAt: number;
  started: number;
  lifetime: number;
  clock: () => number;
}) {
  let last = started,
    deadline = Math.min(started + lifetime, contextExpiresAt);
  const live = () => {
    const now = clock();
    auth.assertSessionCurrent(proof);
    if (request.aborted || now < last || now >= deadline) return denyTenant();
    last = now;
    return now;
  };
  const current = async () => {
    live();
    const fresh = await auth.sessionInstance(request);
    live();
    if (!fresh || fresh.identity.id !== accountId || fresh.sessionId !== proof.sessionId) return denyTenant();
    auth.assertSessionCurrent(fresh);
    deadline = Math.min(deadline, fresh.expiresAt);
    live();
    // Async owners explicitly await native observations. A synchronous store
    // keeps its original exact sequence; public PG enrollment remains separate.
    if (!auth.synchronous) {
      await auth.observeSession(proof);
      live();
      await auth.observeSession(fresh);
      live();
    }
  };
  return Object.freeze({ live, current });
}

/** Who is checked, and against which ceiling. `ceiling` is the inviter's
 * current authority when it is a delegate's, which only the store can say
 * (the owner reads it in its transaction); without one, the policy's
 * operator grant must still cover the invitation. `recipient` is the account
 * accepting: an email invitation's principal is nobody's, so its acceptor is
 * named here, and without one only the inviter is observed. */
export interface InvitationEligibilityOptions {
  readonly ceiling?: readonly string[];
  readonly recipient?: string;
}
const recipientOf = (row: StoredTenantInvitation, options: InvitationEligibilityOptions) =>
  options.recipient ?? (invitationPrincipalEmail(row.accountId) === null ? row.accountId : undefined);

export function assertInvitationEligibility(
  row: StoredTenantInvitation,
  policy: InvitationPolicy,
  now: number,
  auth: AppAuthRuntimeBinding,
  options: InvitationEligibilityOptions = {},
): void {
  const recipient = recipientOf(row, options);
  if (
    row.policyId !== policy.id ||
    row.policyVersion !== policy.version ||
    row.createdAt > now ||
    now >= row.redeemUntil ||
    now >= row.validUntil ||
    auth.lookupEligibleAccount(row.inviterId)?.accountId !== row.inviterId ||
    (recipient !== undefined && auth.lookupEligibleAccount(recipient)?.accountId !== recipient)
  )
    return denyTenant();
  assertInvitationCurrentTerms(row, policy, now, options.ceiling);
}

/** Synchronous terms only: native account eligibility still needs observation. */
export function assertInvitationCurrentTerms(
  row: StoredTenantInvitation,
  policy: InvitationPolicy,
  now: number,
  ceiling?: readonly string[],
): void {
  if (
    row.policyId !== policy.id ||
    row.policyVersion !== policy.version ||
    row.createdAt > now ||
    now >= row.redeemUntil ||
    now >= row.validUntil
  )
    return denyTenant();
  if (ceiling) assertInvitationTermsWithin(policy, ceiling, row.roles, row.redeemUntil, row.validUntil, row.createdAt);
  else
    assertInvitationTerms(
      policy,
      row.inviterId,
      row.tenantId,
      row.issuanceOperation,
      row.roles,
      row.redeemUntil,
      row.validUntil,
      row.createdAt,
    );
}

/** Private owner checkpoint: must be explicitly awaited, never a store's sync
 * active callback. No eligibility result is retained or treated as a grant. */
export async function observeInvitationEligibility(
  row: StoredTenantInvitation,
  policy: InvitationPolicy,
  auth: AppAuthRuntimeBinding,
  live: () => number,
  options: InvitationEligibilityOptions = {},
): Promise<void> {
  row = captureStoredTenantInvitation(row);
  policy = captureInvitationPolicy(policy);
  const terms = () => assertInvitationCurrentTerms(row, policy, live(), options.ceiling);
  terms();
  const inviter = await auth.lookupEligibleAccountCurrent(row.inviterId);
  terms();
  if (inviter?.accountId !== row.inviterId) return denyTenant();
  const recipient = recipientOf(row, options);
  if (recipient === undefined) return;
  const found = await auth.lookupEligibleAccountCurrent(recipient);
  terms();
  if (found?.accountId !== recipient) return denyTenant();
}
