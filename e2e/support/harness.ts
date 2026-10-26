/**
 * The test the specs actually import: Playwright's, plus a crash tripwire.
 *
 * The client is buildless and nothing executes it until a browser does, so
 * a constructor-time ReferenceError can blank whole views while every
 * static check and unit test stays green — which is exactly how a broken
 * dropdown once emptied every app list. Assertions only check what they
 * ask about; this fixture makes every test also assert the one thing all
 * of them mean: *the page did not crash*. Any uncaught page error fails
 * whichever test was running, with the error in the failure. So does a
 * section its error boundary caught (`[data-section-error]`), and any
 * Content-Security-Policy violation the browser reports.
 *
 * mutations.spec.ts imports Playwright's raw test on purpose — its whole
 * job is injecting broken client code and proving the suite notices, so
 * page errors there are the experiment, not the accident.
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ carryFirstPaint: boolean; _firstPaint: void; _crashTripwire: void }>({
  carryFirstPaint: [true, { option: true }],
  // Tests intercepting boot APIs need the supported fetch fallback, so their
  // responses are not replaced by the server's already-carried answers.
  _firstPaint: [
    async ({ page, carryFirstPaint }, use) => {
      if (!carryFirstPaint)
        await page.addInitScript(() => {
          // Leave navigation on the network: fulfilling a local document can make
          // Chrome treat its same-origin dev WebSocket as a local-network request.
          const remove = () => document.getElementById('mistri-first-paint')?.remove();
          const observer = new MutationObserver(remove);
          observer.observe(document, { childList: true, subtree: true });
          document.addEventListener(
            'DOMContentLoaded',
            () => {
              remove();
              observer.disconnect();
            },
            { once: true },
          );
        });
      await use();
    },
    { auto: true },
  ],
  _crashTripwire: [
    async ({ page }, use) => {
      const crashes: string[] = [];
      page.on('pageerror', (err) => crashes.push(String(err)));
      /* A section that threw is caught by its error boundary and drawn as a
       note, so it never reaches `pageerror`; the boundary's console line
       does (components/ErrorBoundary.tsx). So does the browser's report of
       anything the page's Content-Security-Policy refused. */
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (text.startsWith('a section could not be drawn.') || /Content Security Policy/i.test(text)) crashes.push(text);
      });
      await use();
      /* And the mark itself, where it still stands when the test ends. */
      const marked = await page
        .locator('[data-section-error]')
        .count()
        .catch(() => 0);
      if (marked) crashes.push(`${marked} section(s) drawn as could-not-be-drawn ([data-section-error])`);
      expect(crashes, 'uncaught page errors — the page crashed while this test ran').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
export type { Locator, Page } from '@playwright/test';
