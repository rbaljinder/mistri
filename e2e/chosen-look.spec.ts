import { COMPASS, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

for (const mode of ['light', 'dark'] as const) {
  // A look the reader picks, over the App's own, compact: the lists and the
  // new-record drawer still fit and still refuse without writing.
  test(`a chosen look, ${mode}: dense lists and filled forms preserve interaction`, async ({ page }, info) => {
    test.setTimeout(45_000);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/(insert|update|delete)(?:\?|$)/.test(request.url())) writes.push(request.url());
    });
    await page.goto(CRM);
    await expect(page.locator('.chart-donut')).toBeVisible();
    const preferences = async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Preferences/ }).click();
      return page.getByRole('dialog', { name: 'Preferences', exact: true });
    };
    const prefs = await preferences();
    for (const [control, option] of [
      ['Visual theme', 'Sage'],
      ['Color mode', mode === 'light' ? 'Light' : 'Dark'],
      ['Density', 'Compact'],
    ]) {
      await prefs.getByRole('button', { name: control, exact: true }).click();
      await page.getByRole('option', { name: option, exact: control !== 'Density' }).click();
    }
    await prefs.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-style', 'sage');
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await page.goto(`${CRM}/opportunity`);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 924 });
      await expect(page.locator('.applist-title')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`list-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${CRM}/lead`);
    await page.getByRole('button', { name: '+ New lead', exact: true }).click();
    const drawer = page.locator('.newpanel');
    await expect(drawer).toBeVisible();
    const add = drawer.getByRole('button', { name: 'Add', exact: true });
    const colors = await add.evaluate((node) => {
      const style = getComputedStyle(node);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(colors.foreground).not.toBe(colors.background);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 924 });
      expect(await drawer.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`form-${width}.png`) });
    }
    await add.click();
    // Required fields say so where they are; the summary alert stays hidden.
    await expect(drawer.locator('.insert-field.missing .insert-missing').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });
}
