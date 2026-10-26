/** What FindValue says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  findAValue: 'Find a value',
  searchesTheTextColumns:
    'Searches the text columns of every table, and uuid columns when the value is a whole uuid. Bounded: a few rows per table, and it says where it stopped.',
  aValueAName: 'A value — a name, an id, a reference…',
  valueToLook: 'Value to look for',
  looking: 'Looking for “{asked}”…',
  thatSearchFailed: 'That search failed.',
  nothingInTablesHolds: { one: 'Nothing in {count} table holds “{sought}”.', other: 'Nothing in {count} tables holds “{sought}”.' },
  thisTableHasNoKey: 'This table has no key to open a row by',
  tablesCouldNotBeSearched: { one: '{count} table could not be searched: ', other: '{count} tables could not be searched: ' },
  openTable: 'Open {table}',
  stoppedAtTheNarrow: 'Stopped at the {stopped}. Narrow the value to see the rest.',
  stoppedAtWithUnread: {
    one: 'Stopped at the {stopped}, with {count} table unread. Narrow the value to see the rest.',
    other: 'Stopped at the {stopped}, with {count} tables unread. Narrow the value to see the rest.',
  },
});
