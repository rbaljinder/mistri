/** What PageGroups says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  nothingToGroup: 'Nothing to group yet.',
  groupCount: '{shown} of {count}',
  showAll: 'Show all {count}',
  showFewer: 'Show first {count}',
  showAllOf: 'Show all {count} {things} of {group}',
  showFewerOf: 'Show the first {count} {things} of {group}',
  totalOfCount: 'Total of {count}',
  previousGroups: 'Previous groups',
  moreGroups: 'More groups',
  noGroupValue: 'No {caption}',
});
