/** What sdk/options says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  notAvailable: 'Not available',
  notAReference: '{command} has no input "{name}" that picks a record: useOptions names a reference input the command declares.',
});
