/** What SupportBanner says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  supportSession: 'Support session',
  viewingAsProvider: 'viewing as the provider',
  as: 'as',
  ends: ' · ends',
  endsInTwoMinutes: 'Ends in two minutes.',
  exit: 'Exit',
  supportAccessIsNotAvailable: 'Support access is not available yet',
  you: 'You are in',
  viewingAndChangingItsRecords:
    '. Viewing and changing its records under support comes in a later release, so none of them is shown or changed here.',
  thisSessionIsRecorded: 'This session is recorded with your name,',
  andYourReason: ', and your reason:',
  exitToReturn: 'Exit to return to {platformLabel}.',
  supportSessionEnded: 'Support session ended',
  yourSession: 'Your session in',
  hasEnded: 'has ended',
  ended: 'ended at',
  nothingMoreIsRecorded: '. Nothing more is recorded under it.',
  return: 'Return to {platformLabel}',
});
