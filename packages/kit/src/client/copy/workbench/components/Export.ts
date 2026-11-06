/** What Export says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  none: 'None',
  thatQueryNoLonger: 'That query no longer returns rows.',
  thisPageRows: { one: 'this page ({count} row)', other: 'this page ({count} rows)' },
  allMatchingRows: 'all matching rows ({count})',
  downloadThisResult: 'Download this result',
  export: 'Export',
  chooseColumns: 'Choose columns…',
  fetching: 'Fetching…',
  agent: 'Agent',
  theQueryTheShape: 'The query, the shape and how to run it over MCP — not the rows',
  copyThisPosition: 'Copy this position',
  streamedPastTheCap: 'Every matching row is written, read in batches as it downloads.',
  stoppedAtTheCap: 'This file stops at {max} rows: a support visit records each read whole, so its export is one read, not a stream.',
  pickAtLeastOne: 'Pick at least one column to export.',
  columnsToExport: 'Columns to export',
  tickedColumnsAreWritten:
    'Ticked columns are written in the order the table declares them. Choosing a column that is not on screen re-runs the query to fetch it.',
  asDisplayed: 'As displayed',
  ofSelected: '{filterCount} of {columnsCount} selected',
  notShown: 'not shown',
  rememberedForThisTable: 'Remembered for this table on this connection.',
  useTheseColumns: 'Use these columns',
  selectedOfDeclared: '{selected} of {declared}',
});
