import { CRM, expect, test } from './support/ownServers';
import type { ThemeDefinition } from '../packages/engine/schema/theme.js';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const theme: ThemeDefinition = {
  id: 'palette-test',
  label: 'Palette test',
  base: 'lumen',
  light: { surface: '#ffffff', ink: '#142030', accent: '#2456a6' },
  dark: { surface: '#142030', ink: '#ffffff', accent: '#a8ccff' },
  palettes: [
    {
      id: 'mint',
      label: 'Mint',
      light: { accent: '#21644e', navGround: '#e5f3ed', navInk: '#142030' },
      dark: { accent: '#85e0b5', navGround: '#152a23', navInk: '#ffffff' },
    },
  ],
};

test('themed calendar header masks scrolling filters in both modes', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side' };
    await route.fulfill({ response, json: payload });
  });
  for (const mode of ['light', 'dark']) {
    await page.addInitScript((mode) => {
      localStorage.setItem('mistri.visual-theme', 'sage');
      localStorage.setItem('mistri.theme', mode);
    }, mode);
    await page.goto(`${CRM}/task-calendar`);
    await expect(page.locator('.calendar-grid')).toBeVisible();
    const toggle = page.locator('.sidebar-footer > .sidebar-collapse');
    await expect(toggle).toBeVisible();
    await expect(page.locator('.topbar > .sidebar-collapse')).toHaveCount(0);
    await expect(page.locator('.sidebar-filter-row')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const rail = await page.locator('.sidebar').boundingBox();
    const control = await toggle.boundingBox();
    expect(Math.abs(control!.x + control!.width / 2 - rail!.x - rail!.width / 2)).toBeLessThan(1);
    expect(control!.y).toBeGreaterThan(rail!.y + rail!.height - 65);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const crumbs = page.locator('.crumbs');
    const result = await crumbs.evaluate((el) => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight && /(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
          parent.scrollTop = 35;
          break;
        }
      }
      return { ground: getComputedStyle(el).backgroundColor, z: Number(getComputedStyle(el).zIndex) };
    });
    expect(result.ground).not.toBe('rgba(0, 0, 0, 0)');
    expect(result.z).toBeGreaterThanOrEqual(5);
  }
});

test('palette is independent, persists and follows System mode', async ({ page }) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.customThemes = [theme];
    payload.app.ui.theme = { preset: theme.id };
    await route.fulfill({ response, json: payload });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${CRM}/`);
  await expect(page.locator('.chart-donut')).toBeVisible();
  const root = page.locator('html');
  const heading = await root.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--heading-font'));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences', exact: true });
  await prefs.getByRole('button', { name: 'Palette', exact: true }).click();
  await page.getByRole('option', { name: 'Mint', exact: true }).click();
  await expect(root).toHaveAttribute('data-visual-theme', theme.id);
  await expect(root).toHaveAttribute('data-theme-palette', 'mint');
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(229, 243, 237)');
  await expect(prefs.getByRole('button', { name: 'Color mode' })).toContainText('System');
  await prefs.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(root).toHaveAttribute('data-theme-palette', 'mint');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(21, 42, 35)');
  await expect.poll(() => page.locator('body').evaluate((el) => el.style.getPropertyValue('--accent'))).toBe('#85e0b5');
  expect(await root.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--heading-font'))).toBe(heading);
});
