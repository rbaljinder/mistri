/** What accountAdministration says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  signInToManage: 'Sign in to manage accounts.',
  theChangeCouldNotBeConfirmed: 'The change could not be confirmed. Reload the accounts before trying again.',
  theAccountsCouldNot: 'The accounts could not be loaded. Try again.',
  theAccountsCouldNotBeReached: 'The accounts could not be reached.',
});
