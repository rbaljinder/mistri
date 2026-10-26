import { expect, test, type Page } from './support/harness';
import { DEMO } from './support/fixtures';

const SIDEBAR_KEY = 'mistri.sidebar-hidden';
const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}/`;

async function fitsViewport(page: Page, selector: string, minimumWidth = 0) {
  const element = page.locator(selector);
  await expect(element).toBeVisible();
  const box = await element.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(box!.width).toBeGreaterThanOrEqual(minimumWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const width of [320, 390])
  test(`Workbench ${width}: direct records, query and SQL errors retain workspace width`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/${DEMO}/customer/~1`);
    await expect(page.locator('html')).not.toHaveAttribute('data-starting');
    await expect(page.locator('.record')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Tables', exact: true })).toBeHidden();
    await fitsViewport(page, '#content', width - 1);
    await fitsViewport(page, '#query', width - 110);
    const reveal = page.getByRole('button', { name: 'Show the table list' });
    expect((await reveal.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`workbench-record-${width}.png`) });

    await page.getByRole('combobox', { name: 'Query', exact: true }).fill('not_a_real_table_with_a_long_name_for_a_readable_query_error');
    await page.getByRole('combobox', { name: 'Query', exact: true }).press('Enter');
    await fitsViewport(page, '#errors', width - 1);
    await expect(page.locator('#errors')).toContainText('not_a_real_table');

    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    const editor = page.getByRole('combobox', { name: 'SQL statement' });
    await expect(editor).toBeFocused();
    await editor.fill('select * from not_a_real_table_with_a_long_name_for_a_readable_sql_error');
    await editor.press('ControlOrMeta+Enter');
    await expect(page.locator('.sql-error')).toContainText('no such table');
    await fitsViewport(page, '.sql-input', width - 70);
    await fitsViewport(page, '.sql-error', width - 70);
    expect(await page.locator('.sql-error').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`workbench-sql-${width}.png`) });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'SQL', exact: true })).toBeHidden();
  });

test('Workbench phone navigator closes accessibly and never changes the desktop preference', async ({ page }) => {
  for (const stored of [null, '0', '1']) {
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.goto(`/${DEMO}/customer`);
    await page.evaluate(
      ({ key, value }) => {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      },
      { key: SIDEBAR_KEY, value: stored },
    );
    await page.reload();
    await expect(page.locator('html')).not.toHaveAttribute('data-starting');
    const sidebar = page.getByRole('navigation', { name: 'Tables', exact: true });
    if (stored === '1') await expect(sidebar).toBeHidden();
    else await expect(sidebar).toBeVisible();

    await page.setViewportSize({ width: 320, height: 844 });
    const reveal = page.getByRole('button', { name: 'Show the table list' });
    await expect(sidebar).toBeHidden();
    await reveal.click();
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide the table list' })).toBeFocused();
    await fitsViewport(page, '.sidebar', 319);
    const bounds = await sidebar.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(844 / 2);
    expect((await sidebar.locator('button[data-table]').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(reveal).toBeFocused();

    await reveal.click();
    await sidebar.locator('button[data-table="invoice"]').click();
    await expect(sidebar).toBeHidden();
    await expect(reveal).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/${DEMO}/invoice$`));
    expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_KEY)).toBe(stored);

    await page.keyboard.press('t');
    const filter = page.getByRole('searchbox', { name: 'Filter tables' });
    await expect(filter).toBeFocused();
    await filter.fill('customer');
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(sidebar).toBeVisible();
    await filter.fill('customer');
    await filter.press('Enter');
    await expect(sidebar).toBeHidden();
    await expect(reveal).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/${DEMO}/customer$`));

    await page.setViewportSize({ width: 1024, height: 844 });
    if (stored === '1') await expect(sidebar).toBeHidden();
    else await expect(sidebar).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_KEY)).toBe(stored);
  }
});

test('a narrow App keeps its own navigation and has no Workbench to switch to', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CRM}/opportunity`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-reveal')).toBeHidden();
  await page.keyboard.press('w');
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.locator('.sidebar-reveal')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Tables', exact: true })).toHaveCount(0);
});
