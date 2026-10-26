/**
 * Columns that stay put when a wide table scrolls sideways.
 *
 * `packages/kit/src/client/pins.js` computes each frozen column's `left` from measured
 * widths, after layout, because column widths are fractional — 82.0234px — and
 * a `left` that lands a fraction of a pixel after the previous column ends
 * opens a hairline through which the scrolling content shows as a flickering
 * sliver. That was a real bug, it was found by looking at it, and the only way
 * to catch it again is to measure the boxes the browser actually drew.
 *
 * So these assertions are geometric on purpose. Nothing else here is.
 */
import { expect, type Locator, test, WIDE } from './support/ownServers';
import { grid } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/** A column header by the name written on its sort button. */
const header = (page: import('@playwright/test').Page, name: string): Locator =>
  page
    .locator('.table-wrap thead th')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^${name}\\b`) }) })
    .first();

async function box(locator: Locator): Promise<{ left: number; right: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return { left: rect.x, right: rect.x + rect.width };
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/${WIDE}/ticket`);
  await expect(page.locator('#db-label')).toContainText(WIDE);
  await expect(page.locator('.table-wrap tbody tr').first()).toBeVisible();
});

test('the columns that identify a row are frozen without being asked for', async ({ page }) => {
  /* `ticket` has sixteen columns, which is wider than the window — so reading
     the right of it means scrolling the left of it away, and the left is where
     the key and the name live. tablewalk already knows which columns identify a
     row, so it pins them: the primary key and the label column. */
  await expect(header(page, 'id')).toHaveClass(/pinned/);
  await expect(header(page, 'reference')).toHaveClass(/pinned/);
  await expect(header(page, 'status')).not.toHaveClass(/pinned/);
});

test('frozen columns stay at the edge while the rest scrolls away', async ({ page }) => {
  const wrap = grid(page);
  const port = await box(wrap);

  const statusBefore = await box(header(page, 'status'));

  await wrap.hover();
  await page.mouse.wheel(700, 0);
  await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300);

  const idAfter = await box(header(page, 'id'));
  const statusAfter = await box(header(page, 'status'));

  /* The key is against the scrollport's left edge — not merely still on
     screen. It arrives there rather than starting there, because the expander
     column ahead of it is not pinned and scrolls away underneath. */
  expect(Math.abs(idAfter.left - port.left)).toBeLessThanOrEqual(1);

  // An ordinary column has gone the other way, which is what proves the table
  // scrolled rather than the assertion above being vacuous.
  expect(statusAfter.left).toBeLessThan(statusBefore.left - 300);
});

test('there is no gap between two frozen columns', async ({ page }) => {
  const wrap = grid(page);
  await wrap.hover();
  await page.mouse.wheel(700, 0);
  await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300);

  const id = await box(header(page, 'id'));
  const reference = await box(header(page, 'reference'));

  /* `<= 0`, not `=== 0`: the offsets are rounded *down* so consecutive frozen
     columns overlap by a fraction of a pixel rather than leaving one. An
     overlap is invisible; a gap is a flickering line of scrolling content. */
  expect(reference.left - id.right).toBeLessThanOrEqual(0);
  // And they are still adjacent rather than one having drifted a column away.
  expect(reference.left - id.right).toBeGreaterThan(-2);
});

test('a body cell freezes with its header, so the column stays whole', async ({ page }) => {
  /* Freezing the header alone would leave the values scrolling under a fixed
     label, which is worse than not freezing at all: the number under `id`
     would belong to another column. */
  const wrap = grid(page);
  await wrap.hover();
  await page.mouse.wheel(700, 0);
  await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300);

  const headBox = await box(header(page, 'id'));
  const cell = page.locator('.table-wrap tbody tr').first().locator('td.pinned').first();
  const cellBox = await box(cell);
  expect(Math.abs(cellBox.left - headBox.left)).toBeLessThanOrEqual(1);
});
