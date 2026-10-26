/** What appUnavailable says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  noAppHere: 'No App here',
  noAppNamedHere: 'No App named "{requested}" here',
  thisServerServes: 'This server serves {value}:',
  thisServerServesNoApp: 'This server serves no App.',
  at: ' at /{id}',
  applicationUnavailable: 'Application unavailable',
  isUnavailable: '{name} is unavailable',
  theApplicationCouldNotConnect: 'The application could not connect to its database.',
  retry: 'Retry',
  noWorkspaceHere: 'No workspace here',
  noWorkspaceLivesAt: 'No workspace lives at this address. Check the link you followed, or sign in.',
  signIn: 'Sign in',
  oneApp: 'one App',
  apps: '{appsCount} Apps',
  application: 'Application',
});
