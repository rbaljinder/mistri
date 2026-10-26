/** What TriageBoard says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  order: 'Order',
  newInLane: 'New in {lane}',
  row: 'Row',
  noItemsHere: 'No items here.',
  nothingOnThisBoard: 'Nothing on this board yet.',
  triageBoard: 'Triage board',
  showMore: 'Show {count} more',
  actionsForTitle: 'Actions for {title}',
  moveOrderOrEdit: 'Move, order or edit',
  move: 'Move to',
  editGroup: 'Edit',
  lanes: 'Lanes',
  previousLane: 'Previous lane',
  laneOf: '{lane} of {count}',
  nextLane: 'Next lane',
  items: { one: '{count} item', other: '{count} items' },
  itemsLimit: { one: '{count} item, limit {limit}', other: '{count} items, limit {limit}' },
  overTheLimit: ', over the limit',
  foldLane: 'Fold {lane}',
  openLane: 'Open {lane}',
  cannotMoveTo: '{title} can’t move to {lane} from where it is.',
});
