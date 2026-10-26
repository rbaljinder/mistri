import { expect, test } from './support/harness';

// Bootstrap capability mocks exercise the fetch fallback.
test.use({ carryFirstPaint: false });
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

test.describe('built-in own-account profile', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
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

  for (const mode of ['light', 'dark'] as const) {
    test(`${mode}: desktop/phone themed profile edits only name and restores keyboard focus`, async ({ page }) => {
      await page.addInitScript((mode) => {
        localStorage.setItem('mistri.theme', mode);
      }, mode);
      await page.emulateMedia({ colorScheme: mode });
      let signsOut = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/sign-out') signsOut++;
      });
      await page.goto(`${app.origin}/@ticket~1`);
      const trigger = page.getByRole('button', { name: /^Account:/ });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'Your profile' })).toBeFocused();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Your profile' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
        await expect(dialog.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
        await expect(dialog.getByLabel('Email', { exact: true })).toHaveValue(app.accounts[0].email);
        await expect(dialog).toContainText('Email and password');
        const tokens = await dialog.evaluate((node) => {
          const probe = document.createElement('div');
          probe.style.background = 'var(--surface)';
          probe.style.color = 'var(--ink)';
          // A dialog wears the dialog's step (design.md, Tokens): the look's larger radius, not a control's.
          probe.style.borderRadius = 'var(--radius-dialog)';
          // A field's edge is the control border, at 3:1 (design.md, Access), not the section hairline.
          probe.style.border = '1px solid var(--line-control)';
          node.append(probe);
          const style = getComputedStyle(probe);
          const result = { background: style.backgroundColor, color: style.color, radius: style.borderRadius, border: style.borderColor };
          probe.remove();
          return result;
        });
        await expect(dialog).toHaveCSS('background-color', tokens.background);
        await expect(dialog).toHaveCSS('color', tokens.color);
        /* A dialog takes the whole screen on a phone (Modal's default), and a
           full-screen dialog is square: there is no page behind its corners
           for a radius to round against. At desk width it wears the look's. */
        await expect(dialog).toHaveCSS('border-radius', width > 640 ? tokens.radius : '0px');
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveCSS('background-color', tokens.background);
        await expect(dialog.getByLabel('Email', { exact: true })).toHaveCSS('border-top-color', tokens.border);
        await expect(dialog.getByRole('button', { name: 'Save name' })).toBeDisabled();
        await expect(dialog.getByRole('button', { name: 'Save name' })).toHaveCSS('opacity', '0.5');
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await dialog.getByLabel('Name', { exact: true }).fill(`Alice ${width}`);
        await dialog.getByRole('button', { name: 'Save name' }).click();
        await expect(dialog).toContainText('Name saved.');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        const current = await page.request.get(`${app.origin}/api/auth/profile?app=${SESSION_APP_ID}`, {
          headers: { 'x-mistri-account': app.accounts[0].id },
        });
        expect(current.ok()).toBe(true);
        expect((await current.json()).profile.name).toBe(`Alice ${width}`);
      }
      expect(signsOut).toBe(0);
    });
  }

  test('a lost real save response is uncertain, never repeated, and recovers through an explicit current-profile read', async ({
    page,
  }) => {
    await page.goto(`${app.origin}/@ticket~1`);
    await page.getByRole('button', { name: /^Account:/ }).click();
    await page.getByRole('menuitem', { name: 'Your profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Your profile' });
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Alice');
    let saves = 0;
    await page.route('**/api/auth/profile?*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      saves++;
      expect(route.request().postDataJSON()).toEqual({ name: 'Alice recovered' });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    });
    await dialog.getByLabel('Name', { exact: true }).fill('Alice recovered');
    await dialog.getByRole('button', { name: 'Save name' }).click();
    await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
    await expect(dialog.getByRole('button', { name: 'Save name' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Check current profile' }).click();
    await expect(dialog).toContainText('Current profile loaded.');
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Alice recovered');
    expect(saves).toBe(1);
  });

  test('an older bootstrap without explicit capability never exposes a dead profile link', async ({ page }) => {
    await page.route('**/api/whoami*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.accountProfile;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${app.origin}/@ticket~1`);
    await page.getByRole('button', { name: /^Account:/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Your profile' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });
});
