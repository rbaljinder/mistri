/** What sdk/fixture says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  signInToDo: 'Sign in to do that.',
  notGranted: 'Not granted.',
  actionDone: '{label} done.',
  reviewStale: 'The record changed after you reviewed {label}. Review it again before you run it.',
  flagFixtureUnavailable: 'Evaluated flag fixture unavailable.',
  fixtureRefused: 'The reader may not read {resource}.',
});
