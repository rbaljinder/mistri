/** What AppReloadProblem says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theLastSaveDidNotLoad: 'The last save did not load',
  stillServingTheLastGoodSave: 'Still serving the last good save. Save the file again to clear this.',
  aboutThisCode: 'What {code} means',
  linesAround: 'Lines around {file}:{line}',
  dismiss: 'Dismiss',
});
