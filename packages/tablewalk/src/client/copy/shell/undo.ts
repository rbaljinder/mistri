/** What undo says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  undoWasNotConfirmed:
    'Undo was not confirmed. The record may already have changed. Check the stored values before making more changes; do not retry this Undo.',
  nothingToUndo: 'Nothing to undo.',
  thisUndoIsPending: 'This Undo is pending or unconfirmed. Do not retry it.',
});
