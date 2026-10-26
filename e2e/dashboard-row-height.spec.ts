import { COMPASS, expect, test } from './support/ownServers';
import { readings } from './support/contrast';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * Widgets in one row of a dashboard are one height (docs/design.md): the
 * metric strip's cards, those with a trend and one without, and a breakdown
 * beside a chart. Each stretches to the row; a metric's trend sits on the
 * card's bottom edge. Compass's home dashboard has all three.
 */
test('widgets in one dashboard row stand at one height', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(COMPASS);
  const cards = page.locator('.dash-strip .home-card');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  /* Won (`spark: true`) and New leads (a window, so its trend is the window's own) draw one; Open pipeline, with
     neither, does not. */
  await expect(page.locator('.dash-strip .spark-host')).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);

  const boxes = await cards.evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { top: r.top, height: r.height, bottom: r.bottom };
    }),
  );
  expect(boxes.length).toBeGreaterThan(2);
  for (const box of boxes) {
    expect(box.height).toBeCloseTo(boxes[0]!.height, 0);
    expect(box.top).toBeCloseTo(boxes[0]!.top, 0);
  }
  /* The trend stands on the card's bottom edge, not under the figure; where the strip is divided (Lumen's), it stands
     beside the figure instead, on the figure's line (lumenLook.css), so no card is a line taller than the rest. */
  const gaps = await page.locator('.dash-strip .home-card:has(.spark-host)').evaluateAll((cards) =>
    cards.map((card) => {
      const spark = card.querySelector('.spark-host')!.getBoundingClientRect();
      if (document.documentElement.dataset.lookStat === 'divided') {
        const figure = card.querySelector('.home-card-value')!.getBoundingClientRect();
        return (spark.top + spark.bottom) / 2 - (figure.top + figure.bottom) / 2;
      }
      const style = getComputedStyle(card);
      return card.getBoundingClientRect().bottom - spark.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
    }),
  );
  expect(gaps).toHaveLength(2);
  for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(4);

  // A breakdown and a chart that share a row are the same height.
  const halves = await page.locator('.dash-body .page-section.width-half').evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { top: Math.round(r.top), height: r.height };
    }),
  );
  const row = halves.filter((h) => h.top === halves[0]!.top);
  expect(row.length).toBeGreaterThan(1);
  for (const h of row) expect(h.height).toBeCloseTo(row[0]!.height, 0);
});

/**
 * On a phone the figures sit two to a row: one per row made a
 * run of eight a column three screens tall. Each is half the strip, an odd
 * run's first takes the row, and no figure breaks across two lines.
 */
test('a phone lays a run of metric cards two to a row', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(COMPASS);
  const cards = page.locator('.dash-strip').first().locator('.home-card');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  const laid = await page
    .locator('.dash-strip .home-cards')
    .first()
    .evaluate((strip) => {
      const width = strip.getBoundingClientRect().width;
      return [...strip.querySelectorAll(':scope > .home-card')].map((card) => {
        const box = card.getBoundingClientRect();
        const value = card.querySelector('.home-card-value') as HTMLElement | null;
        const line = value ? parseFloat(getComputedStyle(value).lineHeight) || parseFloat(getComputedStyle(value).fontSize) * 1.3 : 0;
        return { top: Math.round(box.top), share: box.width / width, lines: value ? value.getBoundingClientRect().height / line : 0 };
      });
    });
  expect(laid.length).toBeGreaterThan(1);
  /* An odd run leads with its first figure across the row and pairs the rest: a lone last one, stretched under the
     pairs, read as an afterthought, and three of them always left one so. */
  const odd = laid.length % 2 === 1;
  if (odd) expect(laid[0]!.share, 'an odd run leads with its first figure across the row').toBeGreaterThan(0.95);
  for (let at = odd ? 1 : 0; at < laid.length; at += 2) {
    const [left, right] = [laid[at]!, laid[at + 1]];
    expect(right, `figure ${at} has a partner`).toBeDefined();
    if (!right) continue;
    expect(right.top, `figures ${at} and ${at + 1} share a row`).toBe(left.top);
    for (const card of [left, right]) {
      expect(card.share).toBeGreaterThan(0.4);
      // Half the strip at most: a divided strip (Lumen's) sets its pairs edge to edge, with no gap between them.
      expect(card.share).toBeLessThanOrEqual(0.5);
    }
  }
  for (const card of laid) expect(card.lines, 'a figure stays on one line').toBeLessThan(1.5);
});

