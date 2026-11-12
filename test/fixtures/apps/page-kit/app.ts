/*
 * Page kit: the browser gate's own App for the vocabulary a free-form page lays itself out with — a rail beside a
 * main column, rows with a lead and a tone, a button that is a link, a placeholder while a read is out, a segmented
 * choice with counts, a file field. No sign-in: it is a local App. Sized to e2e/page-kit.spec.ts; the names are invented.
 */
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'page-kit',
  name: 'Page kit',
  connection: 'page-kit',
  resources: { thing: {}, part: {}, note: {} },
  views: { things: listView('Things', 'thing') },
  nav: ['things'],
});
