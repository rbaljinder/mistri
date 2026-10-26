/**
 * Which table mentions this? — `components/FindValue.tsx`. The seam app.js
 * calls: one panel at a time, drawn on the body.
 */
import { createElement } from 'react';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* Loaded the first time it opens. */
const FindValueDialog = onDemand(() => import('./components/FindValue.js'), 'FindValueDialog', { quiet: true });

let host = null;

function close() {
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
}

export function openFindValue(initial = '') {
  if (host) return;
  host = document.createElement('div');
  host.className = 'host-contents';
  portalRoot().append(host);
  mount(host, createElement(FindValueDialog, { initial, onClose: close }));
}
