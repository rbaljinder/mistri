/** What sdk/page says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  definePageTakes: 'definePage takes the page: its label, reads and component.',
  definePageHasNo:
    'definePage has no "{name}". It takes path, label, icon, nav, roles, reads, commands, params, loader, public, description, favorite and component.',
  blocksUnregistered: '@mistriwork/mistri/page: no page has said how its blocks load.',
});
