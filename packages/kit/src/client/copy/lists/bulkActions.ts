/** What bulkActions says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  notWrittenTheList: 'Not written: the list is no longer current.',
  selectBetween1And: 'Select between 1 and {max} records.',
  theSelectedRecordsCould: 'The selected records could not be prepared.',
  alreadyPending: '{blocked} already pending',
  notWritten: '{skipped} not written',
  applied: '{applied} applied',
  rejected: '{rejected} rejected',
  unconfirmed: '{uncertain} unconfirmed',
  labelApplied: '{label}: {count} applied.',
  labelRefused: '{label}: refused, so none of the {records} was written.',
});
