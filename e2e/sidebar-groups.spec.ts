import { CRM, expect, test } from './support/ownServers';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

test('nested sidebar preferences survive reload and reveal filtering, rail and active destinations', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side', menuSearch: true };
    payload.app.nav = [
      {
        group: 'sales',
        label: 'Sales',
        children: [
          { view: 'sales-dashboard', label: 'Sales dashboard' },
          {
            group: 'records',
            label: 'Records',
            children: [
              { view: 'leads', label: 'Leads' },
              { view: 'accounts', label: 'Accounts' },
            ],
          },
        ],
      },
    ];
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/`);
  const group = page.locator('#table-list .nav-group-fold', { hasText: 'Records' });
  const leads = page.locator('#table-list button[data-table="lead"]');
  // Every headed section folds, the top-level Sales too (0.8.9).
  await expect(page.locator('#table-list .nav-group-fold')).toHaveCount(2);
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  const section = await page.getByRole('heading', { name: 'Sales', exact: true }).boundingBox();
  const nested = await group.locator('span').boundingBox();
  expect(Math.abs(section!.x - nested!.x)).toBeLessThan(1);
  await expect(leads).toBeVisible();
  await group.focus();
  await page.keyboard.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(group).toBeFocused();
  await expect(leads).toHaveCount(0);
  await page.reload();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(leads).toHaveCount(0);
  await page.locator('#table-filter').fill('Leads');
  await expect(leads).toBeVisible();
  await expect(group).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#table-filter').fill('');
  await expect(leads).toHaveCount(0);
  await page.locator('.sidebar-footer > .sidebar-collapse').click();
  await expect(leads).toBeVisible();
  await expect(page.locator('#table-list .nav-group-fold')).toHaveCount(0);
  await page.locator('.sidebar-footer > .sidebar-collapse').click();
  await expect(leads).toHaveCount(0);
  await page.goto(`${CRM}/leads`);
  await expect(leads).toBeVisible();
  await expect(leads).toHaveAttribute('aria-current', 'true');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toHaveAttribute('aria-disabled', 'true');
});

test('a top-level section folds in place and an App may start one folded', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side' };
    payload.app.nav = [
      { group: 'sales', label: 'Sales', children: [{ view: 'leads', label: 'Leads' }] },
      { group: 'records', label: 'Records', folded: true, children: [{ view: 'accounts', label: 'Accounts' }] },
    ];
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/`);
  const sales = page.locator('#table-list .nav-group-fold', { hasText: 'Sales' });
  const records = page.locator('#table-list .nav-group-fold', { hasText: 'Records' });
  await expect(records).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#table-list button[data-table="account"]')).toHaveCount(0);
  const before = await sales.boundingBox();
  await sales.click();
  await expect(sales).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#table-list button[data-table="lead"]')).toHaveCount(0);
  // The heading folded stays where it was: folding moves nothing above it.
  expect((await sales.boundingBox())!.y).toBeCloseTo(before!.y, 0);
  await records.click();
  await page.reload();
  await expect(records).toHaveAttribute('aria-expanded', 'true');
  await expect(sales).toHaveAttribute('aria-expanded', 'false');
});

test('a footer group in a window shorter than the menu scrolls under the rows above it, not over them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side' };
    payload.app.nav = [
      {
        group: 'sales',
        label: 'Sales',
        children: [
          { view: 'leads', label: 'Leads' },
          { view: 'accounts', label: 'Accounts' },
        ],
      },
      {
        group: 'more',
        label: 'More',
        children: [
          { view: 'contacts', label: 'Contacts' },
          { view: 'opportunities', label: 'Opportunities' },
        ],
      },
      { group: 'setup', label: 'Setup', placement: 'footer', children: [{ view: 'tasks', label: 'Tasks' }] },
    ];
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/`);
  const above = page.locator('#table-list button[data-table="opportunity"]');
  const footer = page.locator('#table-list button[data-table="task"]');
  await expect(footer).toBeAttached();
  const list = page.locator('#table-list');
  expect(await list.evaluate((ul) => ul.scrollHeight > ul.clientHeight), 'the menu is longer than the window').toBe(true);
  // The list's end fade once shrank to nothing here, and its -40px margin drew the footer group over these rows.
  const [last, first] = await Promise.all([
    above.evaluate((b) => b.closest('li')!.offsetTop + b.closest('li')!.offsetHeight),
    footer.evaluate((b) => b.closest('li')!.offsetTop),
  ]);
  expect(first).toBeGreaterThanOrEqual(last);
});
