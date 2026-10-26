import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

test.describe('field-level platform permissions', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ fieldPolicy: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  /* One width: a field grant reads the same on a phone, and the record and the
     New drawer are drawn at 390 by record-autosave.spec.ts and
     insert-reliability.spec.ts. */
  test('readable fields stay visible while only granted fields edit', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const account = app.accounts[0];
    const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.ok()).toBe(true);
    await page.goto(`${app.origin}/@ticket~1`);
    await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Status', exact: true })).toHaveCount(0);
    await expect(page.locator('.page-body')).toContainText('open');
    await expect(page.locator('body')).not.toContainText('FIELD_PRIVATE_SENTINEL');
    await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Allowed field edit');
    await page.getByRole('textbox', { name: 'Name', exact: true }).press('Tab');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Allowed field edit');
    expect(scalar(app.database, 'SELECT private_note FROM ticket WHERE id=1')).toBe('FIELD_PRIVATE_SENTINEL');

    // The same shared New form omits read-only fields and lets defaults fill
    // them; denied Delete must not also disable an authorized subset insert.
    await page.goto(`${app.origin}/ticket`);
    await page.getByRole('button', { name: '+ New ticket', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Status', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Private note');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Allowed field insert');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => scalar(app.database, "SELECT count(*) FROM ticket WHERE name='Allowed field insert'")).toBe(1);
    expect(scalar(app.database, "SELECT status FROM ticket WHERE name='Allowed field insert'")).toBe('open');
    await expect(page.locator('body')).not.toContainText('FIELD_PRIVATE_SENTINEL');
  });
});
