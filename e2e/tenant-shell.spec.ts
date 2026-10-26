import { test, expect, type Page } from './support/harness.js';
import { scalar } from './support/db.js';
import { startTenantApp, type TenantAppFixture, type TenantAccount } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

// The tenant shell's own chrome, through genuine native sign-in: a sole
// membership entered without the chooser, the header's New menu, and the bell
// over the inbox of the tenant the person is working in. Alice is a member of
// north and south; Bob of north alone, and he watches every item.
test.describe('the tenant shell', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  const signIn = async (page: Page, account: TenantAccount) => {
    const reply = await page.request.post(app.origin + '/api/auth/sign-in/email', {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(reply.status()).toBe(200);
  };
  const chooser = (page: Page) => page.getByRole('list', { name: 'Available tenants' });

  test('a sole membership is entered without the chooser, unless the address names another tenant', async ({ page }) => {
    app = await startTenantApp({ writable: true, shell: true });
    await signIn(page, app.accounts.bob);
    /* Not even for a moment: every chooser heading the page ever holds is counted as it is added, from the first byte. */
    await page.addInitScript(() => {
      const seen = { chooser: 0 };
      (window as unknown as { chooserSeen: typeof seen }).chooserSeen = seen;
      new MutationObserver(() => {
        if (document.querySelector('.tenant-chooser')) seen.chooser++;
      }).observe(document, { childList: true, subtree: true });
    });
    const opened = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/tenant/context/open');
    await page.goto(`${app.origin}/${app.appId}/item`);
    expect((await opened).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    await expect(chooser(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { chooserSeen: { chooser: number } }).chooserSeen.chooser)).toBe(0);

    // A tab of its own holds no lease: the address names south, which Bob is not a member of, so he is asked.
    const other = await page.context().newPage();
    await other.goto(`${app.origin}/${app.appId}/item?tenant=south`);
    await expect(chooser(other)).toBeVisible();
    await expect(chooser(other).getByRole('button', { name: 'north', exact: true })).toBeVisible();
    await expect(other.getByRole('button', { name: 'Tenant: north', exact: true })).toHaveCount(0);
    await other.close();
  });

  // A field report: at 320-430px the bar held the menu, brand, search, "+ New", the bell, the account and the tenant's name, and
  // the last of them was pushed past the edge. On a phone the context is the account menu's first item instead.
  test('on a phone the bar fits in every look, search and New stay in it, and the tenant is opened from the account menu', async ({
    page,
  }) => {
    app = await startTenantApp({ writable: true, shell: true });
    await signIn(page, app.accounts.alice);
    const bar = page.locator('header.topbar');
    for (const look of ['lumen', 'mono', 'sage']) {
      /* Each document chooses its tenant afresh; the look is the visitor's own, set before the page reads it. */
      await page.addInitScript((l) => localStorage.setItem('mistri.visual-theme', l), look);
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(`${app.origin}/${app.appId}/items?tenant=north`);
      await chooser(page).getByRole('button', { name: 'north', exact: true }).click();
      await expect(page.getByText('North item', { exact: true }).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', look);
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(bar.getByRole('button', { name: /^Search/ }).filter({ visible: true })).toHaveCount(1);
        await expect(bar.getByRole('button', { name: 'New', exact: true })).toBeVisible();
        await expect(bar.getByRole('button', { name: /^Tenant: / })).toBeHidden();
        const misfits = await bar.evaluate((header) =>
          [...header.querySelectorAll<HTMLElement>('button, a')]
            .filter((control) => control.getClientRects().length)
            .filter((control) => {
              const box = control.getBoundingClientRect();
              return box.left < -0.5 || box.right > innerWidth + 0.5 || control.scrollWidth > control.clientWidth + 1;
            })
            .map((control) => `${control.className || control.tagName} ${control.textContent}`),
        );
        expect(misfits, `${look} at ${width}px`).toEqual([]);
      }
    }
    await bar.getByRole('button', { name: /^Account/ }).click();
    await page.getByRole('menuitem', { name: 'Tenant: north', exact: true }).click();
    await expect(chooser(page).getByRole('button')).toHaveText([/^north/, 'south']);
  });

  test('an address naming the table opens the record and is said under the view that shows it', async ({ page }) => {
    app = await startTenantApp({ writable: true, shell: true });
    await signIn(page, app.accounts.bob);
    // `item` is the table; its records are addressed through the `items` list, by business id.
    await page.goto(`${app.origin}/${app.appId}/item/shared-1`);
    await expect(page).toHaveURL(new RegExp(`/${app.appId}/items/shared-1(\\?|$)`));
    await expect(page.getByText('North item').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('not available to your role');
  });

  test("the New menu makes a record in the tenant, and the bell counts that tenant's notices", async ({ page, browser }) => {
    app = await startTenantApp({ writable: true, shell: true });
    // Alice renames north's item, which tells Bob in north's inbox.
    await signIn(page, app.accounts.alice);
    await page.goto(`${app.origin}/${app.appId}/item?tenant=north`);
    const opened = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/tenant/context/open');
    await chooser(page).getByRole('button', { name: 'north', exact: true }).click();
    const owner = (await (await opened).json()) as TenantContextReply;
    const renamed = await page.request.post(`${app.origin}/api/update?${new URLSearchParams({ app: app.appId, tenant: owner.tenantId })}`, {
      headers: {
        origin: app.origin,
        [headers.app]: owner.appId,
        [headers.account]: owner.accountId,
        [headers.tab]: owner.tabId,
        [headers.context]: owner.context,
        [headers.revision]: String(owner.revision),
      },
      data: { table: 'item', key: { id: 'north-1' }, values: { name: 'North renamed' } },
    });
    expect(renamed.status()).toBe(200);

    const bob = await (await browser.newContext()).newPage();
    await bob.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    await signIn(bob, app.accounts.bob);
    await bob.goto(`${app.origin}/${app.appId}/item`);
    await expect(bob.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();

    const bell = bob.getByRole('button', { name: /^Notifications/ });
    await expect(bell).toHaveAccessibleName('Notifications, 1 unread');
    await bell.click();
    await expect(bob.getByRole('menuitem').filter({ hasText: 'Renamed to North renamed' })).toBeVisible();
    await bob.keyboard.press('Escape');

    // One "+ New" by the bell, its one line the items' New form, opened over the list in this tenant.
    await bob.getByRole('button', { name: 'New', exact: true }).click();
    const lines = bob.getByRole('menuitem');
    await expect(lines).toHaveText(['Item']);
    await lines.first().click();
    const form = bob.locator('.newpanel');
    await expect(form).toBeVisible();
    await expect(bob).toHaveURL(/\/items\/new\?tenant=north$/);
    await form.getByRole('textbox', { name: 'Business ID', exact: true }).fill('north-made');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Made from the New menu');
    const insert = bob.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/insert');
    await form
      .getByRole('button', { name: /^(Save|Create|Add)/ })
      .first()
      .click();
    expect((await insert).status()).toBe(200);
    expect(scalar(app.database, "SELECT tenant_id FROM physical_item WHERE business_id = 'north-made'")).toBe('north');
    await bob.context().close();
  });
});
