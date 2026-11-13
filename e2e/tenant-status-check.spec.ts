/**
 * A tenant App's status check, in the browser over the tenant host (support/tenantPublicFormsServer.ts): a visitor at a
 * dealer's intake address checks a reference with the name it was given under and reads that dealer's answer, not the
 * other dealer's under the same reference; a wrong name and an unknown reference read alike. A code then opens the
 * application's details once, sent where the App says: by email, or by text on the tenant's own channel, which the page
 * names. A fresh server per test, each with budgets of its own, on a port of its own, so it runs beside others.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/harness.js';
import { NORTH, SOUTH, startTenantPublicForms, type TenantPublicFormsApp, via } from './support/tenantPublicFormsServer.js';

const codeIn = (text: string | undefined) => /\b(\d{6})\b/.exec(text ?? '')?.[1];

test.describe("a tenant App's status check", () => {
  test.setTimeout(60000);
  let app: TenantPublicFormsApp | undefined;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  });
  test.afterEach(async () => {
    await app?.stop();
    app = undefined;
  });
  const check = async (page: Page, reference: string, name: string) => {
    await page.locator('input[name="receipt"]').fill(reference);
    await page.locator('input[name="name"]').fill(name);
    await page.getByRole('button', { name: 'Check status' }).click();
  };

  test("a dealer's visitor reads that dealer's answer, and a code by email opens its details", async ({ page }) => {
    app = await startTenantPublicForms({ statusCheck: true });
    await page.goto(`${app.origin}/yard/form/draft/status${via(NORTH)}`);
    // A wrong name and a reference this dealer never gave read alike: neither says which was wrong.
    await check(page, 'YRD-1', 'Bea');
    const alert = page.locator('.form-page-failure[role="alert"]').first();
    await expect(alert).toBeVisible();
    const wrongName = await alert.textContent();
    await check(page, 'YRD-404', 'Ada');
    await expect(alert).toHaveText(wrongName!);
    await expect(page.locator('.form-status-answer')).toHaveCount(0);

    await check(page, 'YRD-1', 'Ada');
    const answer = page.locator('.form-status-answer');
    await expect(answer).toContainText(/reviewing/i);
    await expect(answer).not.toContainText(/approved/i);

    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByText('We sent a code to your email.')).toBeVisible();
    let code: string | undefined;
    await expect
      .poll(async () => {
        const sent = (await app!.mail()).filter((message) => message.to.includes('ada@example.test'));
        return (code = codeIn(sent.at(-1)?.text));
      })
      .toMatch(/^\d{6}$/);
    expect(await page.content()).not.toContain(code!);
    await page.getByLabel('Code from the email').fill(code!);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('North detail')).toBeVisible();
    await expect(page.getByText('South detail')).toHaveCount(0);
  });

  test("the other dealer's visitor reads its own answer under the same reference", async ({ page }) => {
    app = await startTenantPublicForms({ statusCheck: true });
    await page.goto(`${app.origin}/yard/form/draft/status${via(SOUTH)}`);
    await check(page, 'YRD-1', 'Ada');
    await expect(page.locator('.form-page-failure[role="alert"]').first()).toBeVisible();
    await check(page, 'YRD-1', 'Bea');
    await expect(page.locator('.form-status-answer')).toContainText(/approved/i);
  });

  test("on the sms channel the page names a text, and the code comes to the stored number under the tenant's key", async ({ page }) => {
    app = await startTenantPublicForms({ statusCheck: 'sms' });
    await page.goto(`${app.origin}/yard/form/draft/status${via(NORTH)}`);
    await check(page, 'YRD-1', 'Ada');
    await expect(page.locator('.form-status-answer')).toContainText(/reviewing/i);
    await expect(page.getByRole('button', { name: 'Email me a code' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText('We sent a code by text message.')).toBeVisible();
    let code: string | undefined;
    await expect
      .poll(async () => {
        const [sent] = await app!.texts();
        if (sent) expect(sent).toMatchObject({ to: '+1 (555) 010-0001', apiKey: 'sk_north' });
        return (code = codeIn(sent?.text));
      })
      .toMatch(/^\d{6}$/);
    await page.getByLabel('Code from the message').fill(code!);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('North detail')).toBeVisible();
  });
});
