import { COMPASS, expect, type Locator, type Page, test } from './support/ownServers';
import { chooseTab } from './support/tabs';

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

/**
 * The strip as each frame drew it: read in a task the frame's animation callback posts, which runs once that frame's
 * layout, ResizeObservers and paint are done; a frame after which the page changed again before that task ran is left
 * out, since what it holds was not drawn. Each record is the tab chosen, the tabs folded, and the strip's width.
 */
function recordFrames() {
  const drawn: string[] = [];
  (window as unknown as { stripFrames: string[] }).stripFrames = drawn;
  let changed = 0;
  let framed = 0;
  new MutationObserver(() => (changed = performance.now())).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const read = new MessageChannel();
  read.port1.onmessage = () => {
    const strip = document.querySelector<HTMLElement>('.applist-controls .tabs.folds');
    if (changed > framed || !strip) return;
    const chosen = strip.querySelector('[role="tab"][aria-selected="true"]');
    const said = `${chosen?.textContent ?? ''} folded=${[...strip.querySelectorAll<HTMLElement>('[data-fold][data-folded]')].map((tab) => tab.dataset.fold)} width=${strip.getBoundingClientRect().width.toFixed(1)}`;
    if (drawn.at(-1) !== said) drawn.push(said);
  };
  const frame = () => {
    framed = performance.now();
    read.port2.postMessage(0);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const framesSince = (page: Page) => page.evaluate(() => (window as unknown as { stripFrames: string[] }).stripFrames.splice(0));

/** The frames drawn from the first that shows `word` chosen: what the reader saw once the tab was theirs. */
function chosenFrames(frames: string[], word: string) {
  const from = frames.findIndex((frame) => frame.startsWith(word));
  return from === -1 ? frames : frames.slice(from);
}

/**
 * A strip holds still while the tab just chosen loads its rows. The badges were each said as their batch said them,
 * and the strip's batch leaves out the tab on screen, whose count is its grid's: from the batch's answer to the rows',
 * that tab's badge stood empty, a narrower tab. A service-desk App's Inbox, at a desk whose strip had just too little
 * room for its last tab, drew that tab in the row and took More away on every visit and every switch, and put them
 * back when the rows came: the strip flickered. Where nothing folds, the search box beside it jumped instead.
 * Compass's All counts three figures, so its badge emptying gave back 8px; the rows are held a moment, as a remote
 * database holds them, so the frames between are many.
 */
test.describe('while a chosen tab loads its rows', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/run**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.addInitScript(recordFrames);
  });

  test('the strip, and the search beside it, do not move', async ({ page }) => {
    const strip = await opened(page, '/leads', '.applist-controls .tabs.folds');
    await expect(strip.locator('[role="tab"]', { hasText: 'All' }).locator('.tab-count')).toHaveText(/\d{3}/);
    await framesSince(page);
    await chooseTab(page, /^All/);
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toContainText('All');
    await page.waitForTimeout(1000);
    const frames = chosenFrames(await framesSince(page), 'All');
    expect(frames, 'one drawing of the strip from the choice on').toHaveLength(1);
  });

  test('a strip at the edge of its fold keeps what is under More', async ({ page }) => {
    const strip = await opened(page, '/leads', '.applist-controls .tabs.folds');
    await expect(strip.locator('[role="tab"]', { hasText: 'All' }).locator('.tab-count')).toHaveText(/\d{3}/);
    await chooseTab(page, /^All/);
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toContainText('All');
    await page.waitForTimeout(600);
    /* The narrowest window that draws every tab, All chosen: one pixel less and a tab goes under More. */
    const folded = () => strip.evaluate((box) => box.querySelectorAll('[data-fold][data-folded]').length);
    let fits = 1280;
    let short = 600;
    while (fits - short > 1) {
      const width = Math.round((fits + short) / 2);
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      if (await folded()) short = width;
      else fits = width;
    }
    /* Two pixels short of the room for every tab: an emptied badge of three figures would give it back. */
    await page.setViewportSize({ width: fits - 2, height: 800 });
    await expect.poll(folded).toBeGreaterThan(0);
    await chooseTab(page, /^New/);
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toContainText('New');
    await page.waitForTimeout(1000);
    await framesSince(page);
    await chooseTab(page, /^All/);
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toContainText('All');
    await page.waitForTimeout(2000);
    const frames = chosenFrames(await framesSince(page), 'All');
    expect(frames, 'one drawing of the strip from the choice on: nothing came out from under More and went back').toHaveLength(1);
    expect(frames[0]).not.toMatch(/folded=(\s|$)/);
  });
});
