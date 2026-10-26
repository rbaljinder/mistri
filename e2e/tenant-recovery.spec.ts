import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

test.describe('private tenant browser acknowledgement and response ownership', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    app = await startTenantApp();
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    const account = app.accounts.alice;
    const login = await page.request.post(app.origin + '/api/auth/sign-in/email', {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.status()).toBe(200);
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  const selectNorth = async (page: Page): Promise<TenantContextReply> => {
    await page.goto(`${app.origin}/${app.appId}/item`);
    await expect(page.getByRole('heading', { name: 'Choose a tenant' })).toBeVisible();
    const opened = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/open');
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'north', exact: true }).click();
    const response = await opened;
    expect(response.status()).toBe(200);
    const owner = (await response.json()) as TenantContextReply;
    expect(owner.tenantId).toBe('north');
    expect(response.headers()[names.context]).toBe(owner.context);
    return owner;
  };
  const read = (page: Page, owner: TenantContextReply) =>
    page.request.post(`${app.origin}/api/query?${new URLSearchParams({ app: app.appId, tenant: owner.tenantId })}`, {
      headers: {
        origin: app.origin,
        [names.app]: owner.appId,
        [names.account]: owner.accountId,
        [names.tab]: owner.tabId,
        [names.context]: owner.context,
        [names.revision]: String(owner.revision),
      },
      data: { table: 'item' },
    });
  const frames = (page: Page) =>
    page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  test('lost committed switch acknowledgement removes old data; Check again recovers south without replaying the switch', async ({
    page,
  }) => {
    const counts = { open: 0, switch: 0, recover: 0 };
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      for (const operation of ['open', 'switch', 'recover'] as const) {
        if (path === `/api/tenant/context/${operation}`) counts[operation]++;
      }
    });
    const north = await selectNorth(page);
    await expect(page.locator('#content')).toContainText('North item');
    await page.evaluate(() => {
      Object.assign(window, { tenantRecoveryDocument: 'original-document' });
    });
    let committed: TenantContextReply | undefined;
    let acknowledgementLost = false;
    await page.route('**/api/tenant/context/switch?*', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        tabId: north.tabId,
        expectedContext: north.context,
        expectedRevision: north.revision,
      });
      expect(new URL(route.request().url()).searchParams.get('tenant')).toBe('south');
      // The real host completes CAS first. Only delivery to the browser fails;
      // this is not a fake success or an aborted-before-admission request.
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      committed = (await response.json()) as TenantContextReply;
      expect(committed.tenantId).toBe('south');
      expect(committed.tabId).toBe(north.tabId);
      expect(committed.context).not.toBe(north.context);
      expect(response.headers()[names.context]).toBe(committed.context);
      await route.abort('failed');
      acknowledgementLost = true;
    });
    await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'south', exact: true }).click();
    await expect.poll(() => acknowledgementLost).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toContainText('The tenant switch was not confirmed.');
    await expect(page.locator('#content')).not.toContainText('North item');
    await expect(page.locator('#content')).not.toContainText('north-1');
    await expect(page.locator('#content')).not.toContainText('South item');
    await expect(page.getByRole('list', { name: 'Available tenants' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toHaveCount(0);
    expect(counts).toEqual({ open: 1, switch: 1, recover: 0 });

    const south = committed!;
    const current = await read(page, south);
    expect(current.status()).toBe(200);
    expect((await current.json()).rows.map((row: { id: string }) => row.id).sort()).toEqual(['south-1', 'south-2']);
    expect((await read(page, north)).status()).toBe(403);

    const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/recover');
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    const response = await recovered;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ tabId: north.tabId });
    const restored = (await response.json()) as TenantContextReply;
    expect(restored.context).toBe(south.context);
    expect(restored.tabId).toBe(south.tabId);
    expect(restored.tenantId).toBe('south');
    expect(response.headers()[names.context]).toBe(south.context);
    await expect(page.getByRole('button', { name: 'Tenant: south', exact: true })).toBeVisible();
    await expect(page.locator('#topnav')).toBeVisible();
    await follow(page, `/${app.appId}/item?tenant=south`);
    await expect(page.locator('#content')).toContainText('South item');
    await expect(page.locator('#content')).not.toContainText('North item');
    await expect(page.locator('#content')).not.toContainText('north-1');
    await frames(page);
    expect(counts).toEqual({ open: 1, switch: 1, recover: 1 });
    expect(await page.evaluate(() => Reflect.get(window, 'tenantRecoveryDocument'))).toBe('original-document');
    await expect(page.locator('#session-lock')).not.toBeVisible();
  });

  for (const field of ['tenant', 'context'] as const) {
    test(`HTTP 200 selected read with a mismatched ${field} ownership header locks before painting its rows`, async ({ page }) => {
      let modified = 0;
      // Intercept the first list load, avoiding both cached rows and unrelated
      // filter-control semantics. Every matching result is altered so a sibling
      // retry cannot accidentally supply a valid copy of these rows.
      await page.route('**/api/run?*', async (route) => {
        const target = new URL(route.request().url());
        if (target.searchParams.get('tenant') !== 'north') {
          await route.continue();
          return;
        }
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.status()).toBe(200);
        const original = response.headers();
        expect(original[names.tenant]).toBe('north');
        expect(original[names.context]).toBe(route.request().headers()[names.context]);
        expect(original[names.app]).toBe(app.appId);
        expect(original[names.account]).toBe(app.accounts.alice.id);
        const body = await response.text();
        expect(body).toContain('North item');
        const wrong = field === 'tenant' ? 'south' : `stale-${original[names.context]}`;
        await route.fulfill({ response, headers: { ...original, [names[field]]: wrong } });
        modified++;
      });
      const north = await selectNorth(page);
      await expect.poll(() => modified).toBeGreaterThan(0);
      await expect(page.locator('#session-lock')).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/session-locked/);
      await frames(page);
      await expect(page.locator('#content')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('North item');
      await expect(page.locator('body')).not.toContainText('north-1');
      await expect(page.locator('body')).not.toContainText('South item');
      // Membership and the server context remain valid: this lock is caused
      // by response ownership validation, not expiry, logout or a server 403.
      const valid = await read(page, north);
      expect(valid.status()).toBe(200);
      expect(valid.headers()[names.context]).toBe(north.context);
      expect((await valid.json()).rows).toHaveLength(2);
      await expect(page.locator('#session-lock')).toBeVisible();
    });
  }
});
