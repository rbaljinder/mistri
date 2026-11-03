import { CRM, expect, test } from './support/ownServers';
import { dataRows } from './support/app';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

test('the latest record click wins while both await the same page registry', async ({ page }) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(/\/api\/pages\?/, async (route) => {
    requested();
    await paused;
    await route.continue();
  });
  try {
    await page.goto(`${CRM}/lead`);
    await started;
    const rows = dataRows(page);
    await expect(rows.nth(1)).toBeVisible();
    // A lead's name cell also draws its initials and email; the heading says the name.
    const latestName = await rows.nth(1).locator('td').first().locator('.avatar-text').innerText();
    await rows.first().click();
    await rows.nth(1).click();
    await expect(page.locator('.applist-title')).toBeVisible();
    release();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(latestName);
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/leads\/\d+$/);
  } finally {
    release();
  }
});
