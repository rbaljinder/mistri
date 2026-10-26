/** A named dashboard survives a cold link, reload and browser history. */
import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';

test('Thread workspace opens by view key and restores after visiting a list', async ({ page }) => {
  const sample = await startSample('thread');
  try {
    await page.goto(`${sample.origin}/workspace`);
    await expect(page.locator('.dash-body')).toBeVisible();
    await expect(page.getByText('Fix the query above to see results.', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.dash-body')).toBeVisible();
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Issues/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Issues');
    await page.goBack();
    await expect(page.locator('.dash-body')).toBeVisible();
  } finally {
    await sample.stop();
  }
});
