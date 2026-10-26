/** What CommandForm says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theSessionChanged: 'The session changed.',
  deselectTheIneligibleRecords: 'Deselect the ineligible records to continue.',
  readyToSubmit: 'Ready to submit {count}.',
  readyToSubmitOne: 'Ready to submit.',
  deselectIneligible: 'Deselect ineligible',
  checkResult: 'Check result',
  retrySameSubmission: 'Retry same submission',
  refreshAndReview: 'Refresh and review',
  checkTheRecord:
    'The result is not confirmed, and this action keeps no receipt to check it by. Refresh the record and look before you try again.',
  recordCouldNotBePrepared: 'The record could not be prepared. Refresh and try again.',
  recordsCouldNotBePrepared: 'The records could not be prepared. Refresh and try again.',
  readingTheCurrentVersion: 'Reading the current record version…',
  readingTheCurrentVersions: 'Reading the current record versions…',
  oneIneligible: 'One selected record cannot take this action now. The request is all or nothing, so it would refuse the whole request.',
  manyIneligible:
    '{count} selected records cannot take this action now. The request is all or nothing, so any one of them would refuse the whole request.',
});
