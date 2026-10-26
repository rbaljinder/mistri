import { DEMO, expect, test, type Locator, type Page } from './support/ownServers';

// Only this worker's standalone browser and disposable database/config store.
// These are the restoration contract: do not mark failures expected while the
// Workbench visual-theme/token pipeline is being restored.
test.use({ servers: ['explorer'] });

const WORKBENCH_LOOK = 'mistri.workbench-visual-theme';

async function openWorkbench(page: Page) {
  await page.goto(`/${DEMO}/customer`);
  await expect(page.locator('.table-wrap table').first()).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/app-mode/);
  await expect(page.locator('#query')).toBeVisible();
}

async function openDialog(page: Page, name: 'Theme lab' | 'Preferences') {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function choose(page: Page, dialog: Locator, control: string, option: string) {
  await dialog.getByRole('button', { name: control, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(dialog.getByRole('button', { name: control, exact: true }).locator('.dd-value')).toHaveText(option);
}

async function nativeLook(page: Page) {
  const root = page.locator('html');
  for (const attribute of ['data-visual-theme', 'data-theme-style', 'data-custom-theme', 'data-theme-palette', 'data-record-branding']) {
    await expect(root).not.toHaveAttribute(attribute);
  }
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 250, 248)');
  expect(
    await root.evaluate((node) =>
      ['--ground', '--surface', '--heading-font', '--field-radius', '--mono'].map((key) =>
        (node as HTMLElement).style.getPropertyValue(key),
      ),
    ),
  ).toEqual(['', '', '', '', '']);
}

test('Workbench: native default, real Theme lab and Preferences looks, canonical modes and reset survive reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openWorkbench(page);
  await nativeLook(page);
  const native = await page.locator('body').evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    color: getComputedStyle(node).color,
    mono: getComputedStyle(node).getPropertyValue('--mono'),
  }));

  let lab = await openDialog(page, 'Theme lab');
  await expect(lab.getByRole('button', { name: 'Visual theme', exact: true })).toContainText('Workbench default');
  await choose(page, lab, 'Visual theme', 'Sage');
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
  await expect(page.locator('html')).toHaveAttribute('data-theme-style', 'sage');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 242, 236)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(31, 35, 32)');
  expect(await page.evaluate((key) => localStorage.getItem(key), WORKBENCH_LOOK)).toBe('sage');

  for (const [label, value, background] of [
    ['Dark', 'dark', 'rgb(20, 22, 19)'],
    ['Light', 'light', 'rgb(244, 242, 236)'],
  ]) {
    await choose(page, lab, 'Color mode', label);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await expect(page.locator('body')).toHaveCSS('background-color', background);
    expect(await page.evaluate(() => localStorage.getItem('mistri.theme'))).toBe(value);
    await page.reload();
    await expect(page.locator('.table-wrap table').first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await expect(page.locator('body')).toHaveCSS('background-color', background);
    lab = await openDialog(page, 'Theme lab');
    await expect(lab.getByRole('button', { name: 'Color mode', exact: true }).locator('.dd-value')).toHaveText(label);
  }
  await lab.getByRole('button', { name: 'Close', exact: true }).click();

  let prefs = await openDialog(page, 'Preferences');
  await expect(prefs.getByRole('button', { name: 'Visual theme', exact: true })).toContainText('Sage');
  await choose(page, prefs, 'Visual theme', 'Mono');
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'mono');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await page.evaluate((key) => localStorage.getItem(key), WORKBENCH_LOOK)).toBe('mono');
  await page.reload();
  await expect(page.locator('.table-wrap table').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'mono');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  prefs = await openDialog(page, 'Preferences');
  await choose(page, prefs, 'Visual theme', 'Workbench default');
  await nativeLook(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), WORKBENCH_LOOK)).toBeNull();
  await choose(page, prefs, 'Color mode', 'System');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await page.evaluate(() => localStorage.getItem('mistri.theme'))).toBe('system');
  await page.reload();
  await expect(page.locator('.table-wrap table').first()).toBeVisible();
  await nativeLook(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(
    await page.locator('body').evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
      mono: getComputedStyle(node).getPropertyValue('--mono'),
    })),
  ).toEqual(native);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).not.toHaveCSS('background-color', native.background);
  await expect(page.locator('html')).not.toHaveAttribute('data-visual-theme');
});

test('Workbench does not inherit saved App looks or offer App branding as its native default', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    // Same-origin legacy App preferences are the stronger isolation case;
    // another port cannot share these stores at all.
    localStorage.setItem('mistri.visual-theme', 'lumen');
    localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([['keystone', 'dealer-brand']]));
    localStorage.setItem('mistri.visual-palettes', JSON.stringify([[JSON.stringify(['keystone', 'lumen']), 'teal']]));
  });
  await openWorkbench(page);
  await nativeLook(page);
  const prefs = await openDialog(page, 'Preferences');
  await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Workbench default', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: /dealer.brand/i })).toHaveCount(0);
  await page.getByRole('option', { name: 'Sage', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 242, 236)');
  await expect(page.locator('html')).not.toHaveAttribute('data-record-branding');
  expect(
    await page
      .locator('body')
      .evaluate((node) => ['--accent', '--link', '--radius', '--chart-1'].map((key) => (node as HTMLElement).style.getPropertyValue(key))),
  ).toEqual(['', '', '', '']);
  expect(await page.evaluate(() => localStorage.getItem('mistri.visual-theme'))).toBe('lumen');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mistri.custom-theme-choices')!))).toEqual([
    ['keystone', 'dealer-brand'],
  ]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 242, 236)');
  await expect(page.locator('html')).not.toHaveAttribute('data-record-branding');
});

for (const density of ['comfortable', 'spacious'] as const)
  test(`Workbench theme controls and their lists fit a narrow viewport in both dialogs at ${density} density`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('mistri.density', value), density);
    await openWorkbench(page);
    // Wider fallback fonts exposed this on Linux. Exercise the same long-option
    // geometry on every platform, with a list that still fits either viewport.
    await page.addStyleTag({ content: '.dd-list { min-width: max(var(--anchor-width), 220px); }' });
    for (const name of ['Theme lab', 'Preferences'] as const) {
      const dialog = await openDialog(page, name);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const control of ['Visual theme', 'Color mode']) {
          const button = dialog.getByRole('button', { name: control, exact: true });
          await expect(button).toBeInViewport();
          await button.click();
          const list = page.getByRole('listbox', { name: control, exact: true });
          await expect(list).toBeVisible();
          for (const node of [button, list]) {
            // Visibility precedes the popup's entry transition and collision
            // adjustment. Keep the strict bounds, measured once layout settles.
            await expect(async () => {
              const box = (await node.boundingBox())!;
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(width);
              expect(box.y).toBeGreaterThanOrEqual(0);
              expect(box.y + box.height).toBeLessThanOrEqual(844);
            }).toPass({ timeout: 7_000 });
          }
          await page.keyboard.press('Escape');
        }
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });
