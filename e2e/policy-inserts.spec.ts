import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';
import { scalar } from './support/db';

test.describe('scoped creation', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.afterEach(async () => {
    await app?.stop();
  });
  /* One width: what this file proves — which fields a policy offers — is the
     same on a phone, and the New drawer's own phone layout is
     covered by insert-reliability.spec.ts and new-record-validation.spec.ts. */
  for (const fieldPolicy of [false, true]) {
    test(`${fieldPolicy ? 'field-limited defaults' : 'complete creation'}, with no Undo`, async ({ page }) => {
      app = await startSessionApp({ rowPolicy: true, fieldPolicy });
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
      await page.goto(`${app.origin}/ticket`);
      await expect(page.locator('body')).not.toContainText('Another ticket');
      await page.getByRole('button', { name: '+ New ticket', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Scoped creation');
      if (fieldPolicy) {
        await expect(page.getByRole('textbox', { name: 'Status', exact: true })).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('Private note');
      } else await page.getByRole('textbox', { name: 'Status', exact: true }).fill('open');
      const saved = page.waitForResponse((response) => response.url().includes('/api/insert') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const result = await (await saved).json();
      expect(result.key).toEqual({ id: 3 });
      expect(result.sql).toBeUndefined();
      await expect.poll(() => scalar(app.database, "SELECT count(*) FROM ticket WHERE name='Scoped creation'")).toBe(1);
      expect(scalar(app.database, 'SELECT status FROM ticket WHERE id=3')).toBe('open');
      await expect(page.locator('body')).not.toContainText('Another ticket');
      await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
      // An App has no Undo: the creation carries none, and its revert route says so.
      expect(result.undoId).toBeUndefined();
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      const revert = await page.request.post(`${app.origin}/api/revert`, {
        headers: { origin: app.origin },
        data: { app: SESSION_APP_ID, confirm: true, expectedId: 1 },
      });
      expect(revert.status()).toBe(404);
      if (fieldPolicy) {
        await expect(page.locator('body')).not.toContainText('FIELD_PRIVATE_SENTINEL');
        expect(scalar(app.database, 'SELECT private_note FROM ticket WHERE id=3')).toBe('FIELD_PRIVATE_SENTINEL');
      }
      expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=2')).toBe('Another ticket');
    });
  }
});
