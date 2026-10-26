/** What sdk/publicPageCommand says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  isNotSomethingYouCanDo: '{label} is not something you can do here.',
  publicNotSent: '{label} could not be sent. Check your connection and try again.',
});
