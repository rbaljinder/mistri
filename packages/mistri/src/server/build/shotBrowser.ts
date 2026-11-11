/**
 * A browser that is started again every so many routes. Grade opens a context for each window of each route and closes
 * it, so no context outlives its window, but Chromium's own processes (its network, GPU and utility helpers, the
 * renderers it keeps warm) only grow across thousands of them: a field report had a grade over many routes take an
 * 8 GB machine's browser down. Starting it afresh bounds that, at about a second a restart: spread over `every`
 * routes, a few hundredths of a second each.
 */
import type { Browser } from 'playwright-core';

/** Routes between restarts: ten routes are some sixty windows, a fraction of what brought the browser down. */
const RECYCLE_EVERY = 10;

interface BrowserLease {
  /** The browser for the next route: the same one, or a new one once `every` routes have used it. */
  forRoute(): Promise<Browser>;
}

export function recycledBrowser(first: Browser, restart: () => Promise<Browser>, every: number = RECYCLE_EVERY): BrowserLease {
  let current = first;
  let used = 0;
  return {
    async forRoute() {
      if (used >= every) {
        current = await restart();
        used = 0;
      }
      used++;
      return current;
    },
  };
}
