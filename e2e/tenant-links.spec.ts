import type { BrowserContext } from '@playwright/test';
import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

const resourcePaths = new Set([
  '/api/schema',
  '/api/runtime',
  '/api/app',
  '/api/pages',
  '/api/pages/suggested',
  '/api/pages/plan',
  '/api/references',
  '/api/query',
  '/api/count',
  '/api/run',
  '/api/view/run',
  '/api/breakdown',
]);
function requests(page: Page) {
  const seen = { resources: [] as string[], opens: 0, switches: 0 };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (resourcePaths.has(path)) seen.resources.push(request.url());
    if (path === '/api/tenant/context/open') seen.opens++;
    if (path === '/api/tenant/context/switch') seen.switches++;
  });
  return seen;
}
async function login(page: Page, app: TenantAppFixture) {
  const account = app.accounts.alice;
  const response = await page.request.post(app.origin + '/api/auth/sign-in/email', {
    headers: { origin: app.origin },
    data: { email: account.email, password: account.password },
  });
  expect(response.status()).toBe(200);
}
async function nativeSession(context: BrowserContext, app: TenantAppFixture) {
  const cookies = (await context.cookies(app.origin)).filter((cookie) => cookie.name.includes('session_token'));
  expect(cookies.length).toBeGreaterThan(0);
  // Compare privately; do not put real session tokens into assertion output.
  return JSON.stringify(cookies.map((cookie) => [cookie.name, cookie.value]).sort());
}
const selector = (tenant: string) => `?${new URLSearchParams({ tenant })}`;
const home = (app: TenantAppFixture, tenant: string) => `${app.origin}/${app.appId}${selector(tenant)}`;
const list = (app: TenantAppFixture, tenant: string) => `${app.origin}/${app.appId}/item${selector(tenant)}`;
const record = (app: TenantAppFixture, tenant: string) => `${app.origin}/${app.appId}/item/~${tenant}-1${selector(tenant)}`;

