/** What appFlags says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  visitorUnavailable: 'Visitor experiments are unavailable for this App or session.',
  ownerUnavailable: 'No active App flag owner.',
  requestOwnerRetired: 'Flag request owner retired.',
  responseOwnerChanged: 'Flag response owner changed.',
  valuesUnavailable: 'Evaluated flag values unavailable.',
  responseTooLarge: 'Flag response too large.',
  valuesNotReady: 'Evaluated flag values are not ready for this App.',
  undeclaredFlag: 'Undeclared evaluated flag: {key}.',
});
