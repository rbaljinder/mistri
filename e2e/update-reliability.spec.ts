import { CRM, CRM_DB, expect, test } from './support/ownServers';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

test('a nullable text field distinguishes database NULL from literal null text in both directions', async ({ page }) => {
  const id = 1;
  const original = scalar(CRM_DB, 'SELECT phone FROM lead WHERE id = ?', id);
  const update = (phone: unknown) =>
    page.request.post(`${CRM}/api/update`, { data: { app: 'compass', table: 'lead', key: { id }, values: { phone } } });
  try {
    expect((await update(null)).ok()).toBe(true);
    await page.goto(`${CRM}/lead/~${id}`);
    await page.getByRole('button', { name: 'Edit Phone', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Phone', exact: true });
    await expect(input).toHaveValue('');
    for (const value of ['null', '']) {
      await input.fill(value);
      await input.press('Tab');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(CRM_DB, 'SELECT phone FROM lead WHERE id = ?', id)).toBe(value === '' ? null : value);
    }
  } finally {
    expect((await update(original)).ok()).toBe(true);
  }
});

for (const failure of ['lost response', 'invalid acknowledgement'] as const)
  test(`an app action with ${failure} is unconfirmed: it locks field editing, with a contained mobile notice`, async ({ page }, info) => {
    const crm = CRM;
    const id = 1;
    const original = scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id);
    let attempts = 0;
    await page.request.post(`${crm}/api/update`, { data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'new' } } });
    await page.goto(`${crm}/lead/~${id}`);
    await page.route('**/api/update', async (route) => {
      attempts++;
      const response = await route.fetch();
      if (failure === 'lost response') await route.abort('failed');
      else await route.fulfill({ response, json: { affected: 1, applied: {} } });
    });
    try {
      const action = page.getByRole('button', { name: 'Start working', exact: true });
      await action.click();
      const notice = page.locator('.pending-uncertain');
      await expect(notice).toContainText('Update not confirmed');
      await expect(action).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeDisabled();
      expect(scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id)).toBe('working');
      await notice.getByText('Proposed changes', { exact: true }).click();
      await expect(notice).toContainText('working');
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 924 });
        const bounds = (await notice.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(await notice.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`action-unconfirmed-${width}.png`) });
      }
      expect(attempts).toBe(1);
    } finally {
      await page.request.post(`${crm}/api/update`, { data: { app: 'compass', table: 'lead', key: { id }, values: { status: original } } });
    }
  });
