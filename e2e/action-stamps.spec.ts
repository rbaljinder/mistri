import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

/* Resolve stamps the moment and the person: the server's pinned clock (02:30
   UTC on 8 September, still 19:30 on the 7th in Los Angeles, the App's zone,
   whose wall clock a zone-less TIMESTAMP holds: appStamps.ts) and the
   signed-in account's email. The browser sends the words; a body naming
   another person or another moment is refused, since the stamp columns move
   only through the action. Both write paths: an App's own grants, and a row
   policy's scoped updates. */
for (const rowPolicy of [false, true]) {
  test.describe(`action stamps${rowPolicy ? ' under a row policy' : ''}`, () => {
    test.setTimeout(45_000);
    let app: Awaited<ReturnType<typeof startSessionApp>>;
    test.beforeEach(async () => {
      app = await startSessionApp({ stamps: true, rowPolicy });
    });
    test.afterEach(async () => {
      await app?.stop();
    });

    test('Resolve writes now and me on the server, and a forged stamp is refused', async ({ page }) => {
      const account = app.accounts[0];
      expect(
        (
          await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
            headers: { origin: app.origin },
            data: { email: account.email, password: account.password },
          })
        ).ok(),
      ).toBe(true);
      const row = () => ({
        status: scalar(app.database, 'SELECT status FROM ticket WHERE id=1'),
        at: scalar(app.database, 'SELECT resolved_at FROM ticket WHERE id=1'),
        on: scalar(app.database, 'SELECT resolved_on FROM ticket WHERE id=1'),
        by: scalar(app.database, 'SELECT resolved_by FROM ticket WHERE id=1'),
      });

      // Somebody else's name, or a moment of the caller's choosing, is no action's.
      const forged = await page.request.post(`${app.origin}/api/update`, {
        headers: { origin: app.origin },
        data: {
          app: SESSION_APP_ID,
          table: 'ticket',
          key: { id: 1 },
          values: { status: 'resolved', resolved_at: '1999-01-01 00:00:00', resolved_on: 'now', resolved_by: 'bob@example.test' },
        },
      });
      expect(forged.ok()).toBe(false);
      expect(row()).toEqual({ status: 'open', at: null, on: null, by: null });

      await page.goto(`${app.origin}/@ticket~1`);
      await page.getByRole('button', { name: 'Resolve', exact: true }).click();
      await expect.poll(() => row().status).toBe('resolved');
      expect(row()).toEqual({ status: 'resolved', at: '2026-09-07 19:30:00', on: '2026-09-07', by: account.email });
      // The page shows what was written, not the words.
      await expect(page.locator('body')).toContainText(account.email);
    });
  });
}
