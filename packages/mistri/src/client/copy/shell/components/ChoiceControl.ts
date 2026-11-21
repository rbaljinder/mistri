/** What ChoiceControl says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  word: '{thing}:',
  choose: 'Choose {thing}',
  find: 'Find a {thing}',
  noMatch: 'No {thing} matches',
  couldNotSearch: 'Could not search. Try again.',
  first: 'Choose a {thing} to work in. Pages that follow it show its records, and you can change it here at any time.',
  change: 'Pages that follow the {thing} show its records.',
  clear: 'Clear',
  current: 'Current',
});
