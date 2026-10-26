/** What SchemaExport says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  export: 'Export',
  theDrawingAnySize: 'the drawing, any size',
  forChatAndSlides: 'for chat and slides',
  mermaid: 'Mermaid',
  rendersInAReadme: 'renders in a README',
  markdown: 'Markdown',
  columnsAndKeys: 'columns and keys',
  theStructuredSchema: 'the structured schema',
  exported: 'Exported {what} as {kind}.',
  theExportFailed: 'The export failed.',
  tablesWhatTheDiagram: { one: '{count} table — what the diagram is showing', other: '{count} tables — what the diagram is showing' },
  exportThisSchema: 'Export this schema',
  exporting: 'Exporting…',
  tables: { one: '{count} table', other: '{count} tables' },
  allTables: 'all {tables}',
  theSchema: 'the schema',
});
