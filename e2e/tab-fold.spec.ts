import { COMPASS, expect, type Locator, type Page, test } from './support/ownServers';

// This worker's own Compass (support/ownServers.ts), the App at the root.
test.use({ servers: ['crm'] });

/**
 * A strip of tabs never scrolls sideways (docs/design.md): the tabs that do not fit its row go under More at its end
 * (useTabFold.ts). A tenant App's strips ran 648px in a 627px room at a desk, and past a phone's edge on its cases, alerts
 * and approvals. Held here on a list's strip and a record's, on a phone and on a narrow desk: the strip fits the
 * window and does not scroll, what is folded is under More and is chosen from there, and the tabs drawn at the first
 * paint are the ones drawn once the counts have arrived.
 */

/** Where each drawn tab is, and whether the strip, or the row holding it, runs past its box or the window. */
async function measure(strip: Locator) {
  return strip.evaluate((box) => {
    const view = document.documentElement.clientWidth;
    const row = box.closest('.applist-controls') ?? box;
    const shown = [...box.querySelectorAll<HTMLElement>('[data-fold]:not([data-folded])')];
    return {
      scrolls: box.scrollWidth > box.clientWidth + 1 || row.scrollWidth > row.clientWidth + 1,
      past: Math.max(...shown.map((tab) => tab.getBoundingClientRect().right), box.getBoundingClientRect().left) > view + 0.5,
      folded: box.querySelectorAll('[data-fold][data-folded]').length,
      shown: shown.map((tab) => tab.dataset.fold),
    };
  });
}

async function opened(page: Page, path: string, strip: string) {
  await page.goto(`${COMPASS}${path}`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', '');
  const located = page.locator(strip).first();
  await expect(located).toBeVisible();
  return located;
}

for (const [where, size] of [
  ['a phone', { width: 390, height: 844 }],
  ['a narrow desk', { width: 800, height: 800 }],
] as const) {
  test.describe(`on ${where}`, () => {
    test.use({ viewport: size });

    test("a list's tabs fit the row, the rest under More, chosen from there", async ({ page }) => {
      const strip = await opened(page, '/leads', '.applist-controls .tabs.folds');
      const first = await measure(strip);
      // A moment after: the counts have arrived, and no tab went under More for them.
      await page.waitForTimeout(1500);
      const settled = await measure(strip);
      expect(settled.scrolls, 'the strip and its row do not scroll').toBe(false);
      expect(settled.past, 'no tab is past the window').toBe(false);
      expect(settled.shown, 'the tabs drawn at the first paint are the ones drawn after').toEqual(first.shown);
      expect(settled.folded, 'six tabs and the list controls do not fit here').toBeGreaterThan(0);
      const more = strip.locator('.tab-more button');
      await expect(more).toBeVisible();
      await more.click();
      const last = page.locator('.page-actions-popup .page-actions-item').last();
      const word = ((await last.locator('span').first().textContent()) ?? '').trim();
      await last.click();
      const chosen = strip.locator('[role="tab"][aria-selected="true"]');
      await expect(chosen).toContainText(word);
      await expect(chosen).toBeVisible();
      const after = await measure(strip);
      expect(after.scrolls).toBe(false);
      expect(after.past).toBe(false);
    });

    test("a record's tabs fit the row, the rest under More, and the keyboard reaches them", async ({ page }) => {
      const strip = await opened(page, '/accounts/13', '.page-tabstrip.folds');
      const first = await measure(strip);
      await page.waitForTimeout(1500);
      const settled = await measure(strip);
      expect(settled.scrolls).toBe(false);
      expect(settled.past).toBe(false);
      expect(settled.shown).toEqual(first.shown);
      if (!settled.folded) {
        // Everything fits at this width: no More is drawn.
        await expect(strip.locator('.page-tab-more')).toBeHidden();
        return;
      }
      const tabs = strip.locator('[role="tab"]');
      const count = await tabs.count();
      // End reaches the last tab, folded or not: it is drawn in the row, chosen.
      await tabs.first().focus();
      await page.keyboard.press('End');
      const lastTab = tabs.nth(count - 1);
      await expect(lastTab).toHaveAttribute('aria-selected', 'true');
      await expect(lastTab).toBeVisible();
      await expect(lastTab).toBeFocused();
      const after = await measure(strip);
      expect(after.scrolls).toBe(false);
      expect(after.past).toBe(false);
    });
  });
}
