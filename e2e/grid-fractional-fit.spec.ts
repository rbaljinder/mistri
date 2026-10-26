import { expect, test } from './support/harness';

const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}`;

test('fit grids do not acquire a fractional scrollbar, and a narrow embedded grid leaves out columns', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side' };
    await route.fulfill({ response, json: payload });
  });
  await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
  await page.setViewportSize({ width: 1920, height: 960 });
  await page.goto(`${CRM}/`);
  const grid = page.locator('.dash-list .table-wrap').first();
  await expect(grid.locator('table.grid-fit')).toBeVisible();
  // Fractional content boxes reproduce the browser's rounding at density zoom.
  await grid.evaluate((element) => {
    element.style.width = '1365.58px';
    element.style.maxWidth = 'none';
  });
  await page.locator('html').evaluate((element) => {
    element.style.zoom = '1.15';
  });
  await expect.poll(() => grid.locator('table').evaluate((element) => parseFloat(element.style.width))).toBe(1365);
  const scrollRange = () =>
    grid.evaluate((element) => {
      element.scrollLeft = 10000;
      const range = element.scrollLeft;
      element.scrollLeft = 0;
      return range;
    });
  // Integer scrollWidth/clientWidth equality misses the original subpixel range.
  await expect.poll(scrollRange).toBe(0);
  /* A dashboard's list keeps to its width: past it, columns are left out
     from the end rather than scrolled to (docs/design.md, table building
     blocks). Its box still scrolls what cannot go, as every wide thing does;
     what the leaving-out made fit (the row's name gives way since 0.9.5) is
     no scroller, so its head sticks to the page (useStickyHead). */
  const heads = await grid.locator('thead th').count();
  await grid.evaluate((element) => {
    // Narrower than the name's floor and the status beside it, which are never left out: something must scroll.
    element.style.width = '260px';
  });
  await expect.poll(() => grid.locator('thead th').count()).toBeLessThan(heads);
  const box = () =>
    grid.evaluate((element) => {
      const fits = element.querySelector(':scope > table')!.scrollWidth <= element.clientWidth + 1;
      return { fits, marked: element.hasAttribute('data-fits'), scrolls: getComputedStyle(element).overflowX === 'auto' };
    });
  await expect
    .poll(async () => {
      const { fits, marked, scrolls } = await box();
      return marked === fits && scrolls === !fits;
    })
    .toBe(true);
});
