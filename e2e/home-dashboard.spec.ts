import { COMPASS, expect, test } from './support/ownServers';
import { focusStops } from '../packages/mistri/src/server/build/gradeProbe';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

for (const width of [412, 1024, 1440])
  test(`home dashboard filters preserve the landing layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 924 });
    await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
    await page.goto(CRM);
    const heading = page.locator('.applist-title');
    const controls = page.locator('.dash-controls');
    const metric = page.locator('.home-card').first();
    await expect(heading).toHaveText('Sales dashboard');
    await expect(metric).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const positions = async () => Promise.all([heading, controls, metric].map((node) => node.boundingBox()));
    const before = await positions();
    const stable = async () => {
      await expect(heading).toHaveText('Sales dashboard');
      await expect(page.locator('.crumbs-host')).toHaveCount(0);
      const after = await positions();
      after.forEach((box, i) => {
        expect(box!.x).toBeCloseTo(before[i]!.x, 0);
        expect(box!.y).toBeCloseTo(before[i]!.y, 0);
        expect(box!.width).toBeCloseTo(before[i]!.width, 0);
      });
    };
    await page.getByRole('button', { name: /^Time window:/ }).click();
    await page.getByRole('menuitem', { name: 'Last 30 days' }).click();
    // The home dashboard is the App's root; its window and picks are parameters.
    await expect(page).toHaveURL(/\/\?period=last-30-days$/);
    await stable();
    await page.getByRole('button', { name: 'Filter by stage', exact: true }).click();
    await page.getByRole('option', { name: 'Proposal', exact: true }).click();
    await expect(page).toHaveURL(/last-30-days.*stage.*proposal/);
    await stable();
    await page.getByRole('button', { name: /^Time window:/ }).click();
    await page.getByRole('menuitem', { name: 'Last 90 days' }).click();
    await expect(page).toHaveURL(/last-90-days.*stage.*proposal/);
    await stable();
    const shared = page.url();
    await page.reload();
    await expect(page.locator('html')).not.toHaveAttribute('data-starting');
    await expect(page.getByRole('button', { name: 'Time window: Last 90 days' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter by stage', exact: true })).toContainText('Proposal');
    await stable();
    await page.screenshot({ path: testInfo.outputPath(`filtered-home-${width}.png`) });
    await metric.click();
    await expect(page.locator('.crumbs-host')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(shared);
    await stable();
    await page.getByRole('button', { name: /^Time window:/ }).click();
    await page.getByRole('menuitem', { name: 'Default' }).click();
    await page.getByRole('button', { name: 'Filter by stage', exact: true }).click();
    await page.getByRole('option', { name: 'Any stage', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await stable();
    // A dashboard opened by its address, a window chosen, is a room of the menu: it names itself, with no trail over it.
    await page.goto(`${CRM}/@dash-sales-dashboard~last-30-days`);
    await expect(heading).toHaveText('Sales dashboard');
    await expect(page.locator('.crumbs-host')).toHaveCount(0);
  });

/* A donut's slice that drills is a Tab stop, and grade's hidden-focus found four on this dashboard: the ring was the
   slice's stroke widened, which the drawing's edge cut and grade's reading of a ring never saw. Each slice the Tab key
   reaches now wears the house ring round its arc: 2px, at 3:1 on the card under it, read as grade reads it. */
test("a donut's slices wear the house ring when the Tab key reaches them", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(CRM);
  await expect(page.locator('.chart-donut [role="button"]').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const slices = (await focusStops(page)).filter((stop) => /\(\d+%\)"$/.test(stop.what));
  expect(slices.length, 'the Tab key reaches the slices').toBeGreaterThan(0);
  for (const slice of slices) {
    expect(slice.width, slice.what).toBeGreaterThanOrEqual(2);
    expect(slice.ratio ?? 0, slice.what).toBeGreaterThanOrEqual(3);
  }
});

/* The ring stands 2px off the slice in every look: Lumen's line charts draw a slice's stroke at 4.5 units, not 7, and a
   ring drawn off the 7-unit stroke stood about 6px off a Lumen slice. Read on the screen: the ring's inner edge less the
   stroke's outer edge, along the slice's radius. */
for (const look of ['workshop', 'lumen'])
  test(`a donut slice's ring stands 2px off the slice in ${look}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript((chosen) => localStorage.setItem('mistri.visual-theme', chosen), look);
    await page.goto(CRM);
    await expect(page.locator('.chart-slice-door').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.classList.contains('chart-slice-door') ?? false);
    }
    expect(reached, 'the Tab key reaches a slice').toBe(true);
    const gap = await page.evaluate(() => {
      const door = document.activeElement as SVGGElement;
      const slice = door.querySelector('.chart-slice') as SVGCircleElement;
      const ring = door.querySelector('.chart-slice-ring') as SVGPathElement;
      const outer = Number(/A ([\d.]+)/.exec(ring.getAttribute('d') ?? '')?.[1]);
      const scale = slice.getScreenCTM()!.a;
      const stroke = parseFloat(getComputedStyle(slice).strokeWidth);
      const ringWidth = parseFloat(getComputedStyle(ring).strokeWidth);
      return { px: (outer - slice.r.baseVal.value - stroke / 2) * scale - ringWidth / 2, shown: getComputedStyle(ring).display };
    });
    expect(gap.shown).not.toBe('none');
    expect(gap.px).toBeGreaterThan(1.5);
    expect(gap.px).toBeLessThan(2.5);
  });
