/**
 * A view that names its roles (`roles: ['agent']`) is in an agent's menu and
 * nowhere a requester looks: not their menu, and its address opens for them
 * exactly as an address that names no view at all.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Browser } from '@playwright/test';
import { expect, test } from './support/harness';
import { startSessionApp } from './support/sessionServer';

test.describe('a view that names its roles', () => {
  test.setTimeout(45_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ viewRoles: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  async function signedIn(browser: Browser, account: { email: string; password: string }) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.ok()).toBe(true);
    return context;
  }

  /* ⌘K's entry for the queue, once the destinations it offers have drawn (Tickets is everyone's). */
  async function palette(page: import('@playwright/test').Page) {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
    await expect(page.locator('.palette-item', { hasText: 'Tickets' }).first()).toBeVisible();
    return page.locator('.palette-item', { hasText: 'Agent queue' });
  }

  test('is in the menu of a role it names, and a direct visit by another role finds nothing there', async ({ browser }) => {
    const [alice, bob] = app.accounts;
    /* Both signed up as agents (the App's default role); bob is made a requester. */
    const store = new DatabaseSync(app.store);
    try {
      store.prepare('UPDATE user SET role = ? WHERE id = ?').run('requester', bob.id);
    } finally {
      store.close();
    }

    const agent = await (await signedIn(browser, alice)).newPage();
    await agent.goto(`${app.origin}/tickets`);
    const records = agent.getByRole('button', { name: 'Records', exact: true });
    await records.click();
    await expect(agent.getByRole('menuitem', { name: 'Agent queue', exact: true })).toBeVisible();
    await agent.keyboard.press('Escape');
    await expect(await palette(agent)).toHaveCount(1);
    await agent.keyboard.press('Escape');
    await agent.goto(`${app.origin}/queue`);
    await expect(agent.getByRole('heading', { name: 'Agent queue', exact: true })).toBeVisible();

    const requester = await (await signedIn(browser, bob)).newPage();
    await requester.goto(`${app.origin}/tickets`);
    await expect(requester.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();
    await requester.getByRole('button', { name: 'Records', exact: true }).click();
    await expect(requester.getByRole('menuitem', { name: 'Tickets', exact: true })).toBeVisible();
    await expect(requester.getByRole('menuitem', { name: 'Agent queue', exact: true })).toHaveCount(0);
    await requester.keyboard.press('Escape');
    await expect(await palette(requester)).toHaveCount(0);
    await requester.keyboard.press('Escape');

    /* The queue's address, and one that names no view: the same answer — the
       crumb echoing the address typed — and no word of the queue. */
    const said = async (address: string, crumb: string) => {
      await requester.goto(`${app.origin}/${address}`);
      const main = requester.locator('main');
      await expect(main).toContainText('This page is not available to your role.');
      // The shell holds main hidden until its first paint settles; read the words once they are shown.
      await expect(main).toBeVisible();
      return { url: new URL(requester.url()).pathname.replace(address, '…'), text: (await main.innerText()).replace(crumb, '…') };
    };
    const queue = await said('queue', 'Queue');
    expect(queue).toEqual(await said('no-such-view', 'No-such-view'));
    expect(queue.text).not.toContain('Agent queue');
  });
});
