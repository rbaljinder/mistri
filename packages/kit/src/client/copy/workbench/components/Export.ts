/** What Export says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  none: 'None',
  thatQueryNoLonger: 'That query no longer returns rows.',
  thisPageRows: { one: 'this page ({count} row)', other: 'this page ({count} rows)' },
  allMatchingRows: 'all matching rows ({capped})',
  downloadThisResult: 'Download this result',
  export: 'Export',
  chooseColumns: 'Choose columns…',
  fetching: 'Fetching…',
  agent: 'Agent',
  theQueryTheShape: 'The query, the shape and how to run it over MCP — not the rows',
  copyThisPosition: 'Copy this position',
  cappedAtRowsTheSame: 'Capped at {max} rows — the same ceiling every read in this tool has. Narrow the query to export the rest.',
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
