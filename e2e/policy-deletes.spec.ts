import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

test.describe('scoped deletion', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ rowPolicy: true, deletedPolicy: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });
  /* One width: whether a policy permits the deletion is width-blind, and the
     phone's folded toolbar — More actions, Delete…, the confirmation — is
     covered at 390 by tick.spec.ts and presentation.spec.ts. */
  test('confirm deletion, with no Undo', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const account = app.accounts[0];
    expect(
      (
        await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`${app.origin}/@ticket~1`);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(scalar(app.database, 'SELECT count(*) FROM ticket WHERE id=1')).toBe(1);
    const response = page.waitForResponse(
      (reply) => reply.url().includes('/api/delete') && reply.request().postDataJSON()?.confirm === true,
    );
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    const result = await (await response).json();
    expect(result).toEqual({ deleted: true, affected: 1, impact: [] });
    expect(result.sql).toBeUndefined();
    await expect.poll(() => scalar(app.database, 'SELECT count(*) FROM ticket WHERE id=1')).toBe(0);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/ticket`));
    await expect(page.locator('body')).not.toContainText('Another ticket');
    // An App has no Undo: the revert route says so, and the record stays deleted.
    const revert = await page.request.post(`${app.origin}/api/revert`, {
      headers: { origin: app.origin },
      data: { app: SESSION_APP_ID, confirm: true, expectedId: 1 },
    });
    expect(revert.status()).toBe(404);
    expect(scalar(app.database, 'SELECT count(*) FROM ticket WHERE id=1')).toBe(0);
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=2')).toBe('Another ticket');
  });
  test('lost delete response leaves the record view locked without a blind retry', async ({ page }) => {
    const account = app.accounts[0];
    expect(
      (
        await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`${app.origin}/@ticket~1`);
    let attempts = 0;
    await page.route('**/api/delete*', async (route) => {
      if (route.request().postDataJSON()?.confirm !== true) return route.continue();
      attempts++;
      const response = await route.fetch();
      expect((await response.json()).deleted).toBe(true);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    // The words are in the toast and again in the screen readers' live region (toast.ts): the toast is what a person sees.
    await expect(page.locator('.toast-message').filter({ hasText: /Deletion was not confirmed/ })).toBeVisible();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/tickets\/1$/);
    expect(scalar(app.database, 'SELECT count(*) FROM ticket WHERE id=1')).toBe(0);
    expect(attempts).toBe(1);
  });
});
