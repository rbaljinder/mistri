import type { APIResponse, Response } from '@playwright/test';
import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { startTenantApp, type TenantAccount, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

// These tests start only their own private browser host. They do not enroll a
// CLI server, touch the shared e2e/.tmp database, or substitute session proofs.
test.describe('private tenant browser ownership', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    app = await startTenantApp();
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  const url = (path: string, tenant?: string) =>
    `${app.origin}${path}?${new URLSearchParams({ app: app.appId, ...(tenant ? { tenant } : {}) })}`;
  const headers = (owner: TenantContextReply) => ({
    origin: app.origin,
    [names.app]: owner.appId,
    [names.account]: owner.accountId,
    [names.tab]: owner.tabId,
    [names.context]: owner.context,
    [names.revision]: String(owner.revision),
  });
  const login = async (page: Page, account = app.accounts.alice) => {
    const response = await page.request.post(app.origin + '/api/auth/sign-in/email', {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(response.status()).toBe(200);
  };
  const data = (page: Page, owner: TenantContextReply, body: Record<string, unknown> = { table: 'item' }, tenant = owner.tenantId) =>
    page.request.post(url('/api/query', tenant), { headers: headers(owner), data: body });
  const denied = async (response: APIResponse) => {
    expect([400, 401, 403, 404, 409]).toContain(response.status());
    expect(await response.text()).not.toMatch(/North item|South item|physical_item|tenant-browser-business/);
  };
  const owned = (response: Response | APIResponse, owner: TenantContextReply) => {
    const actual = response.headers();
    for (const [field, name] of Object.entries(names)) {
      const key = (
        {
          app: 'appId',
          account: 'accountId',
          tenant: 'tenantId',
          tab: 'tabId',
          context: 'context',
          revision: 'revision',
          realm: 'realm',
        } as const
      )[field as keyof typeof names];
      // A tenant's lease carries no realm, so its replies carry no realm header.
      expect(actual[name], name).toBe(owner[key] === undefined ? undefined : String(owner[key]));
    }
  };
  /* `entered`: a sole membership's selection, made as the page loaded, in place of a click on the chooser. */
  const choose = async (page: Page, tenant: string, switching = false, entered?: Promise<Response>): Promise<TenantContextReply> => {
    const path = `/api/tenant/context/${switching ? 'switch' : 'open'}`;
    const reply =
      entered ?? page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    if (!entered) await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: tenant, exact: true }).click();
    const response = await reply;
    expect(response.status()).toBe(200);
    const owner = (await response.json()) as TenantContextReply;
    expect(owner.tenantId).toBe(tenant);
    owned(response, owner);
    await expect(page.getByRole('button', { name: `Tenant: ${tenant}`, exact: true })).toBeVisible();
    return owner;
  };
  const items = async (page: Page, tenant: 'north' | 'south') => {
    // Switching intentionally returns to the App home. Revisit the same list
    // in this document to exercise its old query/cache key, not a fresh reload.
    await expect(page.locator('#topnav')).toBeVisible();
    await follow(page, `/${app.appId}/item?tenant=${tenant}`);
    await expect(page.locator('#content')).toContainText(tenant === 'north' ? 'North item' : 'South item');
    await expect(page.locator('#content')).not.toContainText(tenant === 'north' ? 'South item' : 'North item');
  };
  const enter = async (page: Page, tenant: 'north' | 'south' = 'north', account?: TenantAccount) => {
    await login(page, account);
    // Bob's one membership is entered without the chooser; Alice, a member of two, is asked.
    const sole = account === app.accounts.bob;
    const entered = sole
      ? page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/tenant/context/open' && response.request().method() === 'POST',
        )
      : undefined;
    await page.goto(`${app.origin}/${app.appId}/item`);
    if (!sole) await expect(page.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
    const owner = await choose(page, tenant, false, entered);
    await items(page, tenant);
    return owner;
  };
  const switchTo = async (page: Page, current: string, tenant: 'north' | 'south') => {
    await page.getByRole('button', { name: `Tenant: ${current}`, exact: true }).click();
    const owner = await choose(page, tenant, true);
    await items(page, tenant);
    return owner;
  };

  test('root redirects through native sign-in to explicit discovery, then selected data carries the complete owner', async ({ page }) => {
    const resourceRequests: string[] = [];
    page.on('request', (request) => {
      if (/^\/api\/(schema|app|runtime|query|run|view\/run)$/.test(new URL(request.url()).pathname)) resourceRequests.push(request.url());
    });
    await page.goto(app.origin + '/');
    await expect(page).toHaveURL(`${app.origin}/${app.appId}`);
    await expect(page.getByRole('heading', { name: `Sign in to ${app.appName}` })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(app.accounts.alice.email);
    await page.getByLabel('Password', { exact: true }).fill(app.accounts.alice.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
    await expect(page.locator('.tenant-chooser-app')).toHaveText(app.appName);
    await expect(page.getByRole('list', { name: 'Available tenants' }).getByRole('button')).toHaveText(['north', 'south']);
    expect(resourceRequests).toEqual([]);
    const owner = await choose(page, 'north');
    await items(page, 'north');
    const response = await data(page, owner);
    expect(response.status()).toBe(200);
    owned(response, owner);
    const value = await response.json();
    expect(value.rows.map((row: { id: string }) => row.id).sort()).toEqual(['north-1', 'north-2']);
    expect(value.rows.map((row: { business_id: string }) => row.business_id).sort()).toEqual(['shared-1', 'shared-2']);
    expect(JSON.stringify(value)).not.toMatch(/tenant_id|physical_item|South item/);
  });

  test('a real authenticated account with no memberships gets no implicit tenant grant', async ({ page }) => {
    await login(page, app.accounts.visitor);
    await page.goto(`${app.origin}/${app.appId}/item`);
    await expect(page.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
    await expect(page.locator('#content')).toContainText('No available tenants.');
    await expect(page.getByRole('list', { name: 'Available tenants' }).getByRole('button')).toHaveCount(0);
    const response = await page.request.post(url('/api/tenant/context/open', 'north'), {
      headers: { origin: app.origin, [names.app]: app.appId, [names.account]: app.accounts.visitor.id },
      data: {},
    });
    await denied(response);
    await expect(page.locator('#content')).not.toContainText('North item');
  });

  test('in-place switch invalidates the same list and old context, not just its displayed tenant label', async ({ page }) => {
    const north = await enter(page);
    await page.evaluate(() => {
      Object.assign(window, { tenantDocumentSentinel: 'same-document' });
    });
    const south = await switchTo(page, 'north', 'south');
    expect(south.tabId).toBe(north.tabId);
    expect(south.context).not.toBe(north.context);
    expect(await page.evaluate(() => Reflect.get(window, 'tenantDocumentSentinel'))).toBe('same-document');
    await expect(page.locator('#content')).not.toContainText('north-1');
    const response = await data(page, south);
    owned(response, south);
    expect((await response.json()).rows.map((row: { business_id: string }) => row.business_id).sort()).toEqual(['shared-1', 'shared-2']);
    await denied(await data(page, north));
    await switchTo(page, 'south', 'north');
    await expect(page.locator('#content')).not.toContainText('south-1');
  });

  test('two tabs share a real login but independently select and retain their contexts', async ({ page, context }) => {
    const north = await enter(page);
    const other = await context.newPage();
    const crashes: string[] = [];
    other.on('pageerror', (error) => crashes.push(String(error)));
    try {
      await other.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
      await other.goto(`${app.origin}/${app.appId}/item`);
      await expect(other.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
      const south = await choose(other, 'south');
      await items(other, 'south');
      expect(south.accountId).toBe(north.accountId);
      expect(south.tabId).not.toBe(north.tabId);
      await switchTo(page, 'north', 'south');
      await switchTo(page, 'south', 'north');
      await expect(other.getByRole('button', { name: 'Tenant: south', exact: true })).toBeVisible();
      await expect(other.locator('#content')).toContainText('South item');
      const response = await data(other, south);
      expect(response.status()).toBe(200);
      owned(response, south);
      expect(crashes).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('same-account logout and native relogin cannot revive an old browser context', async ({ page }) => {
    const old = await enter(page);
    expect((await page.request.post(app.origin + '/api/auth/sign-out', { headers: { origin: app.origin }, data: {} })).status()).toBe(200);
    await login(page);
    await denied(await data(page, old));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
    await expect(page.locator('#content')).not.toContainText('North item');
    const current = await choose(page, 'north');
    await items(page, 'north');
    expect(current.accountId).toBe(old.accountId);
    expect(current.context).not.toBe(old.context);
    await denied(await data(page, old));
    expect((await data(page, current)).status()).toBe(200);
  });

  test('focus revalidation locks a retired login instance even when native WHOAMI still names the same account', async ({ page }) => {
    await enter(page);
    expect((await page.request.post(app.origin + '/api/auth/sign-out', { headers: { origin: app.origin }, data: {} })).status()).toBe(200);
    await login(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#session-lock')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/session-locked/);
  });

  test('same-App tenant and record guesses cannot cross the selected owner or membership ceiling', async ({ page }) => {
    const north = await enter(page, 'north', app.accounts.bob);
    await denied(await data(page, north, { table: 'item' }, 'south'));
    const foreign = await data(page, north, { table: 'item', filter: { groups: [[{ column: 'id', op: '=', value: 'south-1' }]] } });
    expect(foreign.status()).toBe(200);
    expect((await foreign.json()).rows).toEqual([]);
    await denied(await data(page, north, { table: 'item', filter: { groups: [[{ column: 'tenant_id', op: '=', value: 'south' }]] } }));
    await denied(
      await page.request.post(url('/api/tenant/context/open', 'south'), {
        headers: { origin: app.origin, [names.app]: app.appId, [names.account]: app.accounts.bob.id },
        data: {},
      }),
    );
    await expect(page.locator('#content')).toContainText('North item');
  });

  test('revocation of a selected real grant refuses the next read and locks its browser surface', async ({ page }) => {
    const north = await enter(page);
    let captured = false,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/run?*', async (route) => {
      const body = route.request().postDataJSON() as { q?: string; limit?: number } | null;
      if (!captured && body?.q?.includes('status = open') && body.limit !== 1) {
        captured = true;
        await held;
      }
      await route.continue();
    });
    try {
      // Initiate the UI read before revocation. Background reads may already
      // lock the surface after revocation, so clicking controls afterwards is
      // an invalid test dependency, not a requirement of the browser contract.
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      const filter = page.getByRole('textbox', { name: 'Filter Items', exact: true });
      await filter.fill('status = open');
      await filter.press('Enter');
      await expect.poll(() => captured).toBe(true);
      await app.revoke(app.accounts.alice.id, 'north');
      await denied(await data(page, north));
      release();
      await expect(page.locator('#session-lock')).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/session-locked/);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('a completed north response released after an in-place switch cannot paint over south', async ({ page }) => {
    const north = await enter(page);
    let captured = false,
      delivered = false,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/run?*', async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      const body = request.postDataJSON() as { q?: string; limit?: number } | null;
      if (captured || target.searchParams.get('tenant') !== 'north' || !body?.q?.includes('status = open') || body.limit === 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      owned(response, north);
      expect(await response.text()).toContain('North item');
      captured = true;
      await held;
      try {
        await route.fulfill({ response });
      } catch (error) {
        // Disposing the old query is also a valid cancellation, but not a
        // reason to swallow an arbitrary interception/fixture failure.
        if (!/closed|cancel|disposed|Invalid InterceptionId/i.test(String(error))) throw error;
      } finally {
        delivered = true;
      }
    });
    try {
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      const filter = page.getByRole('textbox', { name: 'Filter Items', exact: true });
      await filter.fill('status = open');
      await filter.press('Enter');
      await expect.poll(() => captured).toBe(true);
      await switchTo(page, 'north', 'south');
      release();
      await expect.poll(() => delivered).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator('#content')).toContainText('South item');
      await expect(page.locator('#content')).not.toContainText('North item');
      await expect(page.locator('#content')).not.toContainText('north-1');
      await expect(page.getByRole('button', { name: 'Tenant: south', exact: true })).toBeVisible();
      await expect(page.locator('#session-lock')).not.toBeVisible();
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
});
