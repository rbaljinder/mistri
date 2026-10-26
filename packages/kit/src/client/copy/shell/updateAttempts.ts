/** What updateAttempts says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  updateNotConfirmedTheRecord: 'Update not confirmed. The record may already have changed. Check the stored values before editing again.',
  anUpdateIsAlready: 'An update is already pending for this record.',
  theRequestMayStill: 'The request may still complete.',
  theServerDidNotAcknowledge: 'The server did not acknowledge exactly the requested fields on one record.',
});
