/**
 * `mistri new --template intake`, walked in a browser: the starter a person gets is a public multi-step intake made of
 * the stock blocks alone — a progress bar, icon cards, a Yes and a No, two names in a row, a rule said at the step that
 * ends it, an editable review — and a visitor sends one inquiry that lands in its table. It generates the App with the
 * real CLI into a disposable folder (support/newIntakeServer.ts) and shares nothing with another spec.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { startNewIntake } from './support/newIntakeServer';

type Started = Awaited<ReturnType<typeof startNewIntake>>;

const stored = (app: Started) => {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare(
        "SELECT reference, email, first_name, last_name, phone, topic, urgent, message FROM inquiry WHERE email = 'ada@example.invalid' ORDER BY id",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

const progress = (page: Page, step: number, label: string) =>
  expect(page.getByRole('progressbar', { name: `Step ${step} of 5: ${label}` })).toBeVisible();

test.describe('The intake template', () => {
  test.setTimeout(120_000);
  let app: Started;
  test.beforeEach(async () => {
    app = await startNewIntake();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('a visitor walks four steps and the review, and the inquiry is stored', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    await expect(page).toHaveTitle('Contact us');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Let’s start with your email.');
    await progress(page, 1, 'Email');
    await page.getByRole('textbox', { name: /^Email/ }).fill('ada@example.invalid');
    await page.getByLabel('Confirm email address', { exact: false }).fill('eve@example.invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // submitInquiry's rule (the two emails match) is said at the step that asks the last field it names.
    await expect(page.getByText('The email addresses do not match.').first()).toBeVisible();
    await page.getByLabel('Confirm email address', { exact: false }).fill('ada@example.invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await progress(page, 2, 'You');
    const [first, last] = [page.getByLabel('First name', { exact: false }), page.getByLabel('Last name', { exact: false })];
    await first.fill('Ada');
    await last.fill('Lovelace');
    const [a, b] = [await first.boundingBox(), await last.boundingBox()];
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await progress(page, 3, 'Inquiry');
    await page.getByRole('radio', { name: 'Support', exact: true }).check({ force: true });
    await page.getByRole('radio', { name: 'Yes', exact: true }).check({ force: true });
    await page.getByRole('textbox', { name: /^Tell us more/ }).fill('The kettle is on fire.');
    await page.getByRole('button', { name: 'Review', exact: true }).click();

    await progress(page, 4, 'Consent');
    await page.getByLabel('I agree to be contacted', { exact: false }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review your answers');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(page.getByText(/INQ-/)).toBeVisible();
    expect(stored(app)).toMatchObject([
      {
        email: 'ada@example.invalid',
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: null,
        topic: 'support',
        urgent: 1,
        message: 'The kettle is on fire.',
      },
    ]);
  });

  test('on a phone, nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 411, height: 800 });
    await page.goto(`${app.origin}/form/apply`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  });
});
