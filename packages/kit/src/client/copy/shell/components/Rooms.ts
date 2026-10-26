/** What Rooms says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  noDashboardCalledInThisApp: 'No dashboard called "{pageId}" in this app.',
  noIsAddressed: 'No {name} is addressed "{values}".',
  recordPageUnavailable: 'This record’s page could not be opened. Try again.',
  retryRecordPage: 'Try again',
});
