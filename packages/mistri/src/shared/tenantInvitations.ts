import type { AdministrationMembershipImage, AdministrationOwner, AdministrationTenantImage } from './tenantAdministration.js';

/** Native-account enrollment. An invitation names an existing account, or an
 * email address whose account the invitee creates when claiming it; the
 * address is not verified. No credential is durable intent. */
export const INVITATION_ISSUER_OPERATIONS = Object.freeze(['issueInvitation', 'revokeInvitation', 'reissueInvitation'] as const);
export type InvitationIssuerOperation = (typeof INVITATION_ISSUER_OPERATIONS)[number];
/** `claimInvitation` accepts an email invitation for a real account: the
 * placeholder pair ends and the same terms begin, accepted, for the account. */
export type InvitationOperation = InvitationIssuerOperation | 'acceptInvitation' | 'claimInvitation';
/** The principal an email invitation's reservation is held for: `email:<address>`. */
export const INVITATION_EMAIL_PRINCIPAL = 'email:';
export type InvitationIssuerIntent =
  | Readonly<{
      operation: 'issueInvitation';
      tenantId: string;
      expectedTenantVersion: string;
      accountId: string;
      roles: readonly string[];
      redeemUntil: number;
      validUntil: number;
    }>
  | Readonly<{
      operation: 'issueInvitation';
      tenantId: string;
      expectedTenantVersion: string;
      email: string;
      roles: readonly string[];
      redeemUntil: number;
      validUntil: number;
    }>
  | Readonly<{
      operation: 'revokeInvitation';
      tenantId: string;
      expectedTenantVersion: string;
      invitationId: string;
      expectedInvitationVersion: string;
      membershipId: string;
      expectedMembershipVersion: string;
    }>
  | Readonly<{
      operation: 'reissueInvitation';
      tenantId: string;
      expectedTenantVersion: string;
      invitationId: string;
      expectedInvitationVersion: string;
      membershipId: string;
      expectedMembershipVersion: string;
      roles: readonly string[];
      redeemUntil: number;
      validUntil: number;
    }>;
interface RecipientIntentFields {
  readonly tenantId: string;
  readonly expectedTenantVersion: string;
  readonly invitationId: string;
  readonly expectedInvitationVersion: string;
  readonly membershipId: string;
  readonly expectedMembershipVersion: string;
}
/** A recipient's step: accepting an account invitation, or claiming an email
 * one. Two constituents, one literal each, so a check on `operation` narrows. */
export type InvitationAcceptanceIntent =
  | Readonly<RecipientIntentFields & { operation: 'acceptInvitation' }>
  | Readonly<RecipientIntentFields & { operation: 'claimInvitation' }>;
export type InvitationIntent = InvitationIssuerIntent | InvitationAcceptanceIntent;
/** The signed-out claim's answer. `result` is the recipient's receipt projection. */
export interface InvitationClaimReply {
  readonly outcome: 'applied';
  readonly account: 'created';
  readonly email: string;
  readonly result: InvitationAcceptanceResult;
}
/** Issuer-visible meaning; neither the secret nor its digest is a public field. */
export interface InvitationImage {
  readonly invitationId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly accountId: string;
  readonly inviterId: string;
  readonly roles: readonly string[];
  readonly expectedTenantVersion: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly issuanceOperation: 'issueInvitation' | 'reissueInvitation';
  readonly createdAt: number;
  readonly redeemUntil: number;
  readonly validUntil: number;
  readonly status: 'pending' | 'accepted' | 'revoked';
}
export interface InvitationPair {
  readonly invitation: InvitationImage;
  readonly membership: AdministrationMembershipImage;
}
/** Reissue retains the terminated pair as well as the newly reserved pair. */
export interface InvitationChange {
  readonly operation: InvitationOperation;
  readonly tenant: AdministrationTenantImage;
  readonly before: InvitationPair | null;
  readonly after: InvitationPair;
  readonly revoked?: InvitationPair;
}
export interface InvitationResult {
  readonly receiptId: string;
  readonly requestId: string;
  readonly completedAt: string;
  readonly change: InvitationChange;
  readonly replayed: boolean;
}
export interface InvitationAttempt {
  readonly idempotencyKey: string;
  readonly intent: InvitationIntent;
}
export interface InvitationRequest extends InvitationAttempt, AdministrationOwner {}
/** One-time synthetic handoff only; never include token in status or a receipt. */
export interface InvitationIssueReply {
  readonly result: InvitationResult;
  readonly token?: string;
}
/** Recipient receipt projection excludes issuer identity, policy and audit images. */
export interface InvitationAcceptanceResult {
  readonly receiptId: string;
  readonly requestId: string;
  readonly completedAt: string;
  readonly replayed: boolean;
  readonly invitationId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly roles: readonly string[];
  readonly validUntil: number;
  readonly status: 'accepted';
}
export interface InvitationExecutionReply {
  readonly result: InvitationResult | InvitationAcceptanceResult;
  readonly token?: string;
}
/** Distinct owner from issuer administration and business tenant selection. */
export interface InvitationRecipientSession {
  readonly appId: string;
  readonly accountId: string;
  readonly context: string;
  readonly expiresAt: number;
}
export interface InvitationIssuerSession extends InvitationRecipientSession {
  readonly maxMembershipLifetimeMs: number;
  readonly maxRedemptionLifetimeMs: number;
  readonly maxPendingPerTenant: number;
}
export interface InvitationPageRequest extends AdministrationOwner {
  readonly after?: string;
  readonly limit?: number;
}
export interface InvitationTarget {
  readonly tenantId: string;
  readonly tenant: AdministrationTenantImage | null;
  /** What the tenant is called, where the server could say (the profile's record name); words only, every request names the id. */
  readonly name?: string;
  readonly capabilities: readonly Readonly<{ operation: InvitationIssuerOperation; roles: readonly string[] }>[];
}
export interface InvitationTargetPage {
  readonly items: readonly InvitationTarget[];
  readonly next: string | null;
}
export interface InvitationListRequest extends InvitationPageRequest {
  readonly tenantId: string;
  readonly operation: 'revokeInvitation' | 'reissueInvitation';
}
export interface InvitationListPage {
  readonly tenant: AdministrationTenantImage | null;
  readonly operation: 'revokeInvitation' | 'reissueInvitation';
  readonly roles: readonly string[];
  readonly items: readonly InvitationPair[];
  readonly next: string | null;
}
export const INVITATION_HTTP_ROOT = '/api/tenant/invitations';
export const INVITATION_HTTP_HEADER = 'x-mistri-invitation-context';
export interface InvitationPreview {
  readonly intent: InvitationAcceptanceIntent;
  readonly roles: readonly string[];
  readonly redeemUntil: number;
  readonly validUntil: number;
}
