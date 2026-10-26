/** What FormLines says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  fill: 'Fill in {column}.',
  addLine: 'Add line',
  removeLine: 'Remove line',
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLine: 'Move line {n}',
  moveLineHint: 'Drag, or press Alt and an arrow key, to move this line',
  lineActions: 'Line {n} actions',
  lineActionsHeading: 'Actions',
  lineMoved: 'Line moved to place {n} of {count}.',
  noLinesYet: 'No lines yet.',
  subtotal: 'Subtotal',
});
