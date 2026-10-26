/** What IntakeControls says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  choosePlaceholder: 'Choose {label}',
  showValue: 'Show',
  hideValue: 'Hide',
  yesWord: 'Yes',
  noWord: 'No',
  // A month's box, before anything is typed: the order its digits go in.
  monthPlaceholder: 'MM/YYYY',
});
