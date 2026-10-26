/** What Document says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  print: 'Print / Save as PDF',
  printTitle: 'Print this {document}, or save it as a PDF from the print dialog',
  paper: '{size} paper',
  a4: 'A4',
  letter: 'Letter',
  numberCaption: 'No.',
  couldNotBeRead: 'This {document} could not be read.',
  lineCouldNotBeRead: 'These lines could not be read.',
  total: 'Total',
  noLines: 'No lines.',
  more: 'Only the first {count} lines are on this {document}.',
});
