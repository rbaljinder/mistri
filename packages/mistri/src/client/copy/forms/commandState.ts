/** What commandState says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  signInAgainBefore: 'Sign in again before continuing.',
  thisRecordHasAnUnsupported: 'This record has an unsupported key.',
  refreshThisRecordBefore: 'Refresh this record before continuing.',
  refreshTheseRecordsBefore: 'Refresh these records before continuing.',
  checkingResult: 'Checking result…',
  completed: 'Completed.',
  completedCloseAndRefresh: 'Completed. Close and refresh the record to see the changes.',
  theResultIsNotYet: 'The result is not yet confirmed. Check the result or retry this same submission. Keep this tab open.',
});
