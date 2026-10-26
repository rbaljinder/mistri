import { DEMO, expect, test } from './support/ownServers';
import { open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test('a manager list from another tab cannot change the current database', async ({ page }) => {
  await open(page, DEMO);
  await page.route('**/api/connections', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), active: 'scratch' } });
  });
  await page.getByRole('button', { name: 'Manage connections' }).click();
  await expect(page.locator('.conn-row.active .conn-name-text')).toHaveText(DEMO);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#conn-picker')).toContainText(DEMO);
  expect(new URL(page.url()).pathname).toBe(`/${DEMO}`);
});

test('connection changes resist dismissal while pending and retain rejected entries', async ({ page }) => {
  await open(page, DEMO);
  await page.getByRole('button', { name: 'Manage connections' }).click();
  await page.locator('.conn-row.active').hover();
  await page.getByTitle(`Edit ${DEMO}`, { exact: true }).click();
  const form = page.locator('.conn-dialog');
  await form.getByLabel('Connection name').fill('Renamed demo');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/connections/update', async (route) => {
    requests++;
    await gate;
    await route.fulfill({ status: 400, json: { error: 'Update refused for test' } });
  });
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => requests).toBe(1);
  await expect(form.getByLabel('Connection name')).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(form).toBeVisible();
  await expect(page.locator('.conn-manager')).toBeVisible();
  release();
  await expect(form.locator('.conn-result')).toContainText('Could not update');
  await expect(form.getByLabel('Connection name')).toHaveValue('Renamed demo');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(form.getByLabel('Connection name')).toHaveValue('Renamed demo');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.conn-manager')).toBeVisible();
  expect(requests).toBe(1);
});

test('related-row preferences display their saved selection immediately and after reload', async ({ page }) => {
  await open(page, DEMO);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  const control = page.getByRole('button', { name: 'Rows per related list' });
  await control.click();
  await page.getByRole('option', { name: '20', exact: true }).click();
  await expect(control).toContainText('20');
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  await expect(control).toContainText('20');
});
