/*
 * Layers: the browser gate's own App for what a free-form page draws around itself — a layer (Drawer, Modal, Popover)
 * over the page, a bare page's window, a page with no head, the house controls at a phone's width. No sign-in: it is
 * a local App; and a record page whose related lists share a strip with a page's tab. Sized to e2e/page-layers.spec.ts;
 * the names are invented.
 */
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'layers',
  name: 'Layers',
  connection: 'layers',
  resources: { thing: {}, part: {}, note: {} },
  views: { things: listView('Things', 'thing') },
  nav: ['things'],
});