async function chooser(page: Page) {
  await expect(page.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available tenants' }).getByRole('button')).toHaveText(['north', 'south']);
  await expect(page.locator('body')).not.toContainText('North item');
  await expect(page.locator('body')).not.toContainText('South item');
  await expect(page.locator('.tenant-control-trigger')).toHaveCount(0);
}
async function choose(page: Page, tenant: string, switching = false): Promise<TenantContextReply> {
  const path = `/api/tenant/context/${switching ? 'switch' : 'open'}`;
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: tenant, exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const owner = (await response.json()) as TenantContextReply;
  expect(owner.tenantId).toBe(tenant);
  expect(response.headers()[names.context]).toBe(owner.context);
  await expect(page.getByRole('button', { name: `Tenant: ${tenant}`, exact: true })).toBeVisible();
  return owner;
}
async function unchangedAccount(page: Page, app: TenantAppFixture) {
  const response = await page.request.get(`${app.origin}/api/whoami?${new URLSearchParams({ app: app.appId })}`);
  expect(response.status()).toBe(200);
  const identity = await response.json();
  expect(identity.signedIn).toBe(true);
  expect(identity.accountId).toBe(app.accounts.alice.id);
}
async function data(page: Page, app: TenantAppFixture, owner: TenantContextReply, claimedApp = app.appId) {
  return page.request.post(`${app.origin}/api/query?${new URLSearchParams({ app: claimedApp, tenant: owner.tenantId })}`, {
    headers: {
      origin: app.origin,
      [names.app]: claimedApp,
      [names.account]: owner.accountId,
      [names.tab]: owner.tabId,
      [names.context]: owner.context,
      [names.revision]: String(owner.revision),
    },
    data: { table: 'item' },
  });
}

test.describe('private tenant browser links', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    app = await startTenantApp();
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    await login(page, app);
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const hint of [undefined, 'unavailable']) {
    test(`cold link with ${hint === undefined ? 'no' : 'an unavailable'} tenant hint has no data authority before choice`, async ({
      page,
      context,
    }) => {
      const before = await nativeSession(context, app),
        seen = requests(page);
      const path = hint === undefined ? `${app.origin}/${app.appId}/item` : `${app.origin}/${app.appId}/item/~north-1${selector(hint)}`;
      await page.goto(path);
      await chooser(page);
      expect(seen.resources).toEqual([]);
      expect(seen.opens).toBe(0);
      await unchangedAccount(page, app);
      expect((await nativeSession(context, app)) === before).toBe(true);
      await choose(page, 'south');
      if (hint === undefined) {
        await expect(page.getByRole('row').filter({ hasText: 'South item' })).toBeVisible();
        // The App's list for items, as it opens: its key, and the tenant's selector.
        await expect(page).toHaveURL(`${app.origin}/${app.appId}/items${selector('south')}`);
      } else await expect(page).toHaveURL(home(app, 'south'));
      await expect(page.getByRole('heading', { name: 'North item', exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('North item');
      const current = new URL(page.url());
      expect(current.searchParams.getAll('tenant')).toEqual(['south']);
    });
  }

  test('a real record walk produces a tenant-qualified copyable URL; a same-account second tab still chooses explicitly', async ({
    page,
    context,
  }) => {
    await page.goto(list(app, 'north'));
    await chooser(page);
    const first = await choose(page, 'north');
    await expect(page.locator('#content')).toContainText('North item');
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname.endsWith('/north-1')).toBe(true);
    // Copy the browser address, not a hand-constructed replacement for the
    // producer under test. No server session/context token belongs in it.
    const copied = page.url(),
      parsed = new URL(copied);
    expect(parsed.searchParams.getAll('tenant')).toEqual(['north']);
    expect([...parsed.searchParams.keys()]).toEqual(['tenant']);
    expect(copied.includes(first.context)).toBe(false);
    expect(copied.includes(first.tabId)).toBe(false);
    const other = await context.newPage(),
      crashes: string[] = [];
    other.on('pageerror', (error) => crashes.push(String(error)));
    try {
      await other.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
      const seen = requests(other),
        session = await nativeSession(context, app);
      await other.goto(copied);
      await chooser(other);
      expect(seen.resources).toEqual([]);
      expect(seen.opens).toBe(0);
      await unchangedAccount(other, app);
      expect((await nativeSession(context, app)) === session).toBe(true);
      const second = await choose(other, 'north');
      expect(second.accountId).toBe(first.accountId);
      expect(second.tabId).not.toBe(first.tabId);
      expect(second.context).not.toBe(first.context);
      await expect(other.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
      await expect(other).toHaveURL(copied);
      await expect(other.locator('#content')).toContainText('shared-1');
      await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
      expect((await data(page, app, first)).status()).toBe(200);
      expect(crashes).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('native sign-in retains a cold record hint but still requires explicit tenant selection', async ({ page, context }) => {
    await context.clearCookies();
    const target = record(app, 'north'),
      seen = requests(page);
    await page.goto(target);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(seen.resources).toEqual([]);
    expect(seen.opens).toBe(0);
    await page.getByLabel('Email', { exact: true }).fill(app.accounts.alice.email);
    await page.getByLabel('Password', { exact: true }).fill(app.accounts.alice.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await chooser(page);
    await expect(page).toHaveURL(target);
    expect(seen.resources).toEqual([]);
    expect(seen.opens).toBe(0);
    await choose(page, 'north');
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('tenant')).toBe('north');
  });

  test('choosing a different tenant from a cold hinted record discards the old record path', async ({ page }) => {
    const seen = requests(page);
    await page.goto(record(app, 'north'));
    await chooser(page);
    await expect(page.locator('.tenant-chooser')).toContainText('This link belongs to north.');
    expect(seen.resources).toEqual([]);
    const south = await choose(page, 'south');
    await expect(page).toHaveURL(home(app, 'south'));
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('North item');
    const response = await data(page, app, south);
    expect(response.status()).toBe(200);
    expect((await response.json()).rows.map((row: { id: string }) => row.id).sort()).toEqual(['south-1', 'south-2']);
  });

  test('same-tenant Back and Forward restore the walk without replacing its selected context', async ({ page }) => {
    await page.goto(list(app, 'north'));
    const owner = await choose(page, 'north');
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    const northList = page.url(),
      seen = requests(page);
    await page.evaluate(() => {
      Object.assign(window, { sameTenantDocument: 'retained' });
    });
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    const northRecord = page.url();
    await page.goBack();
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    await expect(page).toHaveURL(northList);
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    await expect(page).toHaveURL(northRecord);
    expect(seen.opens).toBe(0);
    expect(seen.switches).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'sameTenantDocument'))).toBe('retained');
    expect((await data(page, app, owner)).status()).toBe(200);
  });

  test('a maximum-length untrusted tenant hint stays readable on a phone without granting membership', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const hint = 'unavailable'.repeat(93) + 'x',
      seen = requests(page);
    await page.goto(`${app.origin}/${app.appId}/item${selector(hint)}`);
    await chooser(page);
    await expect(page.locator('.tenant-chooser-note bdi')).toHaveText(hint);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    expect(seen.resources).toEqual([]);
    expect(seen.opens).toBe(0);
    await page.screenshot({ path: '/tmp/tablewalk-tenant-link-hint-390.png', fullPage: true });
  });

  test('header switch replaces the old record with the new tenant-qualified home in the same document', async ({ page, context }) => {
    await page.goto(record(app, 'north'));
    await choose(page, 'north');
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    const session = await nativeSession(context, app);
    await page.evaluate(() => {
      Object.assign(window, { tenantLinksDocument: 'same-document' });
    });
    await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
    await choose(page, 'south', true);
    await expect(page).toHaveURL(home(app, 'south'));
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('North item');
    expect(await page.evaluate(() => Reflect.get(window, 'tenantLinksDocument'))).toBe('same-document');
    expect((await nativeSession(context, app)) === session).toBe(true);
  });

  test('cross-tenant Back and Forward reload into explicit choosers without changing the native account session', async ({
    page,
    context,
  }) => {
    const seen = requests(page),
      session = await nativeSession(context, app);
    await page.goto(list(app, 'north'));
    const original = await choose(page, 'north');
    await expect(page.locator('#content')).toContainText('North item');
    const northList = page.url();
    // A real row click leaves the north list behind in browser history. The
    // header switch replaces only the record entry with south's home.
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
    const south = await choose(page, 'south', true);
    await expect(page).toHaveURL(home(app, 'south'));
    await page.evaluate(() => {
      Object.assign(window, { tenantHistoryDocument: 'south-document' });
    });
    let reads = seen.resources.length,
      opens = seen.opens;
    await page.goBack();
    await chooser(page);
    await expect(page).toHaveURL(northList);
    expect(await page.evaluate(() => Reflect.get(window, 'tenantHistoryDocument'))).toBeUndefined();
    expect(seen.resources.length).toBe(reads);
    expect(seen.opens).toBe(opens);
    await unchangedAccount(page, app);
    expect((await nativeSession(context, app)) === session).toBe(true);
    const fresh = await choose(page, 'north');
    expect(fresh.context).not.toBe(original.context);
    await expect(page.locator('#content')).toContainText('North item');
    await page.evaluate(() => {
      Object.assign(window, { tenantHistoryDocument: 'new-north-document' });
    });
    reads = seen.resources.length;
    opens = seen.opens;
    await page.goForward();
    await chooser(page);
    await expect(page).toHaveURL(home(app, 'south'));
    expect(await page.evaluate(() => Reflect.get(window, 'tenantHistoryDocument'))).toBeUndefined();
    expect(seen.resources.length).toBe(reads);
    expect(seen.opens).toBe(opens);
    await unchangedAccount(page, app);
    expect((await nativeSession(context, app)) === session).toBe(true);
    const freshSouth = await choose(page, 'south');
    expect(freshSouth.context).not.toBe(south.context);
    await expect(page).toHaveURL(home(app, 'south'));
  });

  test('tenant switching stays unavailable while real boot App metadata is held, then the confirmed record becomes ready', async ({
    page,
  }) => {
    let held = false,
      delivered = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    /* The App's metadata arrives in the page's boot, the one read the shell asks once its lease is open
       (mistri shared/tenantBoot.ts): holding it holds the App. */
    await page.route('**/api/boot?*', async (route) => {
      const target = new URL(route.request().url());
      if (target.pathname !== '/api/boot' || target.searchParams.get('tenant') !== 'north') {
        await route.continue();
        return;
      }
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers()[names.app]).toBe(app.appId);
      expect(response.headers()[names.account]).toBe(app.accounts.alice.id);
      expect(response.headers()[names.tenant]).toBe('north');
      expect(response.headers()[names.context]).toBe(route.request().headers()[names.context]);
      held = true;
      await gate;
      await route.fulfill({ response });
      delivered = true;
    });
    try {
      await page.goto(record(app, 'north'));
      await chooser(page);
      const opening = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/open');
      // Do not use choose(): waiting for a switch control here would deadlock
      // the very readiness boundary whose absence the test needs to observe.
      await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'north', exact: true }).click();
      const opened = await opening;
      expect(opened.status()).toBe(200);
      const owner = (await opened.json()) as TenantContextReply;
      expect(owner.tenantId).toBe('north');
      expect(opened.headers()[names.context]).toBe(owner.context);
      await expect.poll(() => held).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(delivered).toBe(false);
      // First Paint keeps the whole selected workspace veiled until its
      // metadata and room are ready; the intermediate opening status stays hidden.
      await expect(page.locator('html')).toHaveAttribute('data-starting', '');
      await expect(page.locator('#startup-status')).toBeVisible();
      await expect(page.locator('.workspace-opening')).toBeHidden();
      await expect(page.locator('.tenant-control-trigger')).toHaveCount(0);
      await expect(page.locator('#session-lock')).not.toBeVisible();
      release();
      await expect.poll(() => delivered).toBe(true);
      await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
      await expect(page.locator('.workspace-opening')).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveAttribute('data-starting');
      await expect(page.locator('#startup-status')).toBeHidden();
      expect(new URL(page.url()).searchParams.getAll('tenant')).toEqual(['north']);
      expect((await data(page, app, owner)).status()).toBe(200);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('real Back during the cold chooser reloads a fresh chooser before any context or data is acquired', async ({ page, context }) => {
    const seen = requests(page),
      session = await nativeSession(context, app);
    await page.goto(list(app, 'north'));
    await chooser(page);
    const northTarget = page.url();
    // Seed another same-document history entry without dispatching an event.
    // Only native Back below triggers navigation; no synthetic popstate or
    // structural context is substituted for the cold-boot listener.
    await page.evaluate(
      (target) => {
        Object.assign(window, { coldChooserDocument: 'must-retire' });
        window.history.pushState(null, '', target);
      },
      record(app, 'south'),
    );
    await Promise.all([page.waitForEvent('load'), page.goBack()]);
    await chooser(page);
    await expect(page).toHaveURL(northTarget);
    expect(await page.evaluate(() => Reflect.get(window, 'coldChooserDocument'))).toBeUndefined();
    await expect(page.locator('.tenant-chooser')).toContainText('This link belongs to north.');
    expect(seen.resources).toEqual([]);
    expect(seen.opens).toBe(0);
    expect(seen.switches).toBe(0);
    await unchangedAccount(page, app);
    expect((await nativeSession(context, app)) === session).toBe(true);
    await choose(page, 'north');
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    expect(seen.opens).toBe(1);
  });

  test('Back after a committed south switch loses its acknowledgement enters fresh north discovery, not switch recovery', async ({
    page,
    context,
  }) => {
    const session = await nativeSession(context, app);
    await page.goto(list(app, 'north'));
    const north = await choose(page, 'north');
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    const northList = page.url();
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    const seen = requests(page);
    let recoveries = 0,
      lost = false,
      committed: TenantContextReply | undefined;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/tenant/context/recover') recoveries++;
    });
    await page.route('**/api/tenant/context/switch?*', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        tabId: north.tabId,
        expectedContext: north.context,
        expectedRevision: north.revision,
      });
      expect(new URL(route.request().url()).searchParams.get('tenant')).toBe('south');
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      committed = (await response.json()) as TenantContextReply;
      expect(committed.tenantId).toBe('south');
      expect(committed.tabId).toBe(north.tabId);
      expect(committed.context).not.toBe(north.context);
      expect(response.headers()[names.context]).toBe(committed.context);
      await route.abort('failed');
      lost = true;
    });
    try {
      await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
      await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'south', exact: true }).click();
      await expect.poll(() => lost).toBe(true);
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toContainText('The tenant switch was not confirmed.');
      await expect(page.getByRole('list', { name: 'Available tenants' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('North item');
      expect((await data(page, app, committed!)).status()).toBe(200);
      expect((await data(page, app, north)).status()).toBe(403);
      const reads = seen.resources.length;
      await page.evaluate(() => {
        Object.assign(window, { lostSwitchDocument: 'must-retire' });
      });
      await Promise.all([page.waitForEvent('load'), page.goBack()]);
      await chooser(page);
      await expect(page).toHaveURL(northList);
      expect(await page.evaluate(() => Reflect.get(window, 'lostSwitchDocument'))).toBeUndefined();
      await expect(page.locator('.tenant-chooser')).toContainText('This link belongs to north.');
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
      expect(seen.resources.length).toBe(reads);
      expect(seen.opens).toBe(0);
      expect(seen.switches).toBe(1);
      expect(recoveries).toBe(0);
      await unchangedAccount(page, app);
      expect((await nativeSession(context, app)) === session).toBe(true);
      const fresh = await choose(page, 'north');
      expect(fresh.tabId).not.toBe(north.tabId);
      expect(fresh.context).not.toBe(north.context);
      await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
      await expect(page).toHaveURL(northList);
      expect(seen.opens).toBe(1);
      expect(seen.switches).toBe(1);
      expect(recoveries).toBe(0);
      await expect(page.locator('body')).not.toContainText('South item');
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  for (const malformed of ['?tenant=', '?tenant=north&tenant=south', '?tenant=north&tenant=north', '?tenant=%ZZ']) {
    test(`malformed selector ${malformed} refuses instead of loading data or choosing a tenant`, async ({ page }) => {
      const seen = requests(page);
      const response = await page.goto(`${app.origin}/${app.appId}/item/~north-1${malformed}`);
      if (response && response.status() >= 400) expect([400, 403, 404]).toContain(response.status());
      else await expect(page.locator('#startup-status[data-failed="true"], #session-lock')).toBeVisible();
      expect(seen.resources).toEqual([]);
      expect(seen.opens).toBe(0);
      expect(seen.switches).toBe(0);
      await expect(page.locator('body')).not.toContainText('North item');
      await expect(page.locator('body')).not.toContainText('South item');
      await expect(page.locator('.tenant-control-trigger')).toHaveCount(0);
      await unchangedAccount(page, app);
    });
  }

  test('invalid or foreign-App in-place targets restore the current qualified URL without new resource reads', async ({ page }) => {
    await page.goto(record(app, 'north'));
    const owner = await choose(page, 'north');
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
    const current = page.url(),
      seen = requests(page);
    await page.evaluate(() => {
      Object.assign(window, { tenantRejectedLinkDocument: 'unchanged' });
    });
    for (const target of [`/${app.appId}/item?tenant=north&tenant=south`, '/foreign-workspace/item?tenant=north']) {
      const before = seen.resources.length;
      await follow(page, target);
      await expect(page).toHaveURL(current);
      await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
      expect(seen.resources.length).toBe(before);
      expect(seen.opens).toBe(0);
      expect(seen.switches).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'tenantRejectedLinkDocument'))).toBe('unchanged');
      await expect(page.locator('#session-lock')).not.toBeVisible();
    }
    expect((await data(page, app, owner)).status()).toBe(200);
  });

  test('a foreign App path and foreign App/context HTTP claims cannot borrow another genuine host', async ({ page, browser }) => {
    const otherApp = await startTenantApp({ appId: 'tenant-other-workspace' });
    const otherContext = await browser.newContext(),
      other = await otherContext.newPage();
    const crashes: string[] = [];
    other.on('pageerror', (error) => crashes.push(String(error)));
    try {
      await other.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
      await login(other, otherApp);
      await page.goto(list(app, 'north'));
      const first = await choose(page, 'north');
      await other.goto(list(otherApp, 'south'));
      const second = await choose(other, 'south');
      expect(first.accountId).toBe(app.accounts.alice.id);
      expect(second.accountId).toBe(otherApp.accounts.alice.id);
      // Separate native stores have separately issued accounts. Do not make
      // matching account labels or coincidental identifier equality authority.
      for (const response of [
        await data(page, app, first, otherApp.appId),
        await data(other, otherApp, { ...first, appId: otherApp.appId, accountId: second.accountId }),
        await data(page, app, { ...second, appId: app.appId, accountId: first.accountId }),
      ]) {
        expect([400, 403, 404, 409]).toContain(response.status());
        expect(await response.text()).not.toMatch(/North item|South item|physical_item/);
      }
      expect((await data(page, app, first)).status()).toBe(200);
      expect((await data(other, otherApp, second)).status()).toBe(200);
      const seen = requests(other);
      const response = await other.goto(`${otherApp.origin}/${app.appId}/item/~north-1?tenant=north`);
      if (response && response.status() >= 400) expect([400, 403, 404]).toContain(response.status());
      else await expect(other.locator('#startup-status[data-failed="true"], #session-lock')).toBeVisible();
      expect(seen.resources).toEqual([]);
      expect(seen.opens).toBe(0);
      await expect(other.locator('body')).not.toContainText('North item');
      await expect(other.locator('body')).not.toContainText('South item');
      await unchangedAccount(other, otherApp);
      expect(crashes).toEqual([]);
    } finally {
      try {
        await otherContext.close();
      } finally {
        await otherApp.stop();
      }
    }
  });
});
