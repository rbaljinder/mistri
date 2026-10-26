/** What tenantSupport says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theSupportReplyCould: 'The support reply could not be verified.',
  signInAgain: 'Sign in again.',
  theSupportRequestCould: 'The support request could not be confirmed.',
  theSupportSessionCould: 'The support session could not be confirmed.',
  signInCouldNotBeConfirmed: 'Sign-in could not be confirmed. Try again.',
  thatPasswordWasNotAccepted: 'That password was not accepted.',
  supportAccessCouldNotBeChecked: 'Support access could not be checked. Close and try again.',
  thatSignInWasNotRecent: 'That sign-in was not recent enough. Try again.',
  theSessionMayHaveOpened: 'The session may have opened. Check the attempt before trying again.',
  theSessionCouldNotBeOpened: 'The session could not be opened.',
  thatAttemptDidNotOpen: 'That attempt did not open a session.',
  thatSessionHasAlready: 'That session has already ended.',
  theAttemptCouldNotBeChecked: 'The attempt could not be checked yet. Try again.',
  couldNotBeOpened: '{platformLabel} could not be opened. Try again.',
  theExitCouldNotBeConfirmed: 'The exit could not be confirmed. Try again.',
});
