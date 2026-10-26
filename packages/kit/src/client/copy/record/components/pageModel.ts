/** What pageModel says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  savedOnThisServer: 'saved on this server, for this connection',
  fromTheAppOrConnection: 'from the app or connection configuration',
  builtFromTheSchema: 'built from the schema',
});
