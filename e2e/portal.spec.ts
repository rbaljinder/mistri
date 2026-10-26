/**
 * An employee portal: the App draws its menu as a top bar for requesters
 * (`ui.shell.placement: { top: ['requester'] }`) and as the sidebar for
 * agents, and its home is one find box over tickets and help articles. The
 * box finds records from both for an agent, and only the articles for a
 * requester, whose grants read no tickets.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './support/harness';
import { startSessionApp } from './support/sessionServer';

test.describe('a portal', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ viewRoles: true, portal: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  async function signedIn(browser: Browser, account: { email: string; password: string }, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const login = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.ok()).toBe(true);
    return context.newPage();
  }

  /* What the home's box offers for a word, grouped: each group's word and its records' names. */
  async function found(page: Page, word: string) {
    const box = page.getByRole('combobox', { name: 'Find anything' });
    await box.fill(word);
    await expect(page.getByRole('option').first()).toBeVisible();
    return page.getByRole('listbox').evaluate((list) =>
      [...list.querySelectorAll('[role="group"]')].map((group) => ({
        group: group.querySelector('.find-group-title')?.textContent,
        names: [...group.querySelectorAll('.find-hit-name')].map((name) => name.textContent),
      })),
    );
  }

  test('a requester gets the top bar and an agent the sidebar; the find box finds what each may read, and opens it', async ({
    browser,
  }) => {
    const [alice, bob] = app.accounts;
    const store = new DatabaseSync(app.store);
    try {
      store.prepare('UPDATE user SET role = ? WHERE id = ?').run('requester', bob.id);
    } finally {
      store.close();
    }

    const agent = await signedIn(browser, alice);
    await agent.goto(`${app.origin}/`);
    await expect(agent.getByRole('heading', { name: 'Help center' })).toBeVisible();
    await expect(agent.locator('nav.sidebar')).toBeVisible();
    await expect(agent.locator('#topnav')).toBeHidden();
    expect(await found(agent, 'printer')).toEqual([
      { group: 'Tickets', names: ['Printer jam on floor 3'] },
      { group: 'Articles', names: ['Clear a printer jam', 'Install the printer driver'] },
    ]);
    // The line under a name is its list's: an article's topic.
    await expect(agent.getByRole('option', { name: /Clear a printer jam/ })).toContainText('Printers');

    const requester = await signedIn(browser, bob);
    await requester.goto(`${app.origin}/`);
    await expect(requester.getByRole('heading', { name: 'Help center' })).toBeVisible();
    await expect(requester.locator('#topnav')).toBeVisible();
    await expect(requester.locator('nav.sidebar')).toBeHidden();
    // The bar is what a requester may open: the articles, no tickets and no queue.
    await expect(requester.locator('#topnav')).toContainText('Articles');
    await expect(requester.locator('#topnav')).not.toContainText(/Tickets|Agent queue/);
    expect(await found(requester, 'printer')).toEqual([
      { group: 'Articles', names: ['Clear a printer jam', 'Install the printer driver'] },
    ]);
    // Nothing found says so.
    await requester.getByRole('combobox', { name: 'Find anything' }).fill('monitor');
    await expect(requester.getByText('Nothing matches “monitor”.')).toBeVisible();
    // The keyboard alone: the arrows light a hit, Enter opens its record at its own address.
    await found(requester, 'printer');
    await requester.keyboard.press('ArrowDown');
    await requester.keyboard.press('Enter');
    await expect(requester.getByRole('heading', { name: 'Install the printer driver', level: 1 })).toBeVisible();
    expect(new URL(requester.url()).pathname).toBe('/articles/2');

    /* On a phone the requester's bar folds into its one menu, and nothing scrolls sideways. */
    const phone = await signedIn(browser, bob, 390);
    await phone.goto(`${app.origin}/`);
    await expect(phone.getByRole('combobox', { name: 'Find anything' })).toBeVisible();
    await expect(phone.locator('nav.sidebar')).toBeHidden();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
