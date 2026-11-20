/*
 * Listtabs: the browser gate's own App for a record page whose related lists are a strip of tabs (`listTabs: true`),
 * where a tab holds an empty list and the list's Add stands on the strip's line. No sign-in: it is a local App,
 * served writable by e2e/page-layers.spec.ts. The names are invented.
 */
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'listtabs',
  name: 'Listtabs',
  connection: 'listtabs',
  resources: { thing: {}, part: { access: 'write' }, note: { access: 'write' } },
  views: { things: listView('Things', 'thing') },
  nav: ['things'],
});
