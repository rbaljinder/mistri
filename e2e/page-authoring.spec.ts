import { DEMO, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/* The page builder is the standalone browser's: an App's pages are its
   definition, and an App has no Workbench to open the builder from. A record
   read "As a page" opens its suggested page, which a copy starts from. */
const record = `/${DEMO}/customer/~1`;

async function openSuggestedPage(page: import('./support/ownServers').Page) {
  await page.goto(record);
  await page.getByRole('button', { name: 'As a page →' }).click();
  await expect(page.getByRole('button', { name: 'Copy layout' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openSuggestedPage(page);
});

test('layout drafts survive reload and restore only after an explicit choice', async ({ page }) => {
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name', exact: true }).fill('Recovered customer layout');
  await builder.getByRole('textbox', { name: 'Section title' }).first().fill('Key facts draft');
  await expect(builder.getByText('Draft recovery stored', { exact: false })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Copy layout' }).click();
  await expect(builder.getByRole('region', { name: 'Recover page draft' })).toBeVisible();
  await expect(builder.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await builder.getByRole('button', { name: 'Restore draft' }).click();
  await expect(builder.getByRole('textbox', { name: 'Page name', exact: true })).toHaveValue('Recovered customer layout');
  await expect(builder.getByRole('textbox', { name: 'Section title' }).first()).toHaveValue('Key facts draft');
  await builder.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('button', { name: 'Copy layout' }).click();
  await expect(builder.getByRole('region', { name: 'Recover page draft' })).toHaveCount(0);
});

test('unsaved preview uses real desktop and mobile viewports without writes or navigation', async ({ page }, testInfo) => {
  const writes: string[] = [];
  for (const endpoint of ['update', 'insert', 'delete', 'pages/save']) {
    await page.route(`**/api/${endpoint}`, async (route) => {
      writes.push(endpoint);
      await route.abort();
    });
  }
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const url = page.url();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name', exact: true }).fill('Unsaved desktop and mobile');
  await builder.getByRole('textbox', { name: 'Section title' }).first().fill('Preview key facts');
  await builder.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Unsaved page preview' });
  const frame = page.frameLocator('iframe[title="Page layout preview"]');
  await expect(frame.getByRole('heading', { name: 'Unsaved desktop and mobile' })).toBeVisible();
  await expect(frame.locator('.page-field-grid').first()).toBeVisible();
  await expect(frame.locator('.page-field-grid').first()).not.toBeEmpty();
  await expect(frame.locator('.cell-edit')).toHaveCount(0);
  await expect(frame.locator('.page-field-grid').first().locator('..')).toHaveAttribute('inert', '');
  expect(await frame.locator('body').evaluate(() => window.innerWidth)).toBe(1280);
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png') });
  await preview.getByRole('button', { name: 'Mobile', exact: true }).click();
  expect(await frame.locator('body').evaluate(() => window.innerWidth)).toBe(390);
  expect(await frame.locator('body').evaluate(() => matchMedia('(max-width: 600px)').matches)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-mobile.png') });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of await preview.locator('.page-preview-head button').all()) {
      const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  }
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await expect(builder.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();
  await expect(builder.getByRole('textbox', { name: 'Page name', exact: true })).toHaveValue('Unsaved desktop and mobile');
  await builder.getByRole('button', { name: 'Preview', exact: true }).click();
  // Escape from inside the frame closes the preview too: the related list's grid is one tab stop.
  await frame.getByRole('grid').first().focus();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(builder.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();
  expect(page.url()).toBe(url);
  expect(writes).toEqual([]);
  await builder.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
});
