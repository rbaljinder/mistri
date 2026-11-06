import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';
import { startSample } from './support/sampleServer';
import { LONG_MS } from './support/budgets';

let sample: Awaited<ReturnType<typeof startSample>>;
const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      sample = await startSample('thread');
    },
    async () => {
      await sample?.stop();
    },
  ),
});

/* A list's columns are sized from its words measured in the page's fonts (gridSizing.ts). A width measured before a
   webfont arrived was kept for the page's life, so the same list came out with different columns from one load to the
   next, by whether the face beat the first measure (textMeasure.ts). Five cold loads must size alike. */
test.describe('List columns', () => {
  test('Thread issues size their columns alike on every load', async ({ browser }) => {
    test.setTimeout(LONG_MS);
    const widths: string[] = [];
    // Every other load has its font files held back, so the first measure is made in the fallback, as a slow load's is.
    for (let load = 0; load < 5; load++) {
      // A new context each time: nothing cached, so the face is as late as it can be.
      const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
      const page = await context.newPage();
      if (load % 2 === 1)
        await page.route(/\.woff2?(\?.*)?$/, async (route) => {
          await new Promise((done) => setTimeout(done, 1500));
          await route.continue();
        });
      await page.goto(`${sample.origin}/issues`);
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      // Past the re-measure a late face asks for.
      await page.waitForTimeout(500);
      widths.push(
        await page.evaluate(() =>
          [...document.querySelectorAll('thead th')].map((cell) => Math.round(cell.getBoundingClientRect().width)).join(','),
        ),
      );
      await context.close();
    }
    expect(new Set(widths).size, widths.join(' | ')).toBe(1);
  });
});
