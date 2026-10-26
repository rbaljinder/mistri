import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

test.describe('scoped update', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ fieldPolicy: true, rowPolicy: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });
  /* One width: which fields a policy lets a session edit does not change with
     the window, and the record's phone layout — Edit, Save changes — is
     covered by record-autosave.spec.ts and update-reliability.spec.ts, each of
     which runs at 390. */
  test('visible fields save without offering delete or Undo', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Name', exact: true });
    await input.fill('Scoped edit');
    await input.press('Tab');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Scoped edit');
    // An App has no Undo.
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await expect(input).toHaveValue('Scoped edit');
    await expect(page.getByRole('button', { name: 'Edit Status', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await page.goto(`${app.origin}/ticket`);
    await expect(page.getByRole('button', { name: '+ New ticket', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Another ticket');
    await expect(page.locator('body')).not.toContainText('FIELD_PRIVATE_SENTINEL');
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=2')).toBe('Another ticket');
  });
});
