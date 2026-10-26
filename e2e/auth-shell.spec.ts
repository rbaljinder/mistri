// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { DEMO, expect, type Page, test } from './support/ownServers';
import { open } from './support/app';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

async function signedOutShell(page: Page) {
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await expect(page.locator('.topbar .brand-name')).toHaveText('Session workspace');
  await expect(page).toHaveTitle('Sign in · Session workspace');
  await expect(page.getByRole('heading', { name: 'Sign in to Session workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('#home-button')).toBeDisabled();
  await expect(page.locator('#home-button')).not.toHaveAttribute('title');
  // Assert the entire sidebar has no layout box, not merely its empty list.
  await expect(page.locator('.sidebar')).toHaveCSS('display', 'none');
  expect(await page.locator('.sidebar').boundingBox()).toBeNull();
  await expect(page.getByRole('navigation', { name: 'Tables', exact: true })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Filter tables', exact: true })).toHaveCount(0);
  for (const selector of [
    '#table-filter',
    '.sidebar-reveal',
    '#topnav',
    '#querybar',
    '#db-label',
    '#conn-picker',
    '.topbar-actions',
    '#sql-toggle',
    '#search-button',
  ]) {
    await expect(page.locator(selector)).toBeHidden();
  }
  await expect(page.locator('body')).not.toContainText('private-session-data');
  await expect(page.locator('body')).not.toContainText('Session-owned ticket');
  await expect(page.getByRole('button', { name: 'Records', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`signed-out App shell at ${width}px uses only public identity and returns after real sign-out`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width, height: 844 });
    const app = await startSessionApp();
    try {
      const requests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
      });
      await page.addInitScript(() => {
        localStorage.setItem('mistri.tour.v1', 'done');
        localStorage.setItem('mistri.sidebar-hidden', '1');
      });
      await page.goto(`${app.origin}/@ticket~1`);
      await signedOutShell(page);
      expect(requests).toEqual([]); // Public identity arrived in the private first-paint document.

      await page.getByLabel('Email', { exact: true }).fill(app.accounts[0].email);
      await page.getByLabel('Password', { exact: true }).fill(app.accounts[0].password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible();
      await expect(page.locator('.topbar .brand-name')).toHaveText('Session workspace');
      await expect(page.locator('#home-button')).toBeEnabled();
      if (width === 390) {
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        /* One level of groups folds into labelled sections, not levels to drill into. */
        await expect(page.locator('.tn-folded-pop .tn-folded-label')).toHaveText(['Records']);
        /* Focus moves into the menu a frame after it opens; an Escape pressed
           before that can be lost on a slow machine. Press it where a person
           would: with the menu focused. */
        await expect(page.getByRole('menu', { name: 'Menu' })).toBeFocused();
        await page.keyboard.press('Escape');
      } else await expect(page.getByRole('button', { name: 'Records', exact: true })).toBeVisible();
      await expect(page.locator('.topbar-actions')).toBeVisible();
      await page.getByRole('button', { name: /^Account:/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      await signedOutShell(page);
    } finally {
      await app.stop();
    }
  });

  test(`standalone shell at ${width}px preserves its header and usable table sidebar`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, DEMO);
    await expect(page.locator('.topbar .brand-name')).toHaveText('tablewalk');
    await expect(page).toHaveTitle('demo — tablewalk');
    await expect(page.locator('#home-button')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Database connection', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Database connection', exact: true })).toContainText(DEMO);
    await expect(page.locator('.topbar-actions')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Query', exact: true })).toBeVisible();
    // Standalone phone navigation intentionally starts collapsed.
    if (width === 390) await page.getByRole('button', { name: 'Show the table list', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Tables', exact: true })).toBeVisible();
    const filter = page.getByRole('searchbox', { name: 'Filter tables', exact: true });
    await expect(filter).toBeVisible();
    await filter.fill('invoice');
    await expect(page.locator('#table-list button[data-table="invoice"]')).toBeVisible();
    await expect(page.locator('#table-list button[data-table="customer"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
