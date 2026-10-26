/** What resourceRequests says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  thisRecordContainsAValue: 'This record contains a value that cannot be sent as structured data.',
  thisRecordHasNoUsable: 'This record has no usable key.',
});
