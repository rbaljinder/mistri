/**
 * The query bar, in the middle of the screen — `components/Ask.tsx`. This
 * is the seam app.js calls: one open at a time, drawn on the body, and
 * the keyboard handed back to whatever opened it when it goes.
 */
import { createElement } from 'react';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* Loaded the first time it opens. */
const AskDialog = onDemand(() => import('./components/Ask.js'), 'AskDialog', { quiet: true });

let host = null;
let restoreFocus = null;

function closeAsk() {
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
  /* Back to whatever opened it. Without this the caret landed on the body,
     where the single-key shortcuts work — an Escape followed by a stray `h`
     went home from a view somebody had just decided not to leave. */
  restoreFocus?.focus?.();
  restoreFocus = null;
}

/**
 * Open it. `initial` is the line to start from — the one in the bar, so
 * this is "edit what I ran" as much as "write something new".
 * @param {{initial?: string, onRun?: (query: string) => void}} options
 */
export function openAsk({ initial = '', onRun } = {}) {
  if (host) return;
  restoreFocus = document.activeElement;
  host = document.createElement('div');
  host.className = 'host-contents';
  portalRoot().append(host);
  mount(host, createElement(AskDialog, { initial, onRun, onClose: closeAsk }));
}
