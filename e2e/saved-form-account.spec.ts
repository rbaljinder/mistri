/**
 * A submitted application added to an account, in a browser: the done
 * screen's "Create an account to track this", the App's own sign-up, the
 * question "Add it to your account?", and then the status check — which
 * shows the account its application, tells a wrong detail from nothing, and
 * no longer answers anyone else for it.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { SAVED_APP_ID, startSavedFormApp } from './support/savedFormServer';

type Fixture = Awaited<ReturnType<typeof startSavedFormApp>>;

function linked(app: Fixture) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare('SELECT reference, account_id, linked_via, claim_token_hash FROM application')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function next(page: Page, heading: string) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

async function apply(page: Page, origin: string): Promise<string> {
  await page.goto(`${origin}/form/apply`);
  await page.getByLabel('First name', { exact: false }).fill('Ada');
  await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
  await page.getByLabel('Email', { exact: false }).fill('ada@example.invalid');
  await next(page, 'Address');
  await page.getByLabel('Street address', { exact: false }).fill('12 Analytical Row');
  await page.getByLabel('City', { exact: false }).fill('Springfield');
  await page.getByLabel('ZIP code', { exact: false }).fill('02134');
  await next(page, 'Income');
  await page.getByLabel('Employer', { exact: false }).fill('Engine Works');
  await page.getByLabel('Annual income', { exact: false }).fill('84000');
  await next(page, 'Co-applicant');
  await next(page, 'Review');
  await page.getByLabel('The details I gave are true', { exact: false }).check();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { name: 'Application received' })).toBeVisible();
  return (await page.locator('.form-page-reference strong').textContent())?.trim() ?? '';
}

test.describe('A submitted application added to an account', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startSavedFormApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test("the done screen's account link, a sign-up, Yes — and then the status check is the account's alone", async ({ page, browser }) => {
    const reference = await apply(page, app.origin);
    // The claim is the server's alone, beside the receipt, for this form's paths only.
    expect(await page.context().cookies()).toEqual([
      expect.objectContaining({ name: 'tw_claim_apply', httpOnly: true, sameSite: 'Strict', path: '/api/forms/apply' }),
    ]);

    await page.getByRole('link', { name: 'Create an account to track this' }).click();
    await expect(page.getByRole('heading', { name: /^Create your .* account$/ })).toBeVisible();
    await expect(page.getByText('Sign in to add the application you just submitted to your account.')).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('difference-engine-1843');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Signed in, the question: never answered by the sign-in alone.
    await expect(page.getByRole('heading', { name: 'Add it to your account?' })).toBeVisible();
    await expect(page.getByText(reference)).toBeVisible();
    expect(linked(app)).toMatchObject([{ reference, account_id: null }]);
    await page.getByRole('button', { name: 'Yes, add it' }).click();
    await expect(page.getByRole('heading', { name: 'Added to your account' })).toBeVisible();
    expect(linked(app)).toMatchObject([{ reference, account_id: expect.any(String), linked_via: 'same-device', claim_token_hash: null }]);
    expect((await page.context().cookies()).map((cookie) => cookie.name)).not.toContain('tw_claim_apply');

    await page.getByRole('link', { name: 'See its status' }).click();
    await expect(page.getByRole('heading', { name: 'Check your application' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your applications' })).toBeVisible();
    await expect(page.locator('.form-account').getByText(reference)).toBeVisible();

    // A wrong detail reads as nothing found, and points at no field.
    await page.getByLabel('Reference').fill(reference);
    await page.getByLabel('Last name').fill('Byron');
    await page.getByRole('button', { name: 'Check status' }).click();
    const refusal = page.getByRole('alert').filter({ hasText: /could not find an application/ });
    await expect(refusal).toBeVisible();
    await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
    await page.getByLabel('Last name').fill('Lovelace');
    await page.getByRole('button', { name: 'Check status' }).click();
    await expect(page.locator('.form-status-answer').getByText('Received')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to my account' })).toHaveCount(0);

    // Anyone else, with the very same details, is told what a wrong detail is told.
    const stranger = await browser.newContext();
    try {
      const other = await stranger.newPage();
      await other.goto(`${app.origin}/form/apply/status`);
      await other.getByLabel('Reference').fill(reference);
      await other.getByLabel('Last name').fill('Lovelace');
      await other.getByRole('button', { name: 'Check status' }).click();
      await expect(other.getByRole('alert').filter({ hasText: /could not find an application/ })).toBeVisible();
      await expect(other.getByText('Received')).toHaveCount(0);
    } finally {
      await stranger.close();
    }
  });
});
