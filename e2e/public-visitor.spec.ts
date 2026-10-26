import { expect, test } from './support/harness';
import { FORECOURT_STAFF, startSample } from './support/sampleServer';

/**
 * A signed-out visitor of an App the public browses (Forecourt). At an
 * address a member's role opens (its inquiries) the refusal offers the
 * sign-in, drawn in place, and signing in comes back to that address rather
 * than the App's root; the sign-in screen is drawn in the shell's one <main>.
 * On a public form every control is named by its caption, "(required)" and
 * all. This spec's own server (listen(0), a fresh database).
 */
test.describe('a signed-out visitor', () => {
  test.setTimeout(120_000);
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    sample = await startSample('forecourt-market');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('a signed-out visitor is offered the sign-in and comes back to the address', async ({ page }) => {
    await page.goto(`${sample.origin}/inquiries`);
    const main = page.locator('main');
    await expect(main).toContainText('This page is for signed-in members.');
    await expect(main).not.toContainText('not available to your role');
    await main.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /Sign in/, level: 1 })).toBeVisible();
    // One main landmark: the screen is drawn in the shell's pane, not beside it.
    await expect(page.getByRole('main')).toHaveCount(1);
    await page.getByLabel('Email').fill(FORECOURT_STAFF.email);
    await page.getByLabel('Password').fill(FORECOURT_STAFF.password);
    await page.locator('form.signin-form').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`^${sample.origin}/inquiries(\\?|$)`));
    await expect(page.locator('main')).not.toContainText('signed-in members');
    await expect(page.getByRole('heading', { name: 'Inquiries', level: 1 })).toBeVisible();
  });

  test('a public form names every control by its caption, required state and all', async ({ page }) => {
    await page.goto(`${sample.origin}/form/inquire`);
    const form = page.locator('main form');
    // The listbox's button, which carried the bare caption as an aria-label, and the textboxes beside it.
    await expect(form.getByRole('button', { name: 'What would you like to know? (required)', exact: true })).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Your name (required)', exact: true })).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
    const unnamed = await form.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([aria-hidden=true]), textarea, select, button[aria-haspopup]')]
        .filter((control) => !(control as HTMLInputElement).labels?.length && !control.getAttribute('aria-labelledby'))
        .map((control) => control.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });
});
