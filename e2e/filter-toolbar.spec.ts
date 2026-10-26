import { CRM, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

for (const width of [1024, 390])
  test(`filter selection keeps one toolbar row and stable results at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
    await page.goto(`${CRM}/opportunities`);
    const controls = page.getByRole('group', { name: 'Opportunities list controls' });
    const results = page.locator('.applist-grid').first();
    const firstRow = width > 600 ? results.locator('tbody tr').first() : results.getByRole('listitem').first();
    await expect(firstRow).toBeVisible();
    /* On a phone the tabs take a row of their own under the search and Filters, and fold what does not fit under
       More (00b025f7): sharing the one row, the first tab's count was cut off. Elsewhere the strip is
       one row. */
    const phone = width <= 760;
    await expect(controls).toHaveCSS('flex-wrap', phone ? 'wrap' : 'nowrap');
    await expect(controls).toHaveCSS('flex-shrink', '0');
    await expect(controls.locator('.applist-fields')).toHaveCSS('flex-wrap', phone ? 'wrap' : 'nowrap');
    const before = { controls: (await controls.boundingBox())!, results: (await results.boundingBox())! };
    /* On a desk the box opens its own picker, unless the row folded it into
     "+ Filter", which opens the sheet, as a phone's Filters does. */
    const box = controls.getByRole('button', { name: 'Filter by Close date', exact: true });
    const popover = width > 600 && (await box.isVisible());
    if (popover) await box.click();
    else
      await (
        width > 600
          ? controls.getByRole('button', { name: /^More filters:/ })
          : controls.getByRole('button', { name: 'Filters', exact: true })
      ).click();
    const picker = popover ? page.locator('.filter-pop-form') : page.locator('.filter-sheet');
    await picker.getByRole('textbox', { name: 'From', exact: true }).fill('2026-09-01');
    await picker.getByRole('textbox', { name: 'To', exact: true }).fill('2026-12-31');
    await picker
      .locator(popover ? '.filter-pop-foot' : '.filter-sheet-foot')
      .getByRole('button', { name: /^Show / })
      .click();
    await expect(picker).toHaveCount(0);
    await expect(controls.locator('.applist-chip[data-column="close_date"]')).toBeVisible();
    await expect(firstRow).toBeVisible();
    const after = { controls: (await controls.boundingBox())!, results: (await results.boundingBox())! };
    if (phone) {
      /* A phone's strip wraps the chip onto a row of its own (docs/design.md, "Standing layout rules"), so the bar
         grows by that row and the results move down by exactly as much: none under the bar, none left a gap. */
      const grew = after.controls.height - before.controls.height;
      expect(grew).toBeGreaterThan(0);
      expect(Math.abs(after.results.y - before.results.y - grew)).toBeLessThan(1);
    } else {
      expect(Math.abs(after.controls.height - before.controls.height)).toBeLessThan(1);
      expect(Math.abs(after.results.y - before.results.y)).toBeLessThan(1);
    }
    expect(after.controls.x).toBeGreaterThanOrEqual(0);
    expect(after.controls.x + after.controls.width).toBeLessThanOrEqual(width);
    const tabs = (await controls.getByRole('tablist').boundingBox())!;
    const fields = (await controls.locator('.applist-fields').boundingBox())!;
    if (phone) {
      expect(tabs.y).toBeGreaterThanOrEqual(fields.y + fields.height - 0.5);
      expect(Math.abs(tabs.x - fields.x)).toBeLessThan(1);
      expect(tabs.x + tabs.width).toBeLessThanOrEqual(after.controls.x + after.controls.width + 0.5);
    } else expect(Math.abs(tabs.y + tabs.height / 2 - fields.y - fields.height / 2)).toBeLessThan(1);
    // The last control is in reach without scrolling: the filters fold into
    // "+ Filter" and the tabs into More (useTabFold.ts), so neither the row nor
    // the tabs' strip scrolls sideways to show it. The control to try is the one furthest right *on screen*, which is not the
    // last in the DOM: under 860px the strip puts its verbs first so Filters —
    // the only way to the facets once the rail has folded — is not behind a
    // horizontal scroll. Asking the page which control is furthest right keeps
    // this a test of reachability rather than of source order. On a phone the
    // tabs have a row of their own.
    const scroller = phone ? controls.getByRole('tablist') : controls;
    const bounds = phone ? tabs : after.controls;
    const focused = await scroller.evaluate((element) => {
      const buttons = [...element.querySelectorAll('button')].filter((button) => button.offsetParent !== null);
      const furthest = buttons.reduce(
        (best, button) => (button.getBoundingClientRect().right > best.getBoundingClientRect().right ? button : best),
        buttons[0]!,
      );
      furthest.focus();
      const box = furthest.getBoundingClientRect();
      return { focused: document.activeElement === furthest, scrollLeft: element.scrollLeft, x: box.x, width: box.width };
    });
    expect(focused.focused).toBe(true);
    expect(focused.scrollLeft).toBe(0);
    // Half a pixel either way: the edges are fractional, and Linux's fonts once
    // put the last button 0.016px past a strip it sat inside.
    expect(focused.x).toBeGreaterThanOrEqual(bounds.x - 0.5);
    expect(focused.x + focused.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5);
  });

// A field report from the user's own App: Lumen's facet rule matched the facet inside the filter popover too and
// stripped its side padding, so the choices touched the popover's edge.
test('the filter popover keeps its side padding under Lumen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
  await page.goto(`${CRM}/opportunities`);
  const controls = page.getByRole('group', { name: 'Opportunities list controls' });
  await expect(controls).toBeVisible();
  await controls.getByRole('button', { name: 'Filter by Close date', exact: true }).click();
  const facet = page.locator('.filter-pop .facet').first();
  await expect(facet).toBeVisible();
  const pad = await facet.evaluate((el) => {
    const css = getComputedStyle(el);
    return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight) };
  });
  expect(pad.left).toBeGreaterThan(0);
  expect(pad.right).toBeGreaterThan(0);
});
