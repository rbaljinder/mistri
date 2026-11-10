import { expect, test } from './support/ownServers';
import { startSessionApp } from './support/sessionServer';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* An App whose payload fails answers in the App's own words. The database browser's chrome — its query bar, its
   filter, its mark — is the Workbench's, and a signed-out visitor to an App must never meet it. */
test('a signed-out visitor to an App that cannot load meets an App error, never the database browser', async ({ page }) => {
  test.setTimeout(45_000);
  const app = await startSessionApp({ brokenPublic: true });
  try {
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
    await page.goto(`${app.origin}/session-workspace`);
    await expect(page.locator('html')).not.toHaveAttribute('data-starting');
    await expect(page.locator('.unavail')).toContainText('Session workspace');
    await expect(page.locator('.topbar .brand-name')).toHaveText('Session workspace');
    for (const selector of ['#querybar', '.querybar', '#table-filter', '.sidebar', '#sql-toggle', '#search-button']) {
      await expect(page.locator(selector)).toBeHidden();
    }
    await expect(page.locator('body')).not.toContainText('Filter tables');
    await expect(page.locator('body')).not.toContainText('Could not read the schema');
    await expect(page.locator('body')).not.toContainText('tablewalk');
  } finally {
    await app.stop();
  }
});
