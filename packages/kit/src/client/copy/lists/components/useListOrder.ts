/** What useListOrder says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thereIsNoRoom: 'There is no room left between those two on this page. Show “{title}” with the whole list on one page to put it there.',
  movedToPlace: 'Moved “{title}” to place {index} of {entriesCount}',
  reorder: 'Reorder {title}',
  dragTheRowPress: 'Drag the row, press Alt and ↑ or ↓, or choose a place',
  order: 'Order',
});
