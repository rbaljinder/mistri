/** What ConnectionPicker says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  databaseConnection: 'Database connection',
  reReadTheSchema: '↻ Re-read the schema',
  manageConnections: 'Manage connections',
  unreachableDetail: '{detail} · unreachable',
});
