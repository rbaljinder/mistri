/** What AccountProfile says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  changeEmail: 'Change email',
  newEmailAddress: 'New email address',
  weSendALinkToTheNewAddress:
    'We send a link to the new address, and a notice to the old one. The address changes once the link is followed.',
  sending: 'Sending…',
  sendLink: 'Send link',
  checkYourInboxFor: 'Check the inbox of {email} for the link.',
  theEmailChangeCouldNotBeRequested: 'The request could not be confirmed. Check your inbox before asking again.',
  enterANameBetween: 'Enter a name between 1 and 120 characters, without control characters.',
  emailAndPassword: 'Email and password',
  google: 'Google',
  currentProfileLoadedReview: 'Current profile loaded. Review it before making another change.',
  yourProfileCouldNotBe: 'Your profile could not be loaded.',
  nameSaved: 'Name saved.',
  theProfileSaveCouldNotBeConfirmed: 'The profile save could not be confirmed.',
  yourProfile: 'Your profile',
  closeProfile: 'Close profile',
  yourNameIsEditable: 'Your name is editable. Email and sign-in methods are managed by your identity provider.',
  loadingProfile: 'Loading profile…',
  signInMethods: 'Sign-in methods',
  managedAccount: 'Managed account',
  saveName: 'Save name',
  checkCurrentProfile: 'Check current profile',
});
