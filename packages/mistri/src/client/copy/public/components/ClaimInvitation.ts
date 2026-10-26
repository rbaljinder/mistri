/** What ClaimInvitation says, in the public pages room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  enterANameOf1: 'Enter a name of 1 to 120 characters and a password of 8 to 128 characters.',
  thisInvitationTokenCannot: 'This invitation token cannot be used. Check it with the person who invited you.',
  anAccountAlreadyUses:
    "An account already uses this invitation's email address. Sign in, then accept the invitation from the account menu with the same token.",
  yourAccountWasCreated:
    'Your account was created, but the invitation is not accepted yet. Sign in, then accept it from the account menu with the same token.',
  theRequestCouldNotBeConfirmed: 'The request could not be confirmed. Try signing in first; if there is no account yet, submit again.',
  enterTheInvitationToken: 'Enter the invitation token exactly as you were given it.',
  enterYourName: 'Enter your name.',
  chooseAPasswordOf8: 'Choose a password of 8 to 128 characters.',
  tooManyAttemptsTry: 'Too many attempts. Try again in {retryAfter} seconds.',
  pasteTheOneTime:
    'Paste the one-time token from the person who invited you. It creates your account under the email address they invited, and works once.',
  invitationToken: 'Invitation token',
  n8To128Characters: '8 to 128 characters.',
  confirmPassword: 'Confirm password',
  createAccountAndJoin: 'Create account and join',
});
