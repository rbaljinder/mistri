/** What export says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  exportedRows: { one: 'Exported {count} row.', other: 'Exported {count} rows.' },
  exportedAllMatchingRows: 'Exported all matching rows.',
  theExportCouldNotBeRead: 'The export could not be read.',
});
