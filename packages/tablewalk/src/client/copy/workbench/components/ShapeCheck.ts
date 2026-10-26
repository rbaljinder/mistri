/** What ShapeCheck says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  checkTheShape: 'Check the shape',
  readingTheCatalog: 'Reading the catalog…',
  highMediumLowRead: '{high} high, {medium} medium, {low} low — read from the catalog alone: no queries, no guesses about intent.',
  nothingToReportNoMissing: 'Nothing to report: no missing keys, unindexed references or naive timestamps.',
  openTable: 'Open {table}',
});
