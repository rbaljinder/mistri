/** What DeleteButton says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  deletionWasNotConfirmed: 'Deletion was not confirmed. Refresh and reconcile this record before deleting again.',
  inWillBeDeleted: '{n} in {t} will be deleted too',
  inWillBeKept: '{n} in {t} will be kept, with the reference emptied',
  inWillBeKeptWithTheReference: '{n} in {t} will be kept, with the reference reset',
  inWillBlockThisTheDatabase: '{n} in {t} will block this — the database will refuse it',
  theDeletionPreviewIsUnavailable: 'The deletion preview is unavailable. Refresh the record.',
  deleteThisRow: 'Delete this {name} row',
  thisDeletionBelongsToAPrevious: 'This deletion belongs to a previous session or connection.',
  theRowWasNotDeleted: 'The row was not deleted.',
  deleted: 'Deleted {name} {label}.',
  deleteNameLabel: 'Delete {name} {label}?',
  thisRowIsReferenced: 'This row is referenced. Here is what the database will do:',
  couldNotBeCounted: '{table} could not be counted',
  inThisConstraintsRule: "{rows} in {table} — this constraint's rule is unknown",
  onDeleteRule: 'on delete {rule}',
  ruleUnknown: 'rule unknown',
  cascadesAreCountedOne: 'Cascades are counted one level deep. Rows deleted by a cascade may take their own children with them.',
  nothingPointsAtThis: 'Nothing points at this row, so nothing else is affected.',
  theDatabaseWillRefuse:
    'The database will refuse this while those references exist. You can try anyway — its answer is the authority, not ours.',
  tryAnyway: 'Try anyway',
});
