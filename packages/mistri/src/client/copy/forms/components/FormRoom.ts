/** What FormRoom says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  noFormCalledInThisApp: 'No form called "{pageId}" in this app.',
  notConfirmed: '{label} was sent, and its result is not confirmed. Check the record before you send it again.',
});
