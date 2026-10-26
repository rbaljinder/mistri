import { DEMO, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/* The Workbench is the standalone browser's, over the database, never an
   App's. A row opens as a record — the next step of the walk, under raw table
   names — and a step through the list replaces that record rather than
   stacking another. */
test('in the workbench a row opens as a record, and a step replaces it', async ({ page }) => {
  await page.goto(`/${DEMO}/customer`);
  await expect(page.locator('body')).not.toHaveClass(/app-mode/);
  const grid = page.locator('.table-wrap table').first();
  await expect(grid.locator('tbody tr').first()).toBeVisible();
  await grid.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/${DEMO}/customer/~[^/]+$`));
  await expect(page.locator('.crumbs')).toContainText('customer');

  const trail = page.getByRole('navigation', { name: 'Records in this list' });
  await expect(trail).toContainText(/\d+ of \d+/);
  const before = page.url();
  await page.keyboard.press('j');
  await expect.poll(() => page.url()).not.toBe(before);
  await expect(page).toHaveURL(new RegExp(`/${DEMO}/customer/~[^/]+$`));
});
