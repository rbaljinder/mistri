/** What savedFormApi says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theFormCouldNotBeSaved: 'The form could not be saved ({status}).',
  couldNotReach: 'The form could not be reached. Check your connection and try again.',
});
