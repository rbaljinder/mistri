/** What AppLanding says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  aDashboard: '{label} — a dashboard',
  aForm: '{label} — a form',
  go: 'Go to',
  stillShowingTheLast: 'Still showing the last good save — {loadError}',
});
