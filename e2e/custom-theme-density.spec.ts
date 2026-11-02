import { COMPASS, expect, type Page, test } from './support/ownServers';
import { focusStops, inPage, probePage, type Probe } from '../packages/mistri/src/server/build/gradeProbe';
import { TAP } from '../packages/mistri/src/server/build/gradeJudge';
import type { Browser } from '@playwright/test';

// This worker's own Compass (support/ownServers.ts): the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * Compass in its own registered theme, Meridian, at each density a reader can pick, measured by grade's own probe. A
 * custom theme that extends no look stands at the comfortable density, a zoom of 1.12 on the root, which the built-in
 * looks graded elsewhere (compact, no zoom) never put a page under. A grade of Compass in Meridian found what only that
 * meeting shows: the list behind the New form drawn over its fields, and every ring read at 1.79px.
 */
async function opened(browser: Browser, path: string, density: string, window: { width: number; touch?: boolean }) {
  const context = await browser.newContext({
    viewport: { width: window.width, height: 900 },
    ...(window.touch ? { hasTouch: true } : {}),
    reducedMotion: 'reduce',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: COMPASS,
          localStorage: [
            { name: 'mistri.tour.v1', value: 'done' },
            { name: 'mistri.custom-theme-choices', value: JSON.stringify([['compass', 'meridian']]) },
            { name: 'mistri.density', value: density },
          ],
        },
      ],
    },
  });
  const page = await context.newPage();
  await page.goto(`${COMPASS}${path}`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', '');
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
  return { page, close: () => context.close() };
}

const probe = async (page: Page, tap = 0) => (await page.evaluate(inPage(probePage, { tap, record: false }))) as Probe;
/** Every ring the Tab key shows, as grade reads it: none under the house 2px. */
const thinRings = async (page: Page) =>
  (await focusStops(page)).filter((stop) => stop.width > 0 && stop.width < 2).map((stop) => `${stop.what} ${stop.width}px`);

for (const density of ['compact', 'comfortable', 'spacious'])
  test(`Meridian at ${density}: the New form stands clear of the list, and every ring is 2px`, async ({ browser }) => {
    test.setTimeout(90_000);
    const desk = await opened(browser, '/leads/new', density, { width: 1280 });
    try {
      await expect(desk.page.locator('.newpanel .insert-field').first()).toBeVisible();
      expect((await probe(desk.page)).overlaps).toEqual([]);
      expect(await thinRings(desk.page)).toEqual([]);
    } finally {
      await desk.close();
    }
    const list = await opened(browser, '/contacts', density, { width: 1280 });
    try {
      await expect(list.page.locator('table.grid-fit').first()).toBeVisible();
      expect(await thinRings(list.page)).toEqual([]);
    } finally {
      await list.close();
    }
    const phone = await opened(browser, '/leads/new', density, { width: 390, touch: true });
    try {
      await expect(phone.page.locator('.newpanel .insert-field').first()).toBeVisible();
      const measured = await probe(phone.page, TAP);
      expect(measured.overlaps).toEqual([]);
      expect(measured.small.map((target) => `${target.what} ${target.width}×${target.height}`)).toEqual([]);
    } finally {
      await phone.close();
    }
  });

/* A page behind a form is out of reach while the form is open, as the form's aria-modal says: out of the accessibility
   tree and the Tab order, and under no finger. It comes back as it was when the form closes, and focus with it. The
   tree is the browser's own (Playwright's snapshot does not leave out what is inert). */
test('the list behind the New form is inert while the form is open, and live again once it closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${COMPASS}/leads`);
  const grid = page.locator('table.grid-fit').first();
  await expect(grid).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const inTree = async (name: string) => {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: Array<{ ignored: boolean; name?: { value?: unknown } }> };
    return nodes.some((node) => !node.ignored && String(node.name?.value ?? '').includes(name));
  };
  expect(await inTree('Margot Fontaine')).toBe(true);
  const opener = page.getByRole('button', { name: 'New lead' }).first();
  await opener.click();
  const form = page.getByRole('dialog', { name: 'New lead' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeVisible();
  expect(await grid.evaluate((table) => Boolean(table.closest('[inert]')))).toBe(true);
  expect(await inTree('Margot Fontaine')).toBe(false);
  await form.getByRole('button', { name: 'Close' }).click();
  await expect(form).toHaveCount(0);
  expect(await grid.evaluate((table) => Boolean(table.closest('[inert]')))).toBe(false);
  expect(await inTree('Margot Fontaine')).toBe(true);
  await expect(opener).toBeFocused();
});
