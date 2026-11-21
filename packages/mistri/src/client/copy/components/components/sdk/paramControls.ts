/** What sdk/paramControls says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  chooseNeedsOptions:
    '<Choose param="{param}"> has no options: give it a resource to read with `from`, or declare "{param}" in the page\'s params as a list of words.',
  chooseCountNeedsRead:
    '<Choose param="{param}" count> counts the page\'s read, and this page reads more than one resource or none: put it in a <Scope from>, or give `count` an `of` and a `by`.',
  choose: 'Choose',
  search: 'Search',
  dateFrom: 'From',
  dateTo: 'To',
});
