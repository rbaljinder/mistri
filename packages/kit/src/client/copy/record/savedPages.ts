/** What savedPages says, in the record room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  theServerDidNotConfirm: 'The server did not confirm the change within 30 seconds. It may still complete.',
  noDatabaseConnectionIsSelected: 'No database connection is selected.',
});
