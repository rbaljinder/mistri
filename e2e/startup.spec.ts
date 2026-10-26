import { COMPASS, expect, test } from './support/ownServers';

// This spec controls boot API responses; exercise their fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

for (const width of [320, 1024, 1440])
  test(`startup never exposes the database shell before the app at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => {
      localStorage.setItem('mistri.visual-theme', 'lumen');
      localStorage.setItem('mistri.theme', 'dark');
    });
    let release!: () => void;
    let requested!: () => void;
    let paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(/\/api\/app(?:\?|$)/, async (route) => {
      requested();
      await paused;
      await route.continue();
    });
    try {
      await page.goto(`${CRM}/@opportunity~19`, { waitUntil: 'domcontentloaded' });
      await started;
      await expect(page.locator('#startup-status')).toBeVisible();
      await expect(page.locator('.topbar')).toBeHidden();
      await expect(page.locator('.layout')).toBeHidden();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe('/@opportunity~19');
      release();
      await expect(page.locator('html')).not.toHaveAttribute('data-starting');
      await expect(page.locator('body')).toHaveClass(/\bapp-mode\b/);
      await expect(page.locator('body')).toHaveClass(/\bapp-topnav\b/);
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('.root-current')).toBeVisible();
      const background = await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor);
      paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      started = new Promise<void>((resolve) => {
        requested = resolve;
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await started;
      await expect(page.locator('.topbar')).toBeHidden();
      await expect(page.locator('.layout')).toBeHidden();
      expect(await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(background);
      await page.screenshot({ path: testInfo.outputPath(`startup-pending-${width}.png`) });
      release();
      await expect(page.locator('#startup-status')).toBeHidden();
      await expect(page.locator('.root-current')).toBeVisible();
    } finally {
      release();
    }
  });

test('an unexpected boot failure shows a reload action instead of a permanent splash', async ({ page }) => {
  await page.route('**/api/runtime', (route) => route.fulfill({ json: { appConfigured: true, active: 'compass', apps: null } }));
  await page.goto(CRM);
  const status = page.locator('#startup-status');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toContainText(/could not start/i);
  await expect(status.getByRole('link', { name: 'Reload' })).toBeVisible();
  await expect(page.locator('.layout')).toBeHidden();
});
