/** What FieldArranger says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  fields: 'Fields',
  ofDragToArrange: '{chosenCount} of {allCount} · drag to arrange',
  everyFieldInTheTables: 'Every field, in the table’s own order',
  none: 'None',
  position: '{name} — position {i} of {chosenCount}',
  moveThisFieldToAnother: 'Move this field to another group',
  moveToAnotherGroup: 'Move {name} to another group',
  takeThisFieldOff: 'Take this field off the {noun}',
  remove: 'Remove {name}',
  noFieldsInThisGroup: 'No fields in this group yet.',
  everyField: 'Every field is on the {noun}',
  addToThisGroup: 'Add {name} to this group',
  add: 'Add {name}',
});
