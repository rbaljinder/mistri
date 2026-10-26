import { COMPASS, expect, test } from './support/ownServers';

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
    await page.goto(`${CRM}/@dash-sales-dashboard~last-30-days`);
    await expect(heading).toHaveText('Sales dashboard');
    await expect(page.locator('.crumbs-host')).toBeVisible();
  });
