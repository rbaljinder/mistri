import { expect, test } from './support/harness';
import { startSessionApp } from './support/sessionServer';

type Fixture = Awaited<ReturnType<typeof startSessionApp>>;

test.describe('the shared account menu', () => {
  test.setTimeout(45_000);
  let app: Fixture;
  test.beforeEach(async ({ page }) => {
    app = await startSessionApp();
    const account = app.accounts[0];
    const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(response.ok()).toBe(true);
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const [theme, mode] of [
    ['lumen', 'light'],
    ['lumen', 'dark'],
    ['mono', 'light'],
    ['mono', 'dark'],
  ] as const) {
    test(`${theme} ${mode}: desktop and phone menu preserves identity, keyboard focus and explicit sign-out`, async ({ page }) => {
      await page.addInitScript(
        ({ theme, mode }) => {
          localStorage.setItem('mistri.visual-theme', theme);
          localStorage.setItem('mistri.theme', mode);
        },
        { theme, mode },
      );
      await page.emulateMedia({ colorScheme: mode });
      let signsOut = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/sign-out') signsOut++;
      });
      await page.goto(`${app.origin}/@ticket~1`);
      const record = page.getByRole('heading', { name: 'Session-owned ticket', exact: true });
      // Each test boots a cold Vite server; concurrent owned fixtures can spend
      // longer than the interaction timeout loading the initial module graph.
      await expect(record).toBeVisible({ timeout: 20_000 });
      const trigger = page.getByRole('button', { name: /^Account:/ });
      await expect(trigger).toHaveAccessibleName(`Account: ${app.accounts[0].email}`);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(trigger).toBeVisible();
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        await expect(menu).toContainText('Signed in as');
        await expect(menu).toContainText(app.accounts[0].email);
        // The account's own two items; signed in to an App, the reader's settings sit between them (OverflowMenu.tsx).
        const settings = menu.locator('.account-menu-settings').getByRole('menuitem');
        await expect(settings.filter({ hasText: /^Preferences/ })).toBeVisible();
        expect(await menu.getByRole('menuitem').count()).toBe(2 + (await settings.count()));
        await expect(menu.getByRole('menuitem', { name: 'Your profile', exact: true })).toBeFocused();
        await expect(record).toBeVisible();
        expect(signsOut).toBe(0);
        // Resolve the same theme tokens in the popup's actual inherited context.
        const tokens = await menu.evaluate((node) => {
          const probe = document.createElement('div');
          probe.style.backgroundColor = 'var(--surface)';
          probe.style.borderRadius = 'var(--radius)';
          node.append(probe);
          const style = getComputedStyle(probe);
          const result = { background: style.backgroundColor, radius: style.borderRadius };
          probe.remove();
          return result;
        });
        await expect(menu).toHaveCSS('background-color', tokens.background);
        await expect(menu).toHaveCSS('border-radius', tokens.radius);
        const box = await menu.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }
      await trigger.click();
      const signedOut = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/sign-out');
      await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      const response = await signedOut;
      expect(response.ok()).toBe(true);
      expect(response.request().headers()['x-mistri-account']).toBe(app.accounts[0].id);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(signsOut).toBe(1);
    });
  }

  test('a lost sign-out acknowledgment locks immediately and never blindly retries or reloads', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.origin}/@ticket~1`);
    await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible({ timeout: 20_000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signsOut = 0;
    let reachedServer = false;
    let loads = 0;
    page.on('load', () => {
      loads++;
    });
    await page.route('**/api/auth/sign-out', async (route) => {
      signsOut++;
      expect(route.request().headers()['x-mistri-account']).toBe(app.accounts[0].id);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reachedServer = true;
      await held;
      await route.abort('failed');
    });
    try {
      await page.getByRole('button', { name: /^Account:/ }).click();
      expect(signsOut).toBe(0);
      await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      const lock = page.getByRole('alertdialog');
      await expect(lock).toBeVisible();
      await expect(lock.getByRole('button', { name: 'Reload', exact: true })).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toHaveCount(0);
      await expect.poll(() => reachedServer).toBe(true);
      release();
      await expect(lock).toContainText('Sign-out could not be confirmed');
      await expect(lock.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
      await expect(page.locator('body')).toHaveClass(/session-locked/);
      await page.keyboard.press('Escape');
      await expect(lock).toBeVisible();
      expect(signsOut).toBe(1);
      expect(loads).toBe(0);
    } finally {
      release();
    }
  });
});
