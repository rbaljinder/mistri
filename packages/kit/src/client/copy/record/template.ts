/** What template says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  theServerDidNotAcknowledge: 'The server did not acknowledge the layout save.',
  thisTableStillHasALayout: 'This table still has a layout save pending.',
  discardLayoutChanges: 'Discard layout changes?',
  theSavedLayoutWill: 'The saved layout will not change.',
  discardLayout: 'Discard layout',
  theSaveWasNotConfirmed: '{message} The save was not confirmed; your draft is still available.',
  saved: 'Saved "{name}" for {table}.',
});
