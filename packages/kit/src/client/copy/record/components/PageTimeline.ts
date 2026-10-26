/** What PageTimeline says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisActivityStreamHasNoView: 'This activity stream has no view definition.',
  thisActivityStreamCould: 'This activity stream could not be read.',
  nothingDatedYetForThisRecord: 'Nothing dated yet for this record.',
  updates: { one: '{count} update', other: '{count} updates' },
});
