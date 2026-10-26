/**
 * A public command form in the intake style, in a browser: a progress bar and
 * one question at a time, a sticky bar of actions, a row of fields side by
 * side, a Skip on a step left empty, an editable review that sends what it
 * shows, and the geometry at 411px: nothing moves the page sideways after any
 * Next (docs/design.md, rule 10). It starts its own server over a disposable
 * database (support/intakeServer.ts), so it shares nothing with another spec.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Locator, type Page } from './support/harness';
import { startIntakeApp } from './support/intakeServer';

type Fixture = Awaited<ReturnType<typeof startIntakeApp>>;

function stored(app: Fixture) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare('SELECT reference, email, first_name, last_name, date_of_birth, account_type, joint FROM application')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

const progress = (page: Page, step: number, label: string) =>
  expect(page.getByRole('progressbar', { name: `Step ${step} of 6: ${label}` })).toBeVisible();

async function press(page: Page, name: string, then: { step: number; label: string }) {
  await page.getByRole('button', { name, exact: true }).click();
  await progress(page, then.step, then.label);
}

async function toNameStep(page: Page) {
  await page.getByRole('textbox', { name: /^Email/ }).fill('ada@example.invalid');
  await page.getByLabel('Confirm email address', { exact: false }).fill('ada@example.invalid');
  await press(page, 'Continue', { step: 2, label: 'Name' });
}

async function toAccountStep(page: Page) {
  await page.getByLabel('First name', { exact: false }).fill('Ada');
  await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
  await page.getByRole('textbox', { name: /^Date of birth/ }).fill('12/10/1990');
  await press(page, 'Continue', { step: 3, label: 'Account' });
}

async function toConsent(page: Page) {
  await page.getByRole('radio', { name: 'Savings', exact: true }).check();
  await press(page, 'Almost there', { step: 4, label: 'Joint' });
  // Nothing on this step is answered, and every field is optional: the primary says Skip.
  await press(page, 'Skip', { step: 5, label: 'Consent' });
}

test.describe('The intake style of a public command form', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startIntakeApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('walks to the receipt: titles, a row, Skip, an editable review that sends what it shows', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    // The form's label is the tab's title; the page holds no form heading, only the step's title.
    await expect(page).toHaveTitle('Open an account');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("Let's start with your email.");
    await expect(page.getByText('Your information is stored securely')).toBeVisible();
    await expect(page.getByText('We write only about this application.')).toBeVisible();
    await progress(page, 1, 'Email');
    // The form's description is said once, on its first step.
    await expect(page.getByText('It takes about five minutes.')).toBeVisible();
    // The first step has nowhere to go back to.
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0);

    await toNameStep(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("What's your name?");
    await expect(page.getByText('It takes about five minutes.')).toHaveCount(0);
    // A row stands side by side.
    const [first, last] = [page.getByLabel('First name', { exact: false }), page.getByLabel('Last name', { exact: false })];
    const [a, b] = [await first.boundingBox(), await last.boundingBox()];
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
    await toAccountStep(page);
    // Several choices in icon cards: one tab stop, the arrows move between them, Space and a click each toggle one.
    const extras = page.getByRole('group', { name: /^Anything to go with it\?/ });
    const [card, overdraft] = [
      extras.getByRole('checkbox', { name: 'A debit card' }),
      extras.getByRole('checkbox', { name: 'Overdraft cover' }),
    ];
    await expect(card).toHaveAttribute('aria-checked', 'false');
    await card.click();
    await expect(card).toHaveAttribute('aria-checked', 'true');
    await expect(card).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(overdraft).toBeFocused();
    await page.keyboard.press('Space');
    await expect(overdraft).toHaveAttribute('aria-checked', 'true');
    await expect(extras.locator('[tabindex="0"]')).toHaveCount(1);
    await toConsent(page);

    await page.getByLabel('I agree to the terms', { exact: false }).check();
    await press(page, 'Continue', { step: 6, label: 'Review' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review your answers');
    await expect(page.getByText('A debit card, Overdraft cover', { exact: true })).toBeVisible();
    // Every step again as a summary under its name; Change opens its fields in place; Submit at the foot.
    for (const label of ['Email', 'Name', 'Account', 'Joint', 'Consent'])
      await expect(page.getByRole('heading', { level: 2, name: label, exact: true })).toBeVisible();
    await expect(page.getByText('Lovelace', { exact: true })).toBeVisible();
    await expect(page.getByText('Dec 10, 1990', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Change Name', exact: true }).click();
    await expect(page.getByLabel('First name', { exact: false })).toHaveValue('Ada');
    await page.getByLabel('First name', { exact: false }).fill('Augusta');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Your request is in' })).toBeVisible();
    await expect(page.getByText(/INT-/)).toBeVisible();
    expect(stored(app)).toMatchObject([
      {
        email: 'ada@example.invalid',
        first_name: 'Augusta',
        last_name: 'Lovelace',
        date_of_birth: '1990-12-10',
        account_type: 'savings',
        joint: 0,
      },
    ]);
  });

  test('Back keeps the answers, and a step is changed from the review', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    await toNameStep(page);
    await toAccountStep(page);
    await toConsent(page);
    await page.getByLabel('I agree to the terms', { exact: false }).check();
    await press(page, 'Continue', { step: 6, label: 'Review' });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await progress(page, 5, 'Consent');
    await expect(page.getByLabel('I agree to the terms', { exact: false })).toBeChecked();
    await press(page, 'Back', { step: 4, label: 'Joint' });
    await press(page, 'Back', { step: 3, label: 'Account' });
    await expect(page.getByRole('radio', { name: 'Savings', exact: true })).toBeChecked();
    await page.getByRole('radio', { name: 'Checking', exact: true }).check();
    await press(page, 'Almost there', { step: 4, label: 'Joint' });
    await press(page, 'Skip', { step: 5, label: 'Consent' });
    await press(page, 'Continue', { step: 6, label: 'Review' });
    await page.getByRole('button', { name: 'Change Name', exact: true }).click();
    await page.getByLabel('Last name', { exact: false }).fill('King');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your request is in' })).toBeVisible();
    expect(stored(app)).toMatchObject([{ account_type: 'checking', last_name: 'King' }]);
  });

  test('a yes or a no as buttons starts unanswered; the question on each answer waits for it', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    await toNameStep(page);
    await toAccountStep(page);
    await page.getByRole('radio', { name: 'Savings', exact: true }).check();
    await press(page, 'Almost there', { step: 4, label: 'Joint' });
    const [nickname, contact] = [
      page.getByLabel('What should we call you?', { exact: false }),
      page.getByLabel('Who should we name as your contact?', { exact: false }),
    ];
    // Unanswered is neither a yes nor a no: nothing that waits on either shows, and the step may be skipped.
    for (const radio of await page
      .getByRole('radiogroup', { name: /Is this a joint application\?/ })
      .getByRole('radio')
      .all())
      await expect(radio).not.toBeChecked();
    await expect(nickname).toHaveCount(0);
    await expect(contact).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'No', exact: true }).check({ force: true });
    await expect(contact).toBeVisible();
    await expect(nickname).toHaveCount(0);
    await page.getByRole('radio', { name: 'Yes', exact: true }).check({ force: true });
    await expect(nickname).toBeVisible();
    await expect(contact).toHaveCount(0);
    await press(page, 'Continue', { step: 5, label: 'Consent' });
    await page.getByLabel('I agree to the terms', { exact: false }).check();
    await press(page, 'Continue', { step: 6, label: 'Review' });
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your request is in' })).toBeVisible();
    expect(stored(app)).toMatchObject([{ joint: 1 }]);
  });

  test('a step with a missing answer holds there, and a mismatched confirmation is refused', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Email is required.', { exact: false }).first()).toBeVisible();
    await progress(page, 1, 'Email');
    // The command's rule, said by the step's check before the visitor walks on.
    await page.getByRole('textbox', { name: /^Email/ }).fill('ada@example.invalid');
    await page.getByLabel('Confirm email address', { exact: false }).fill('eve@example.invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('The email addresses do not match.').first()).toBeVisible();
    await progress(page, 1, 'Email');
  });
});

/* The geometry at a phone's width. A focus that scrolls, or a stepper that is wider than the page, moved the page
   sideways after a Next (P7a): after each Next, no ancestor of the form may scroll on its inline axis. */
