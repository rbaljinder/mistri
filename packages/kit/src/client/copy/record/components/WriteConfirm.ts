/** What WriteConfirm says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  enableWriteMode: 'Enable write mode?',
  enableEditingOfExisting: 'Enable editing of existing records in',
  fieldChangesStayPending: 'Field changes stay pending until you review and apply them together.',
  theReviewNamesTheRecord: 'The review names the record, changed values, and SQL statement.',
  anUpdateThatWould: 'An update that would touch more than one row is refused.',
  writeModeStaysOnForThisDatabase: 'Write mode stays on for this database until you turn it off, including after a reload.',
  itAppliesToThisDatabase: 'It applies to this database only — switching connections does not carry it over.',
  keepViewing: 'Keep viewing',
  enableWriteModeButton: 'Enable write mode',
});
