import { test, expect } from './support/harness.js';
import { startBrandedFontApp, type BrandedFontApp } from './support/brandedFontServer.js';

// e2e-lane: shared — it measures layout shift, which another browser's load changes.
// A tenant picks the face its people read in. The page that wears the tenant's look says the face from the first byte
// (an @font-face and a preload of the file), so the first paint is set in it and nothing is swapped after: the layout
// does not shift (Core Web Vitals' CLS under 0.01, as every page holds).
let app: BrandedFontApp;
test.beforeAll(async () => {
  app = await startBrandedFontApp();
});
test.afterAll(async () => {
  await app?.stop();
});

test("a tenant's font draws the page it is saved for, preloaded, with a layout shift under 0.01", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { shifts: number }).shifts = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>)
        if (!entry.hadRecentInput) (window as unknown as { shifts: number }).shifts += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(app.page);
  await expect(page.getByRole('heading', { name: 'Apply for financing' }).first()).toBeVisible();
  // Declared and preloaded before any script ran: what the head says, not what the client added.
  const source = await (await page.request.get(app.page)).text();
  expect(source).toMatch(
    /<link rel="preload" as="font" type="font\/woff2" crossorigin href="\/yard\/_fonts\/figtree-[0-9a-f]{12}\.woff2">/,
  );
  expect(source).toContain('@font-face{font-family:"Figtree"');
  // The page is drawn in it, and the face is the one the head named.
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  expect(await page.evaluate(`getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim()`)).toBe('Figtree');
  expect(await page.evaluate(`document.fonts.check('16px Figtree')`)).toBe(true);
  // Let the page settle and then measure what moved while it did.
  await page.waitForTimeout(1500);
  // The measure itself is live: a browser that cannot report shifts would pass this by saying nothing.
  expect(await page.evaluate(`PerformanceObserver.supportedEntryTypes.includes('layout-shift')`)).toBe(true);
  const shift = Number(await page.evaluate(`window.shifts`));
  expect(shift).toBeLessThan(0.01);
});

test('the font is not worn by a page that names no such tenant', async ({ page }) => {
  await page.goto(`${app.origin}/yard/form/apply`);
  await expect(page.getByRole('heading', { name: 'Apply for financing' }).first()).toBeVisible();
  expect(await page.evaluate(`getComputedStyle(document.body).fontFamily.includes('Figtree')`)).toBe(false);
});
