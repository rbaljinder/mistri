/** What Landing says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  stillShowingTheLast: 'Still showing the last good save — {error}',
  yourRoleGrantsNoTables: 'Your role grants no tables in this App yet.',
  askAnAdministrator: "An administrator grants what each role reads in the App's roles.",
});
