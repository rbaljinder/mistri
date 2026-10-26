/** What core says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  searchIsNotAnswering: 'Search is not answering right now, so this searched the database instead.',
  tablewalkIsNotAnswering: 'tablewalk is not answering. The server it was started with may have stopped — restart it and reload this page.',
  theServerIsNotAnswering: 'The server is not answering right now. Check your connection, then try again.',
  useACanonicalApi: 'Use a canonical API path without a fragment.',
  invalidOrdinaryUndoIdentity: 'Invalid ordinary Undo identity.',
  yourSessionExpiredReload: 'Your session expired. Reload to continue.',
  theSignedInAccount: 'The signed-in account changed.',
  theServerAnsweredWithSomething: 'The server answered {status} with something that is not JSON. ',
  somethingBetweenThisPage: 'Something between this page and tablewalk may be intercepting the request.',
  waitForThePending: 'Wait for the pending record update before leaving this view.',
  theTenantContextIsUnavailable: 'The tenant context is unavailable. Verify your session and choose a tenant again.',
  aChangeIsPending: 'A change is pending or unconfirmed. Resolve it before leaving this view.',
  fixTheQueryBefore: 'Fix the query before saving it as a filter.',
  forTheAuthor: '{message} Why: {cause}',
});
