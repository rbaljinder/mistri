/** What pagebuilder says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  newPage: 'New page',
  theConnectionOrEditor: 'The connection or editor changed. Reopen the page before saving changes.',
  thisServer: 'this server / {label}',
  saved: 'Saved "{name}".',
  deleted: 'Deleted "{name}".',
  pageNamePlaceholder: 'e.g. Customer 360',
  defaultConnection: 'default connection',
});
