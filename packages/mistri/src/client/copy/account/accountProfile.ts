/** What accountProfile says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  enterAnEmailAddress: 'Enter an email address.',
  theEmailChangeCouldNotBeRequested: 'The request could not be confirmed. Check your inbox before asking again.',
  theEmailChangeWasNotRequested: 'The email change was not requested. Check the address and try again.',
  invalidProfile: 'Invalid profile',
  signInToView: 'Sign in to view your profile.',
  invalidProfileResponse: 'Invalid profile response',
  aProfileSaveIsStill: 'A profile save is still in progress. Check again shortly.',
  theProfileRequestWasNotApplied: 'The profile request was not applied. Check your name and try again.',
  unconfirmedProfileResponse: 'Unconfirmed profile response',
  unconfirmedProfileSave: 'Unconfirmed profile save',
  theProfileSaveCould: 'The profile save could not be confirmed. Check your current profile before making another change.',
  yourProfileCouldNotBeLoaded: 'Your profile could not be loaded. Try checking again.',
  enterANameBetween: 'Enter a name between 1 and 120 characters, without control characters.',
});
