/** What startup says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  couldNotStartTheApplication: 'The application could not start.',
  couldNotStart: '{name} could not start.',
  unexpectedStartupError: 'Unexpected startup error.',
});
