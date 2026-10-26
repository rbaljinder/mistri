/** What useBulkSelection says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  setColumn: 'Set {column}',
  doesNotMatchNow: 'Does not match "{when}" now.',
  selectedRecords: 'Selected records',
  selected: '{selectionCount} selected',
  setField: 'Set field…',
  oneRequestForTheWhole: 'One request for the whole selection: every record or none.',
  clearSelection: 'Clear selection',
  applying: 'Applying {done} of {total}…',
  selectionIsLimitedToRecords: 'Selection is limited to {max} records.',
  applyToSelectedRecords: { one: 'Apply to {count} selected record', other: 'Apply to {count} selected records' },
  willBeSkipped: '; {skipped} will be skipped',
  countSelectedRecords: { one: '{count} selected record', other: '{count} selected records' },
});
