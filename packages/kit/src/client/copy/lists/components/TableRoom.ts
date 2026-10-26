/** What TableRoom says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  fixTheQueryAbove: 'Fix the query above to see results.',
  notAvailableToYou: 'This {thing} is not available to your role.',
  notAvailableHere: 'This {thing} is not available.',
  signInToSeeThis: 'This {thing} is for signed-in members.',
  thingList: 'list',
  thingRecord: 'record',
  thingPage: 'page',
  storedDefinition: 'Stored definition. ',
  thisIsTheStatement: 'This is the statement the database itself keeps, verbatim.',
  rebuiltFromTheCatalog: 'Rebuilt from the catalog. Indexes, checks and triggers are not shown.',
});
