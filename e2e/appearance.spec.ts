// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { CRM, DEMO, expect, test } from './support/ownServers';
import type { ThemeDefinition } from '../packages/engine/schema/theme.js';
import { themePreset } from '../packages/engine/src/shared/themePresets.js';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

const CUSTOM: ThemeDefinition = {
  id: 'custom',
  label: 'Custom',
  base: 'lumen',
  light: { surface: '#ffffff', ink: '#222222', accent: '#006b73', navGround: '#ffffff', navInk: '#222222' },
  dark: { surface: '#111111', ink: '#eeeeee', accent: '#88dddd', navGround: '#111111', navInk: '#eeeeee' },
  fonts: { data: 'Arial, sans-serif', heading: 'Georgia, serif' },
  radius: { control: '3px', field: '3px' },
};

test('custom themes: app default, browser override, reload, mode, removal and restoration', async ({ page }) => {
  let available = true;
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.customThemes = available ? [CUSTOM] : [];
    payload.app.ui.theme = available ? { preset: 'custom' } : { accent: '#2563eb' };
    await route.fulfill({ response, json: payload });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${CRM}/`);
  await expect(page.locator('.chart-donut')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'custom');
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const more = page.getByRole('button', { name: 'Settings', exact: true });
  await more.click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
  // The App's own theme is the look in force until the reader picks another.
  await expect(prefs.getByRole('button', { name: 'Visual theme', exact: true })).toContainText('Custom');
  const choose = async (name: string | RegExp) => {
    await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
    await page.getByRole('option', typeof name === 'string' ? { name, exact: true } : { name }).click();
  };
  await choose('Sage');
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
  // Sage names no webfont (docs/design.md, the looks' type): its heads are
  // the system's own sans.
  const heading = await page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--heading-font'));
  expect(heading).toContain('system-ui');
  expect(heading).not.toContain('Inter');
  // The App's own theme is marked as such in the list (Prefs.tsx), and picking it stores it like any other pick.
  await choose(/^Custom\s*This App’s theme$/);
  await prefs.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'custom');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect
    .poll(() => page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--accent')))
    .toBe('#88dddd');
  available = false;
  await page.reload();
  await expect(page.locator('.chart-donut')).toBeVisible();
  // A stored pick the App no longer offers falls back to Lumen, the default,
  // not to bare tokens: the page is dark here, so Lumen's dark surface.
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
  expect(await page.locator('html').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--surface'))).toBe(
    themePreset('lumen')!.dark.surface,
  );
  available = true;
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'custom');
});

test('theme lab: shared controls, nested focus, and mobile containment without business writes', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(insert|update|delete)/.test(request.url())) writes.push(request.url());
  });
  // An authoring tool of the standalone browser: an App has no Workbench to open it from.
  await page.goto(`/${DEMO}/customer`);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Theme lab/ }).click();
  const lab = page.getByRole('dialog', { name: 'Theme lab', exact: true });
  await lab.getByRole('textbox', { name: 'Name', exact: true }).fill('');
  await expect(lab.getByRole('alert')).toHaveText('Name is required.');
  await lab.getByRole('button', { name: 'Confirm sample', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm sample', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lab).toBeVisible();
  await expect(lab.getByRole('button', { name: 'Confirm sample', exact: true })).toBeFocused();
  for (const theme of ['Lumen', 'Mono']) {
    await lab.getByRole('button', { name: 'Visual theme', exact: true }).click();
    await page.getByRole('option', { name: theme, exact: true }).click();
    for (const mode of ['Light', 'Dark']) {
      await lab.getByRole('button', { name: 'Color mode', exact: true }).click();
      await page.getByRole('option', { name: mode, exact: true }).click();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const box = (await lab.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        expect(await lab.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    }
  }
  await lab.getByRole('button', { name: 'Close', exact: true }).click();
  expect(writes).toEqual([]);
});

for (const system of ['light', 'dark'] as const) {
  test(`appearance: quick toggle always changes the visible ${system} system palette`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: system });
    await page.goto(`${CRM}/`);
    await expect(page.locator('.chart-donut')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    let visible: 'light' | 'dark' = system;
    for (let count = 0; count < 4; count += 1) {
      const before = await page.locator('.topbar').evaluate((node) => getComputedStyle(node).backgroundColor);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const toggle = page.getByRole('menuitemcheckbox', { name: /^Dark mode/ });
      await expect(toggle).toHaveAttribute('aria-checked', String(visible === 'dark'));
      await toggle.click();
      visible = visible === 'dark' ? 'light' : 'dark';
      await expect(page.locator('html')).toHaveAttribute('data-theme', visible);
      await expect.poll(() => page.locator('.topbar').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(before);
    }
    await page.reload();
    await expect(page.locator('.chart-donut')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', visible);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menuitem', { name: /Preferences/ }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
    await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
    await page.getByRole('option', { name: 'Sage', exact: true }).click();
    for (const mode of ['Light', 'Dark', 'System']) {
      await prefs.getByRole('button', { name: 'Color mode', exact: true }).click();
      await page.getByRole('option', { name: mode, exact: true }).click();
      await expect(prefs.getByRole('button', { name: 'Color mode', exact: true }).locator('.dd-value')).toHaveText(mode);
      if (mode === 'System') await expect(page.locator('html')).not.toHaveAttribute('data-theme');
      else await expect(page.locator('html')).toHaveAttribute('data-theme', mode.toLowerCase());
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(prefs.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
      await prefs.getByRole('button', { name: 'Color mode', exact: true }).click();
      const choices = page.getByRole('listbox', { name: 'Color mode', exact: true });
      await expect(choices).toBeVisible();
      const box = (await choices.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
    }
    await prefs.getByRole('button', { name: 'Close', exact: true }).click();
  });
}

test('appearance: Sage is selectable, responsive, and reversible back to the default Lumen', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${CRM}/`);
  await expect(page.locator('.chart-donut')).toBeVisible();
  const header = page.locator('.topbar');
  const original = await header.evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /Preferences/ }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
  await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
  await page.getByRole('option', { name: 'Sage', exact: true }).click();
  await prefs.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('.chart-donut')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'sage');
  // Compass's menu is drawn in the bar, so the bar is the menu and wears Sage's nav.ground (sageLook.css): its warm
  // white panel on the cream page, as a side menu is. 0.9.2 made it the cream itself, and the bar sank into the page.
  await expect(header).toHaveCSS('background-color', 'rgb(253, 252, 249)');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 242, 236)');
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('.chart-donut')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await page.keyboard.press('Escape');
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /Preferences/ }).click();
  await prefs.getByRole('button', { name: 'Visual theme', exact: true }).click();
  await page.getByRole('option', { name: 'Lumen', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
  await expect(header).toHaveCSS('background-color', original);
});

test('workspace commands: an App offers no database tools and no Workbench', async ({ page }) => {
  await page.goto(`${CRM}/`);
  await expect(page.locator('.chart-donut')).toBeVisible();
  // The App's menu is its reader's settings (a gear, "Settings").
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const databaseCommands = [
    'Views',
    'SQL',
    'Take the tour',
    'Schema',
    'Query language',
    'Write a query',
    'Find a value',
    'Check the shape',
    'Agent console',
    'Connections',
  ];
  await settings.click();
  for (const name of databaseCommands) await expect(page.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^App definition/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Theme lab/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Workbench/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Preferences/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('.sql-panel')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('w');
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await page.getByRole('button', { name: 'Search (⌘K)' }).click();
  const search = page.getByRole('combobox', { name: 'Search', exact: true });
  await search.fill('Schema');
  await expect(page.getByRole('option', { name: /^action Schema/ })).toHaveCount(0);
  await search.fill('Sales dashboard');
  await expect(page.getByRole('option', { name: /^page Sales dashboard/ })).toBeVisible();
  await search.fill('Workbench');
  await expect(page.getByRole('option', { name: /Workbench/ })).toHaveCount(0);
});
