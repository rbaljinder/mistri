/** Loaner Desk's browser layer: what only a page shows, on a desk and on a phone (the config's two projects).
 * Each test owns its App, database and kiosk through the same public fixture as acceptance.test.ts. */
import { test as base, expect, type Page } from '@playwright/test';
import { createLoanerDeskFixture, PASSWORD, type LoanerDeskFixture } from './fixture.ts';

const test = base.extend<{ desk: LoanerDeskFixture }>({
  desk: async ({ browserName }, use) => {
    if (!browserName) throw new Error('A browser project is required.');
    const desk = await createLoanerDeskFixture();
    try {
      await use(desk);
    } finally {
      await desk.close();
    }
  },
});
// The first page of a disposable host loads its client cold.
test.setTimeout(90_000);
const ready = expect.configure({ timeout: 30_000 });
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function signIn(page: Page, url: string, email: string) {
  await page.goto(url);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Readiness is a thing the person can see, never a sleep.
  await ready(page.getByRole('heading', { name: 'Equipment', exact: true })).toBeVisible();
}

test('staff check an item out in its form and see the loan open', async ({ page, desk, isMobile }) => {
  await signIn(page, desk.host.url, 'staff@example.test');
  await page.goto(`${desk.host.url}/equipment/camera`);
  await ready(page.getByRole('button', { name: 'Check out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check out', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Check out', exact: true });
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  await form.getByRole('combobox', { name: 'Borrower (required)', exact: true }).fill('Ada Brooks');
  await page.getByRole('option', { name: 'Ada Brooks', exact: true }).click();
  await form.getByRole('textbox', { name: 'Due on (required)', exact: true }).fill(tomorrow());
  await form.getByRole('button', { name: 'Check out', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Camera kit checked out to Ada Brooks.');
  expect(desk.rows('SELECT borrower_id, status FROM equipment_loan')).toEqual([{ borrower_id: 'ada', status: 'open' }]);
  if (isMobile) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('a viewer reads the equipment but is offered no command', async ({ page, desk }) => {
  await signIn(page, desk.host.url, 'viewer@example.test');
  await page.goto(`${desk.host.url}/equipment/camera`);
  await ready(page.getByRole('heading', { name: 'Camera kit' })).toBeVisible();
  // Hiding the button is presentation; acceptance.test.ts proves the server refuses the command.
  await expect(page.getByRole('button', { name: 'Check out', exact: true })).toHaveCount(0);
});
