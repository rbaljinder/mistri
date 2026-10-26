/** What SetFieldDialog says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  setAField: 'Set a field',
  writesOneValueToEach: 'Writes one value to {records}. Each is saved on its own, and one that is refused leaves the others as they are.',
  field: 'Field',
  set: 'Set {column}',
  countSelectedRecords: { one: '{count} selected record', other: '{count} selected records' },
});
