/** What schemaexport says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  theDiagramCouldNotBeRendered: 'The diagram could not be rendered as an image.',
  thereIsNoDiagram: 'There is no diagram to export.',
  unknownExportFormat: 'Unknown export format: {kind}',
});
