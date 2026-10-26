/** What tenantInvitations says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theInvitationChangeIsUnconfirmed: 'The invitation change is unconfirmed. Keep this attempt and check its status.',
  invitationAccessCouldNotBeVerified: 'Invitation access could not be verified. Refresh access and review the current information.',
  invalidInvitationResponse: 'Invalid invitation response',
  invitationIssuerAccessCould: 'Invitation issuer access could not be loaded.',
  theAuthorizedInvitationTargets: 'The authorized invitation targets could not be loaded.',
  theAuthorizedInvitationList: 'The authorized invitation list could not be loaded. Refresh the targets before continuing.',
  enterAnInvitationToken: 'Enter a canonical twi1 invitation token.',
  theInvitationCouldNotBeReviewed: 'The invitation could not be reviewed. Check access and enter the token again.',
  invitationAcceptanceConfirmedRefresh: 'Invitation acceptance confirmed. Refresh authorized discovery to choose a tenant.',
  issuanceConfirmedTheOriginal:
    'Issuance confirmed. The original token cannot be recovered. Load the current invitation list and explicitly reissue.',
  invitationChangeConfirmedRefresh: 'Invitation change confirmed. Refresh the authorized list before another change.',
  refreshInvitationAccessExplicitly: 'Refresh invitation access explicitly before continuing.',
  reviewTheInvitationAgain: 'Review the invitation again before accepting.',
  theChangeWasNotApplied: 'The change was not applied. Refresh current information and review a new attempt.',
  theChangeIsUnconfirmedCheckThisExact: 'The change is unconfirmed. Check this exact attempt’s status; do not submit it again.',
  accessRefreshedTheOriginal: 'Access refreshed. The original attempt is retained.',
  accessRefreshedLoadTheCurrent: 'Access refreshed. Load the current authorized information.',
});
