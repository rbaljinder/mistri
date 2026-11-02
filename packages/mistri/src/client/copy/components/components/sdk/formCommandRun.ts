/** What sdk/formCommandRun says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  isNotSomethingYouCanDo: '{label} is not something you can do here.',
  notKnown: '{label} was sent, and its result is not known yet. Check it before you send it again.',
  checkedElsewhere: 'You signed in again since {label} was sent, so its result cannot be checked here.',
  attemptIsAUuid: "A run's attempt is the key it is sent under: a UUID made once per intent, crypto.randomUUID().",
});
