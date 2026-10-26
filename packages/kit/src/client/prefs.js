/**
 * The reader's own settings, in one quiet place.
 *
 * Density, rows per list, rows per related list: each existed (or wanted
 * to) as its own control in its own corner, which is fine for one
 * preference and a scavenger hunt for three. The dialog holds them
 * together; every choice applies as it is made, because a Save button on
 * a preferences panel is a promise the panel could have kept already.
 *
 * All of it is per-browser, like the theme: these are facts about the
 * reader's eyes and screen, not about the data, so they belong beside the
 * chair rather than in the team's config.
 */
import { createElement } from 'react';
import { mount, unmount } from './components/mount.js';
import { onDemand } from './components/onDemand.js';
import { portalRoot } from './shellHost.js';
export { relatedRows } from './relatedRows.js';

/* Loaded the first time it opens. */
const PrefsDialog = onDemand(() => import('./components/Prefs.js'), 'PrefsDialog', { quiet: true });

/** The dialog is `components/Prefs.tsx`; this is its one host on the body. */
export function openPrefs() {
  const host = document.createElement('div');
  host.className = 'host-contents';
  portalRoot().append(host);
  mount(
    host,
    createElement(PrefsDialog, {
      onClose: () => {
        unmount(host);
        host.remove();
      },
    }),
  );
}