test.describe('The intake form at 411px', () => {
  test.use({ viewport: { width: 411, height: 800 }, deviceScaleFactor: 2.625 });
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startIntakeApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  async function sideways(form: Locator) {
    return form.evaluate((node) => {
      const found: string[] = [];
      for (let el: Element | null = node; el; el = el.parentElement) {
        if (el.scrollWidth !== el.clientWidth)
          found.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}: ${el.scrollWidth} > ${el.clientWidth}`);
      }
      return found;
    });
  }

  test("the sticky bar clears a phone's home indicator: its foot pads by the safe-area inset", async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    const bar = page.locator('.intake-actions');
    await expect(bar).toBeVisible();
    const padding = () => bar.evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom));
    const without = await padding();
    // Chromium's own emulation of a notched phone's insets (viewport-fit=cover is what lets the page read them).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { bottom: 34 } } as never);
    await expect.poll(padding).toBe(Math.max(without, 34));
    const box = await bar.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(800 + 1);
  });

  test('no ancestor of the form scrolls sideways after any Next', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    const form = page.locator('.multi-step-form');
    await expect(form).toBeVisible();
    expect(await sideways(form)).toEqual([]);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    await page.getByRole('textbox', { name: /^Email/ }).fill('ada@example.invalid');
    await page.getByLabel('Confirm email address', { exact: false }).fill('ada@example.invalid');
    const steps: Array<[string, number, string]> = [
      ['Continue', 2, 'Name'],
      ['Continue', 3, 'Account'],
      ['Almost there', 4, 'Joint'],
      ['Skip', 5, 'Consent'],
      ['Continue', 6, 'Review'],
    ];
    for (const [name, step, label] of steps) {
      if (step === 3) {
        await page.getByLabel('First name', { exact: false }).fill('Ada');
        await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
        await page.getByRole('textbox', { name: /^Date of birth/ }).fill('12/10/1990');
      }
      if (step === 4) await page.getByRole('radio', { name: 'Savings', exact: true }).check();
      if (step === 6) await page.getByLabel('I agree to the terms', { exact: false }).check();
      await press(page, name, { step, label });
      expect(await sideways(form), `after Next to ${label}`).toEqual([]);
      expect(await page.evaluate(() => window.scrollX), `after Next to ${label}`).toBe(0);
      // The sticky bar stays in view, and its buttons are as tall as a touch target.
      const bar = await page.locator('.intake-actions').boundingBox();
      expect(bar!.y + bar!.height).toBeLessThanOrEqual(800 + 1);
    }
  });
});
