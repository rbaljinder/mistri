/** What groupMoves says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  movedToGroup: 'Moved “{title}” to {group}.',
  movedToPlace: 'Moved “{title}” to place {index} of {count} in {group}.',
  cannotEnter: '“{title}” can’t be moved to {group} here.',
  wentBack: '“{title}” went back to {group}: {reason}',
  notMoved: 'It was not moved.',
});
