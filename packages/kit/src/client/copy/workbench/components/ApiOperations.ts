/** What ApiOperations says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  theApisOwnSearch: "the API's own search",
  rowsToSkip: 'rows to skip',
  rowsPerPage: 'rows per page',
  pageNumber: 'page number',
  oneValueOrSeveral: 'one value, or several separated by commas',
  theApisOwnOrder: "The API's own order",
  theApisAnswer: "The API's answer",
  statusTime: '{status} · {ms} ms',
  theApiAnsweredTablewalk: 'The API answered {status}. tablewalk does not read the body of an error.',
  tryTheApi: 'Try the {table} API',
  read: 'Read',
  aList: 'A list',
  oneRecord: 'One record',
  theKeyTheItem: 'the key the item path names',
  thisListTakesNoParameters: 'This list takes no parameters.',
  send: 'Send',
  nextPage: 'Next page',
  theApisSearchOrASort: "The API's search, or a sort that names no column, has no equivalent in the table view.",
  openAsTable: 'Open as table',
});
