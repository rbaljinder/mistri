/** What useRecordInsert says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  creationWasNotConfirmed: 'Creation was not confirmed. The row may already exist. Check the table before adding it again.',
  theRequestMayStill: '{problem} The request may still complete.',
  theServerReturnedAnInvalid: 'The server returned an invalid error response.',
  theServerDidNotReturn: '{problem} The server did not return a record key.',
  theRowWasAdded: 'The row was added, but its record could not be opened. Close this form and find it in the table.',
});
