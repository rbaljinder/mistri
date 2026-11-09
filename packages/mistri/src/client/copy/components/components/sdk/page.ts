/** What sdk/page says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  definePageTakes: 'definePage takes the page: its label, reads and component.',
  definePageHasNo:
    'definePage has no "{name}". It takes path, label, icon, nav, roles, reads, commands, forms, params, loader, public, description, favorite, head, layout and component.',
  defineSurfaceTakes: 'defineSurface takes the surface: its label and reads.',
  defineSurfaceHasNo:
    'defineSurface has no "{name}". It takes label, icon, description, favorite, roles, reads, commands, forms and loader.',
  commandDone: '{label} done.',
  listNotYours: 'This list is not available to your role.',
  listForMembers: 'This list is for signed-in members.',
  listShowingFirst: 'Showing the first {count}.',
  listNamesNoResource: '<List> reads no resource: give it `from`, or draw it inside a <Scope from>.',
  recordKeyOutside:
    'useRecordKey reads the record a page is a tab of, and "{label}" is not a record\'s tab: place it at pages/<list view>/[id]/<tab>.page.tsx.',
  recordKeyUnnamed:
    "useRecordKey reads the record a page is a tab of, and this page is not a record's tab: place it at pages/<list view>/[id]/<tab>.page.tsx.",
  recordKeyOther: 'useRecordKey("{resource}") on a tab of a "{table}" record: name the record\'s own resource, "{table}".',
  recordKeyUnread:
    'useRecordKey("{resource}"): "{label}" reads {map}. A record\'s tab reads its record\'s resource: add "{resource}" to its reads.',
  blocksUnregistered: '@mistriwork/mistri/page: no page has said how its blocks load.',
});
