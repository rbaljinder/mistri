import { CRM, expect, test } from './support/ownServers';
import type { Page } from '@playwright/test';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });
// The payload is rewritten below; exercise its fetch fallback.
test.use({ carryFirstPaint: false });

/* Two products in one App, as a signed-in reader with both would be served them: a sales workspace and an accounts one,
   a page both use, and a footer group. Which workspaces a reader is served is the server's (a role that cannot open a
   workspace's rooms gets none of it); the shell is what is drawn here. */
async function twoWorkspaces(page: Page, only?: 'sales', extra = 0) {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.app.ui.shell = { ...payload.app.ui.shell, placement: 'side', menuSearch: true };
    payload.app.nav = [
      {
        group: 'sales',
        label: 'Sales',
        icon: 'briefcase',
        workspace: true,
        children: [
          { view: 'leads', label: 'Leads' },
          { view: 'sales-dashboard', label: 'Sales dashboard' },
        ],
      },
      ...(only
        ? []
        : [
            {
              group: 'accounts',
              icon: 'headset',
              label: 'Accounts and a very long workspace name that must wrap rather than push the drawer sideways',
              workspace: true,
              children: [
                { view: 'accounts', label: 'Accounts' },
                { view: 'sales-dashboard', label: 'Sales dashboard' },
              ],
            },
          ]),
    ];
    // More products than the bar holds, each with a room of its own.
    for (let i = 0; i < extra; i++)
      payload.app.nav.push({
        group: `extra-${i}`,
        label: `Extra workspace ${i + 1}`,
        workspace: true,
        children: [{ view: 'contacts', label: 'Contacts' }],
      });
    await route.fulfill({ response, json: payload });
  });
}

const entries = (page: Page) => page.locator('#table-list').locator('button, a').filter({ hasText: /\S/ });

test('the header switches workspaces and the sidebar lists only the current one', async ({ page }) => {
  await twoWorkspaces(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${CRM}/leads`);
  const switcher = page.getByRole('navigation', { name: 'Workspaces' });
  const tabs = switcher.getByRole('link');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(tabs.nth(1)).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#table-list button[data-table="lead"]')).toBeVisible();
  await expect(page.locator('#table-list button[data-table="account"]')).toHaveCount(0);
  // Plain links: an address a new tab opens, and the workspace in none of them.
  await expect(tabs.nth(1)).toHaveAttribute('href', /\/accounts$/);

  await tabs.nth(1).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#table-list button[data-table="account"]')).toBeVisible();
  await expect(page.locator('#table-list button[data-table="lead"]')).toHaveCount(0);
  // The menu's filter is of the workspace alone.
  await page.locator('#table-filter').fill('Leads');
  await expect(page.locator('#table-list button[data-table="lead"]')).toHaveCount(0);
  await page.locator('#table-filter').fill('');

  // A page both use: the reader stays in the workspace they are in.
  await page.locator('#table-list button', { hasText: 'Sales dashboard' }).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(entries(page).filter({ hasText: 'Accounts' })).toHaveCount(1);
});

test('a deep link into the second workspace selects it', async ({ page }) => {
  await twoWorkspaces(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${CRM}/accounts`);
  const tabs = page.getByRole('navigation', { name: 'Workspaces' }).getByRole('link');
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#table-list button[data-table="account"]')).toBeVisible();
});

test('one workspace left to this reader has no switcher, and its entries are the whole menu', async ({ page }) => {
  await twoWorkspaces(page, 'sales');
  await page.setViewportSize({ width: 1280, height: 800 });
  // A served view outside nav, reached by a link: the menu is still the one workspace's.
  await page.goto(`${CRM}/accounts`);
  await expect(page.locator('#table-list button[data-table="lead"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspaces' })).toHaveCount(0);
});

test('tabs that do not fit the bar go under More, whole, and the bar never scrolls sideways', async ({ page }) => {
  await twoWorkspaces(page, undefined, 4);
  await page.setViewportSize({ width: 960, height: 800 });
  await page.goto(`${CRM}/leads`);
  const bar = page.getByRole('navigation', { name: 'Workspaces' });
  const more = bar.getByRole('button', { name: 'More' });
  await expect(more).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await more.click();
  await page.getByRole('menuitem', { name: 'Extra workspace 4' }).click();
  await expect(bar.locator('[aria-current="page"]')).toHaveText('Extra workspace 4');
  await expect(page.locator('#table-list button[data-table="contact"]')).toBeVisible();
});

test('a phone lists the workspaces at the top of the drawer, with no sideways scroll', async ({ page }) => {
  await twoWorkspaces(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CRM}/leads`);
  await expect(page.locator('header.topbar').getByRole('navigation', { name: 'Workspaces' })).toHaveCount(0);
  await page.locator('.tn-mobile-menu').click();
  const drawer = page.getByRole('dialog');
  const tabs = drawer.getByRole('navigation', { name: 'Workspaces' }).getByRole('link');
  await expect(tabs).toHaveCount(2);
  await expect(drawer.locator('button[data-table="lead"]')).toBeVisible();
  await expect(drawer.locator('button[data-table="account"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Choosing one shows its entries in the same drawer.
  await tabs.nth(1).click();
  await expect(drawer.locator('button[data-table="account"]')).toBeVisible();
  await expect(drawer.locator('button[data-table="lead"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
