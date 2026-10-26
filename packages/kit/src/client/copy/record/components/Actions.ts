/** What Actions says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisActionBelongsToAPrevious: 'This action belongs to a previous record surface.',
  actionDone: '{label} — done',
  wasAppliedButTheRecord: '{label} was applied, but the record could not be refreshed.',
  nothingToDoForThisRecord: 'Nothing to do for this record now',
  moreActionsForThisRecord: 'More actions for this record',
  moreActions: 'More actions',
  sayWhyFor: 'Say why, for "{label}". ',
  sayWhy: 'Say why. ',
  theReasonIsKept: 'The reason is kept with the record.',
  reason: 'Reason',
  labelReason: '{label}: reason',
});
