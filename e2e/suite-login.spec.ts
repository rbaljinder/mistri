/** Suite login in a browser, over a Keystone-shaped SQLite suite (Keystone
 * itself needs PostgreSQL): Lender at the root, Dealer, Leads and Customer
 * mounted beside it. Each test owns its suite on a port of its own. */
import type { Page } from '@playwright/test';
import { expect, test } from './support/harness';
import { noteOf, startSuiteLogin, SUITE_LOGIN_PASSWORD, type SuiteLogin, type SuiteLoginApp } from '../test/support/suiteLoginFixture';

test.use({ storageState: { cookies: [], origins: [] }, carryFirstPaint: false });
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('mistri.tour.v1', 'done');
  });
});

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(SUITE_LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
const note = (page: Page, app: SuiteLoginApp) => page.locator('#content').getByText(noteOf(app), { exact: true }).filter({ visible: true });

let suite: SuiteLogin;
test.beforeEach(async () => {
  suite = await startSuiteLogin();
});
test.afterEach(async () => {
  await suite?.close();
});

test('a deep link survives the App door; another App’s page turns to the chooser, and a granted account follows it', async ({ page }) => {
  const { manager, officer } = suite.accounts;
  await page.goto(`${suite.origin}/dealer/notes?search=fixture`);
  await signIn(page, manager.email);
  await expect(note(page, 'dealer')).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/dealer\/notes\?search=fixture$/);

  // The same session at Lender: the chooser says so, and Lender's rows never draw.
  await page.goto(`${suite.origin}/notes`);
  await expect(page).toHaveURL(`${suite.chooser}?next=%2Fnotes`);
  await expect(page.getByRole('alert')).toHaveText(/Your account has no access to Lender\./);
  await expect(page.locator('#links a')).toHaveText(['Dealer', 'Leads']);
  await expect(page.getByText(noteOf('lender'))).toHaveCount(0);

  // Another account, signed in here, is carried to the address it can open.
  await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
  await signIn(page, officer.email);
  await expect(note(page, 'lender')).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(`${suite.origin}/notes`);
});

test('the suite address lands each account by its grants, asks when it has several, and says when it has none', async ({ page }) => {
  const { borrower, agent, nobody } = suite.accounts;
  await page.goto(`${suite.origin}/`);
  await expect(page).toHaveURL(`${suite.chooser}?entry=1`);
  await signIn(page, borrower.email);
  await expect(note(page, 'customer')).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/customer\//);

  await page.context().clearCookies();
  await page.goto(`${suite.origin}/`);
  await signIn(page, agent.email);
  await expect(page).toHaveURL(suite.chooser);
  await expect(page.locator('#links a')).toHaveText(['Dealer', 'Leads']);
  // Dealer declares a logo and is drawn with it, quietly and hidden from a screen reader; Leads declares none.
  await expect(page.locator('#links li').nth(0).locator('svg[aria-hidden="true"]')).toHaveCount(1);
  await expect(page.locator('#links li').nth(1).locator('svg')).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
  await signIn(page, nobody.email);
  await expect(page.getByText('No App access has been granted yet.', { exact: false })).toBeVisible();
  await expect(page.locator('#links')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out of the suite', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('signing out in one App signs every App and the chooser out', async ({ page }) => {
  const { manager } = suite.accounts;
  await page.goto(`${suite.origin}/leads/notes`);
  await signIn(page, manager.email);
  await expect(note(page, 'leads')).toBeVisible({ timeout: 60_000 });
  await page.goto(`${suite.origin}/dealer/notes`);
  await expect(note(page, 'dealer')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.goto(`${suite.origin}/leads/notes`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(noteOf('leads'))).toHaveCount(0);
  await page.goto(suite.chooser);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
