/**
 * Boot's sequence, from the look before the first paint to the main of the
 * product this page is (boot.js says how the parts are split).
 *
 * The look is the kit's, worn the same way whichever product answers. Then
 * one main runs the rest: the App framework's (appShell.js — its public
 * pages, sign-in and token consent, then the kit's shell with its chrome) or
 * the database browser's (workbenchShell.js — the kit's shell with the
 * Workbench's chrome and tools). The server says which in the page it sends
 * (server/clientSurface.ts, the `mistri-shell` meta the database browser's
 * pages carry); a page that says nothing is an App's.
 *
 * This is the client's bin, as packages/tablewalk/src/server/index.ts is the server's: the one
 * module that names both products' mains, each by import(), so a build
 * without one of them still boots the other (scripts/boundary/bins.json
 * `bin`, held by scripts/check-boundary.mjs). Nothing else here crosses into
 * either product. Both mains are first-paint code, never a round trip of
 * their own: the App framework's rides in the entry's chunk and the
 * Workbench's in the chunk its page preloads (vite.config.ts, `surfaces`).
 *
 * A module of its own so the same sequence runs where the page is not the
 * shell's: `@mistriwork/mistri/react` (src/embed/) starts it inside a host's route,
 * after pointing the seams (shellHost.ts, addressMount.js, transport.ts) at
 * the host's element, router and endpoint, and hands it the App framework's
 * main it has already loaded. Served, boot.js calls it once.
 */
import { initVisualTheme } from './visualTheme.js';
import { initTheme } from './theme.js';
import { applyDensity } from './density.js';
import { applyTypography } from './typography.js';
import { shellQuery } from './shellHost.js';

/**
 * The main the page names: the database browser's where the server said so.
 * @returns {Promise<import('./shells.js').ShellMain>}
 */
function namedMain() {
  return shellQuery('meta[name="mistri-shell"]')?.getAttribute('content') === 'workbench'
    ? import('tablewalk/client/workbenchShell.js')
    : import('@mistriwork/mistri/client/appShell.js');
}

/**
 * @param {import('./shells.js').ShellMain | Promise<import('./shells.js').ShellMain>} [main]
 *   the product's main, where the caller already knows it (the embed's is the App framework's)
 */
export async function startShell(main = undefined) {
  /* Before the first paint, so the page never flashes the wrong palette on
     the way to the right one. Density and typography for the same reason —
     they used to wait for the schema round trip inside applyBrand, which
     painted unzoomed for a beat and left the welcome screen (which returns
     before applyBrand ever runs) unstyled by them entirely. applyBrand
     applies them again on every connection switch; both are idempotent. */
  initVisualTheme();
  initTheme();
  applyDensity();
  applyTypography();
  await (await (main ?? namedMain())).start();
}
