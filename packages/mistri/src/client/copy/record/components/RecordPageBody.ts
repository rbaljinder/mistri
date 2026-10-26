/** What RecordPageBody says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  thisRecordIsNoLonger: 'This record is no longer available.',
  theDeletionResultIsNotYet: 'The deletion result is not yet confirmed. Keep this tab open; do not submit another deletion.',
});
