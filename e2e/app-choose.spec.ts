import { expect, test, type Page } from './support/harness';
import { startChooseApp } from './support/chooseServer';

/* An App's `choose` (test/fixtures/apps/choose): the chooser sits in the bar at a desk and in the account menu on a
   phone, a pick narrows the list that reads `chosen.site` and says so in a chip, and the pick is the person's, kept in
   the App's preferences store, so a reload and another browser of theirs find it. The server is this spec's own, on a
   port of its own, so it runs in the parallel lane. */
type Fixture = Awaited<ReturnType<typeof startChooseApp>>;

async function signIn(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function pick(page: Page, site: string) {
  const dialog = page.getByRole('dialog', { name: 'Choose site' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('option', { name: site }).click();
  await expect(dialog).toBeHidden();
}

test.describe('App choice', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startChooseApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('at a desk the chooser is in the bar, and nothing is chosen until it is used', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, app);
    await page.goto(`${app.origin}/visits`);
    const chooser = page.locator('#choice-host').getByRole('button', { name: /^Choose site/ });
    await expect(chooser).toBeVisible();
    // Nothing chosen matches no row: a list about the current site shows no site's rows rather than every site's.
    await expect(page.getByText('North flu shot')).toHaveCount(0);
    await expect(page.getByText('South sprain')).toHaveCount(0);
  });

  test('on a phone the chooser is an item of the account menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, app);
    await page.goto(`${app.origin}/visits`);
    await expect(page.locator('#choice-host').getByRole('button', { name: /^Choose site/ })).toBeHidden();
    await page.getByRole('button', { name: /^Account/ }).click();
    await page.getByRole('menuitem', { name: /Choose site/ }).click();
    await pick(page, 'Southside');
    // A phone's list names each row twice (its summary's title and its cell): the first is enough.
    await expect(page.getByText('South sprain').first()).toBeVisible();
    await expect(page.getByText('North flu shot')).toHaveCount(0);
  });

  test('a pick narrows the list, which says so in a chip that opens the chooser', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, app);
    await page.goto(`${app.origin}/visits`);
    await page
      .locator('#choice-host')
      .getByRole('button', { name: /^Choose site/ })
      .click();
    await pick(page, 'Northside');
    await expect(page.locator('#choice-host').getByRole('button', { name: /^Site: Northside/ })).toBeVisible();
    await expect(page.getByText('North flu shot')).toBeVisible();
    await expect(page.getByText('North checkup')).toBeVisible();
    await expect(page.getByText('South sprain')).toHaveCount(0);

    const chip = page.locator('.applist-chip-chosen');
    await expect(chip).toContainText('Site: Northside');
    // Its only way out is another pick: there is no x.
    await expect(chip.locator('.applist-chip-x')).toHaveCount(0);
    await chip.getByRole('button').click();
    await pick(page, 'Southside');
    await expect(chip).toContainText('Site: Southside');
    await expect(page.getByText('South sprain')).toBeVisible();
    await expect(page.getByText('North flu shot')).toHaveCount(0);
  });

  test('a reload keeps the pick, and so does another browser of the same person', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, app);
    await page.goto(`${app.origin}/visits`);
    await page
      .locator('#choice-host')
      .getByRole('button', { name: /^Choose site/ })
      .click();
    await pick(page, 'Southside');
    await expect(page.getByText('South sprain')).toBeVisible();

    await page.reload();
    await expect(page.locator('#choice-host').getByRole('button', { name: /^Site: Southside/ })).toBeVisible();
    await expect(page.getByText('South sprain')).toBeVisible();
    await expect(page.getByText('North flu shot')).toHaveCount(0);

    // A second context shares no tab storage with the first: only the server's copy can tell it.
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const second = await other.newPage();
      await signIn(second, app);
      await second.goto(`${app.origin}/visits`);
      await expect(second.locator('#choice-host').getByRole('button', { name: /^Site: Southside/ })).toBeVisible();
      await expect(second.getByText('South sprain')).toBeVisible();
      await expect(second.getByText('North flu shot')).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});