/**
 * A dashboard's layout places sections in the areas of a grid (the crm fixture's Pipeline layout: a strip, a chart
 * beside a column of two breakdowns that runs down two rows, the list under the chart). Areas in one template row
 * share their top and their height, the last section stacked in an area takes what the area has left so a column's
 * edges line up, and a phone gets one column in reading order that does not scroll sideways.
 */
const areaBoxes = (page: import('@playwright/test').Page) =>
  page.locator('.dash-area').evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const last = node.querySelector(':scope > .page-section:last-child')?.getBoundingClientRect();
        return [
          (node as HTMLElement).style.getPropertyValue('--area'),
          { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height, lastBottom: last?.bottom ?? 0 },
        ];
      }),
    ),
  );

test('a layout stands its areas in one row at one top and height, and a stacked column ends where the row ends', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${COMPASS}/pipeline-layout`);
  await expect(page.locator('.dash-grid')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.dash-area')).toHaveCount(4);
  await expect(page.locator('.dash-strip .home-card').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const a = await areaBoxes(page);
  // The chart and the column beside it start on one line; the list stands under the chart, level with the column's end.
  expect(a.trend!.top).toBeCloseTo(a.side!.top, 0);
  expect(a.work!.top).toBeGreaterThan(a.trend!.bottom - 1);
  expect(a.side!.bottom).toBeCloseTo(a.work!.bottom, 0);
  // Two thirds and a third of the row.
  expect(a.trend!.width / a.side!.width).toBeGreaterThan(1.8);
  expect(a.trend!.width / a.side!.width).toBeLessThan(2.2);
  // The column stacks two breakdowns; the second takes the height that is left, so its box ends with the area.
  expect(await page.locator('.dash-area[style*="side"] > .page-section').count()).toBe(2);
  expect(a.side!.lastBottom).toBeCloseTo(a.side!.bottom, 0);
  // The strip spans the row.
  expect(a.kpis!.width).toBeGreaterThan(a.trend!.width + a.side!.width);
});

test('on a phone a layout is one column in reading order and does not scroll sideways', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${COMPASS}/pipeline-layout`);
  await expect(page.locator('.dash-grid')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  const a = await areaBoxes(page);
  const order = ['kpis', 'trend', 'side', 'work'];
  for (const name of order) expect(a[name]!.left, `${name} stands at the page's edge`).toBeCloseTo(a.kpis!.left, 0);
  for (let at = 1; at < order.length; at++) expect(a[order[at]!]!.top).toBeGreaterThanOrEqual(a[order[at - 1]!]!.bottom - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

/* A matrix too wide for its section folds: each cell a box with its column's name over its figure. The App's row
   height once fixed those boxes at 32px and cut the figure in half (G185), and the name kept the faint ink on the
   heaviest tint (G186): each cell holds its words, and every tinted one reads at 4.5:1, at a desk and on a phone,
   light and dark. */
test('a folded matrix holds each figure inside its cell, readable on its heaviest tint', async ({ page }) => {
  test.setTimeout(120_000);
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      const at = `${width} ${colorScheme}`;
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height });
      await page.goto(COMPASS);
      await expect(page.locator('.matrix-host[data-fold] .matrix-cell[style]').first()).toBeVisible({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      const cells = await page.locator('.matrix-host[data-fold] .matrix-cell').evaluateAll((nodes) =>
        nodes.map((cell) => ({
          over: cell.scrollHeight - cell.clientHeight,
          inked: !cell.hasAttribute('style') || getComputedStyle(cell, '::before').color === getComputedStyle(cell).color,
        })),
      );
      expect(cells.length, at).toBeGreaterThan(10);
      expect(Math.max(...cells.map((cell) => cell.over)), at).toBeLessThanOrEqual(0);
      expect(
        cells.every((cell) => cell.inked),
        at,
      ).toBe(true);
      const tinted = (await readings(page, [['.matrix-cell[style]', 4.5]])).filter((reading) => reading.what.startsWith('.matrix-cell'));
      expect(tinted.length, at).toBeGreaterThan(10);
      expect(
        tinted.filter((reading) => reading.ratio < reading.need),
        at,
      ).toEqual([]);
    }
});
