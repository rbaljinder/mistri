import { CRM, CRM_DB, expect, test } from './support/ownServers';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

for (const [width, theme] of [
  [1440, 'Lumen'],
  [1024, 'Mono'],
  [390, 'Lumen'],
  [320, 'Mono'],
] as const) {
  test(`App save dock: ${theme} at ${width}px stays out of flow and saves directly`, async ({ page }, info) => {
    const original = String(scalar(CRM_DB, 'SELECT name FROM opportunity WHERE id = 1'));
    const proposed = `${original} updated`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updates: Array<{ values: unknown; expected: unknown }> = [];
    await page.setViewportSize({ width, height: 924 });
    await page.goto(`${CRM}/@opportunity~1`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Preferences/ }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
    await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
    await page.getByRole('option', { name: theme, exact: true }).click();
    await prefs.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Opportunity', exact: true });
    const geometry = () =>
      page
        .locator('.page-field-grid')
        .first()
        .evaluate((node) => ({
          top: node.getBoundingClientRect().top,
          height: node.getBoundingClientRect().height,
          scrollHeight: document.querySelector('.content')!.scrollHeight,
        }));
    const before = await geometry();
    await input.fill(proposed);
    const dock = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await expect(dock).toBeVisible();
    expect(await geometry()).toEqual(before);
    const bounds = (await dock.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await dock.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`save-dock-${theme.toLowerCase()}-${width}.png`) });
    await dock.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dock).toHaveCount(0);
    await expect(input).toHaveValue(original);
    expect(await geometry()).toEqual(before);
    await input.fill(proposed);
    await page.route('**/api/update', async (route) => {
      updates.push(route.request().postDataJSON());
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    try {
      await dock.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => updates.length).toBe(1);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(dock.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      await expect(input).toBeDisabled();
      expect(updates[0]).toMatchObject({ values: { name: proposed }, expected: { name: original } });
      expect(await geometry()).toEqual(before);
      release();
      await expect(dock).toHaveCount(0);
      await expect(input).toHaveValue(proposed);
      const saved = page.getByRole('region', { name: 'Saved changes', exact: true });
      await expect(saved).toContainText('Changes saved');
      // An App has no Undo: the dock says what was saved, and offers only to be dismissed.
      await expect(saved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      expect(await saved.boundingBox()).toEqual(bounds);
      await expect(page.locator('#toast')).toBeHidden();
      await page.screenshot({ path: info.outputPath(`saved-dock-${theme.toLowerCase()}-${width}.png`), animations: 'disabled' });
      expect(scalar(CRM_DB, 'SELECT name FROM opportunity WHERE id = 1')).toBe(proposed);
      expect(await geometry()).toEqual(before);
      expect(updates).toHaveLength(1);
      await saved.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(saved).toHaveCount(0);
      await input.fill(`${proposed} draft`);
      await expect(dock).toBeVisible();
      await expect(input).toHaveValue(`${proposed} draft`);
      await dock.getByRole('button', { name: 'Discard', exact: true }).click();
    } finally {
      release();
      await page.request.post(`${CRM}/api/update`, {
        data: { app: 'compass', table: 'opportunity', key: { id: 1 }, values: { name: original } },
      });
    }
  });
}

test('App deletion still asks and cancelling makes no write', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/delete') && request.postDataJSON().confirm) writes.push(request.url());
  });
  await page.goto(`${CRM}/@opportunity~1`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete opportunity');
  await expect(dialog.locator('pre')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
});
