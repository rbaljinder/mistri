/**
 * Boot's sequence, from the look before the first paint to the main of the
 * product this page is (boot.js says how the parts are split).
 *
 * The look is the kit's, worn the same way whichever product answers. Then
 * one main runs the rest: the App framework's (appShell.js — its public
 * pages, sign-in and token consent, then the kit's shell with its chrome) or
 * the database browser's (workbenchShell.js — the kit's shell with the
 * Workbench's chrome and tools).
 *
 * Which one is the product's to say, not the kit's: the page imports
 * `virtual:mistri/shell-main`, and the product's build answers it with its
 * own main (the kit's Vite preset, `@mistriwork/kit/vite` `shellMain`), so
 * the kit names neither product and a product's bundle holds only its own
 * main. A workspace that serves more than one product from source answers it
 * with a module that picks by the page (this repository's vite.config.ts,
 * by the `mistri-shell` meta the database browser's pages carry). Each main
 * is first-paint code, never a round trip of its own: it rides in the chunk
 * its page preloads (the preset's `surfaces`).
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

/**
 * The product's main, as its build answers the name (shellMain.d.ts).
 * @returns {Promise<import('./shells.js').ShellMain>}
 */
function namedMain() {
  return import('virtual:mistri/shell-main');
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
