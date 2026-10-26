/** What tour says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  theDatabase: 'The database you are on',
  clickItToSwitch: 'Click it to switch, add another, or edit one. Everything else on the ',
  screenComesFromWhichever: 'screen comes from whichever one is named here.',
  everyTableWithItsSize: 'Every table, with its size',
  theNumberIsHow: 'The number is how many rows are in it. Views are marked. Click one to browse it.',
  askInWordsNotSql: 'Ask in words, not SQL',
  tableFirstThenConditions: 'Table first, then conditions, then sort and limit. Press ? for the full ',
  grammarOrSqlToSee: 'grammar, or SQL to see what it compiled to.',
  aRowIsAPlace: 'A row is a place, not a record',
  clickAnyRowAndYouGet: 'Click any row and you get every row elsewhere that points at it. The ',
  ordersOnACustomer: 'orders on a customer, the customer on an order. No joins to write, and ',
  aTrailBehindYouThatGoes: 'a trail behind you that goes back the way you came.',
  readOnlyUntilYouSay: 'Read only until you say otherwise',
  theWorkbenchStartsRead: 'The workbench starts read-only. Open this menu and choose Editing enabled ',
  toEditThisConnection: 'to edit this connection. Review and apply your changes; ⌘Z undoes an edit.',
  andTheRest: 'And the rest',
  kJumpsToAny: '⌘K jumps to any table, view or database. ··· has the diagram, the ',
  exportsSavedViewsAndThisTour: 'exports, saved views, and this tour again.',
  takeTheTour: 'Take the tour',
  sixThingsWorthKnowing: 'six things worth knowing',
});
