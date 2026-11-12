import { expect, test } from './support/harness';
import { startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

/* A role whose `create` names a table its `write` does not (a field report: a service role that only appends a row)
   adds rows there through New and is never offered an edit or a removal; the server refuses both when asked anyway
   (test/append-only-grant.test.ts, test/app-api-writes-events*.test.ts). */
test.describe('an append-only grant', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ appendOnly: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('adds a ticket through New, and draws no pencil and no Delete on one', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const account = app.accounts[0];
    const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.ok()).toBe(true);

    await page.goto(`${app.origin}/ticket`);
    await page.getByRole('button', { name: '+ New ticket', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Appended ticket');
    await page.getByRole('textbox', { name: 'Status', exact: true }).fill('open');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => scalar(app.database, "SELECT count(*) FROM ticket WHERE name='Appended ticket'")).toBe(1);

    await page.goto(`${app.origin}/@ticket~1`);
    await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible();
    await expect(page.locator('.page-body')).toContainText('open');
    await expect(page.getByRole('button', { name: /^Edit Name(?: |$)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Edit Status(?: |$)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Session-owned ticket');
  });
});
