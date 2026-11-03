/** What visualTheme says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  default: 'Default',
  workbenchDefault: 'Workbench default',
  hostLookId: 'A host look\'s id is lowercase letters, digits and dashes: "{id}".',
  hostLookTaken: 'The host look "{id}" has a name the picker already offers.',
});
