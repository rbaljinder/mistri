import { COMPASS, expect, test } from './support/ownServers';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;
const record = `${CRM}/@opportunity~1`;

test('app fields open individually and keep formatting and reference navigation', async ({ page }, info) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(update|insert|delete)(?:\?|$)/.test(request.url())) writes.push(request.url());
  });
  await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
  await page.goto(record);
  const launch = page.getByRole('button', { name: 'Edit Opportunity', exact: true });
  await expect(launch).toBeVisible();
  await expect(page.locator('.page-field .cell-edit')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Amount', exact: true })).toContainText('$');
  const account = page.locator('.page-field').filter({ has: page.locator('dt[title="account_id"]') });
  await expect(account.locator('.ref-jump')).toBeVisible();
  await expect(account.getByRole('button', { name: 'Edit Account', exact: true })).toBeVisible();
  for (const width of [1440, 412, 320]) {
    await page.setViewportSize({ width, height: 924 });
    await launch.click();
    const input = page.getByRole('textbox', { name: 'Opportunity', exact: true });
    await expect(input).toBeFocused();
    const original = await input.inputValue();
    await input.fill('Temporary field edit');
    await input.press('Escape');
    await expect(launch).toContainText(original);
    await expect(launch).toBeFocused();
    const bounds = await launch.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: info.outputPath(`inline-editing-${width}.png`) });
  }
  expect(writes).toEqual([]);
  await account.locator('.ref-jump').click();
  await expect(page).not.toHaveURL(record);
});

test('an App keeps editing contextual: no write-mode toggle and no Workbench', async ({ page }) => {
  await page.goto(record);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Workbench/ })).toHaveCount(0);
  await expect(page.getByRole('menuitemcheckbox', { name: /^Editing enabled/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit Opportunity', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/write-mode/);
});

test('a read-only App withholds editing', async ({ page }) => {
  await page.route('**/api/runtime', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.apps = data.apps.map((app: object) => ({ ...app, writable: false }));
    await route.fulfill({ response, json: data });
  });
  await page.goto(record);
  await expect(page.locator('.page-field-grid').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Opportunity', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Workbench/ })).toHaveCount(0);
  await expect(page.getByRole('menuitemcheckbox', { name: /^Editing enabled/ })).toHaveCount(0);
});
