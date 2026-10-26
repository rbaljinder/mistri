/** What FilterBoxes says, in the filter rail room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  filtersByTheId: 'Filters by {column} — the id, even where the column shows a name.',
  couldNotResolveRecord: 'Could not resolve record name.',
  couldNotLoadRecords: 'Could not load records.',
  lookupUnavailable: 'Lookup unavailable.',
  couldNotLoadRecordsClose: 'Could not load records. Close and reopen to retry.',
  noRecordsAvailable: 'No records available.',
  typeANameAndPick: 'Type a {name} name and pick — or an id.',
  backToTheUnfiltered: 'Back to the unfiltered table',
});
