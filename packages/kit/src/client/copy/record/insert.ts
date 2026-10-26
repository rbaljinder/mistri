/** What insert says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  theConnectionOrView: 'The connection or view changed. Close this form and open a new one.',
  theTableDefinitionChangedClose: 'The table definition changed. Close this form and open a new one.',
  addingRecordsIsNoLonger: 'Adding records is no longer allowed.',
  added: 'Added {name} · {label}',
});
