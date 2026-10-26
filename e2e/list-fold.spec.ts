import { COMPASS, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* A list whose room cannot hold its columns folds them under the row's name as a detail line, after its heads and
   words have wrapped (gridSizing.ts). The name set on two lines there wraps as its cell does: it was its own
   nowrap line, so "Redgate Analytics Holdi…" stood over a detail line that wrapped whole beneath it (G187). */
test("a row's name over its folded columns wraps whole rather than being cut", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(`${COMPASS}/opportunities`);
  await expect(page.locator('td.has-more').first()).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  const names = await page.locator('td.wraps.has-more .cell-main').evaluateAll((nodes) =>
    nodes.map((name) => ({
      text: name.textContent,
      cut: name.scrollWidth > name.clientWidth + 1,
      lines: Math.round(name.offsetHeight / 16),
    })),
  );
  expect(names.length).toBeGreaterThan(5);
  expect(names.filter((name) => name.cut)).toEqual([]);
  // Some names are long enough to need their second line here, and take it.
  expect(names.some((name) => name.lines >= 2)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
