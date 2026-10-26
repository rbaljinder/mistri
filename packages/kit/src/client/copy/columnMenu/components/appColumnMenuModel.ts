/** What appColumnMenuModel says, in the column menu room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  oldestFirst: 'Oldest first',
  newestFirst: 'Newest first',
  lowHigh: 'Low → high',
  highLow: 'High → low',
  filterMore: 'Filter…',
  clearFilter: 'Clear filter',
  unpinColumn: 'Unpin column',
  pinColumn: 'Pin column',
});
