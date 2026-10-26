/** What GanttList says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  untitled: 'Untitled',
  noGroup: 'None',
  nothingHere: 'Nothing to show here.',
  onDay: '{title}, on {day}',
  fromTo: '{title}, {from} to {to}',
  done: ', {share}% done',
  firstOnly: 'Showing the first {count}; narrow the list to see the rest.',
});
