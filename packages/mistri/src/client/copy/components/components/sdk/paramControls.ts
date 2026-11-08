/** What sdk/paramControls says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  chooseNeedsOptions:
    '<Choose param="{param}"> has no options: give it a resource to read with `from`, or declare "{param}" in the page\'s params as a list of words.',
  choose: 'Choose',
  search: 'Search',
  dateFrom: 'From',
  dateTo: 'To',
});
