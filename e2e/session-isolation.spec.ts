import type { FirstPaintData } from '../packages/engine/src/shared/firstPaint.js';
import { expect, test, type Page } from './support/harness';
import { follow } from './support/app';
import { scalar } from './support/db';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

type Fixture = Awaited<ReturnType<typeof startSessionApp>>;
const recordPath = `/@ticket~1`;
const pinsKey = 'mistri.pages.pinned.v1';
const historyKey = 'mistri.history.v1';
const favoritesKey = 'mistri.favorites.v1';
const accountKey = (id: string, key: string) => `mistri.account.v1:${encodeURIComponent(JSON.stringify([SESSION_APP_ID, id]))}:${key}`;

async function login(page: Page, app: Fixture, account = app.accounts[0]) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: account.email, password: account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function revoke(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-out`, { headers: { origin: app.origin }, data: {} });
  expect(response.ok()).toBe(true);
}

async function openRecord(page: Page, app: Fixture) {
  await page.goto(`${app.origin}${recordPath}`);
  await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible();
}

async function expectLocked(page: Page) {
  await expect(page.locator('#session-lock')).toHaveAttribute('role', 'alertdialog');
  await expect(page.locator('#session-lock').getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/session-locked/);
  await expect(page.getByRole('button', { name: 'Records', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toHaveCount(0);
  await expect(page.locator('.palette-host, .page-title')).toHaveCount(0);
}

test.describe('verified sessions own browser state', () => {
  test.setTimeout(45_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startSessionApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('real sign-in ignores legacy state and separates favorites, history and retained drafts between accounts', async ({ page }) => {
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') && !path.startsWith('/api/auth/')) apiRequests.push(path);
    });
    await page.addInitScript(
      ({ appId, pinsKey, historyKey }) => {
        if (localStorage.getItem('session-fixture-legacy-seeded')) return;
        localStorage.setItem('session-fixture-legacy-seeded', '1');
        localStorage.setItem(pinsKey, JSON.stringify({ [appId]: [{ id: 'ticket', name: 'Legacy private pin', base: 'ticket' }] }));
        localStorage.setItem(historyKey, JSON.stringify({ [appId]: [{ q: 'ticket name = "Legacy private history"', at: 1 }] }));
        localStorage.setItem('mistri.tour', 'done');
      },
      { appId: SESSION_APP_ID, pinsKey, historyKey },
    );
    await page.goto(`${app.origin}${recordPath}`);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(apiRequests).toEqual([]); // Identity arrived with the signed-out HTML.
    await page.getByLabel('Email', { exact: true }).fill(app.accounts[0].email);
    await page.getByLabel('Password', { exact: true }).fill(app.accounts[0].password);
    apiRequests.length = 0;
    const signedInDocument = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() && response.request().resourceType() === 'document' && response.status() === 200,
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Session-owned ticket', exact: true })).toBeVisible();
    const html = await (await signedInDocument).text();
    const carried = html.match(/<script[^>]*id="mistri-first-paint"[^>]*>(.*?)<\/script>/s)?.[1];
    expect(carried).toBeDefined();
    const firstPaint = JSON.parse(carried!) as FirstPaintData;
    const verified = Object.entries(firstPaint.reads).find(([key]) => key.startsWith('GET /api/whoami'))?.[1];
    expect(verified?.body).toMatchObject({ signedIn: true, accountId: app.accounts[0].id, appId: SESSION_APP_ID });
    expect(verified?.account).toBe(app.accounts[0].id);
    // In an App the record's star is the reader's own mark, kept per account as pins were.
    const star = page.getByRole('button', { name: /^Add ".+" to Favorites$/ });
    await expect(star).toBeVisible();
    await star.click();
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Alice private retained draft');
    await follow(page, `/ticket`);
    await follow(page, recordPath);
    const retained = page.getByRole('region', { name: 'Retained draft' });
    await expect(retained).toBeVisible();
    await retained.getByText('Proposed changes', { exact: true }).click();
    await expect(retained).toContainText('Alice private retained draft');
    const aliceState = await page.evaluate(
      (prefix) => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix))),
      accountKey(app.accounts[0].id, ''),
    );
    expect(aliceState[accountKey(app.accounts[0].id, favoritesKey)]).toContain('"table":"ticket"');
    expect(JSON.stringify(aliceState)).not.toContain('Legacy private');

    await revoke(page, app);
    await login(page, app, app.accounts[1]);
    await openRecord(page, app);
    await expect(page.getByRole('button', { name: /^Add ".+" to Favorites$/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Retained draft' })).toHaveCount(0);
    await expect(page.getByText('Alice private retained draft', { exact: true })).toHaveCount(0);
    const bobState = await page.evaluate(
      (prefix) =>
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => value)
          .join('\n'),
      accountKey(app.accounts[1].id, ''),
    );
    expect(bobState).not.toContain('Legacy private');
    expect(bobState).not.toContain('Alice private retained draft');
    expect(await page.evaluate((key) => localStorage.getItem(key), accountKey(app.accounts[1].id, favoritesKey))).toBeNull();

    await revoke(page, app);
    await login(page, app);
    await page.goto(`${app.origin}${recordPath}`);
    await expect(page.getByRole('button', { name: /^Remove ".+" from Favorites$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Retained draft' })).toHaveCount(0);
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Session-owned ticket');
  });

  test('an expired write clears the mounted application and is never retried', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app);
    await openRecord(page, app);
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Must not be saved');
    let writes = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/update') writes++;
    });
    await revoke(page, app);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expectLocked(page);
    await expect(page.locator('#session-lock')).toContainText('Session expired');
    expect(writes).toBe(1);
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Session-owned ticket');
    await page.screenshot({ path: info.outputPath('expired-session-lock.png') });
    await page.locator('#session-lock').getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(writes).toBe(1);
  });

  test('a cookie account switch cannot execute an old tab edit under the new account', async ({ page }) => {
    await login(page, app);
    await openRecord(page, app);
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Stale account edit');
    await login(page, app, app.accounts[1]);
    const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/update');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const rejected = await response;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().headers()['x-mistri-account']).toBe(app.accounts[0].id);
    expect(rejected.headers()['x-mistri-account']).toBe(app.accounts[1].id);
    await expectLocked(page);
    await expect(page.locator('#session-lock')).toContainText('Account changed');
    expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Session-owned ticket');
  });

  test('a successful old save response cannot republish UI after session expiry', async ({ page }) => {
    await login(page, app);
    await openRecord(page, app);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = false;
    let delivered = false;
    let writes = 0;
    await page.route('**/api/update', async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.headers()['x-mistri-account']).toBe(app.accounts[0].id);
      captured = true;
      await held;
      try {
        await route.fulfill({ response });
      } finally {
        delivered = true;
      }
    });
    try {
      await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Committed before expiry');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => captured).toBe(true);
      await revoke(page, app);
      await page.getByRole('button', { name: /Search/ }).click();
      await page.getByRole('combobox', { name: 'Search', exact: true }).fill('Another');
      await expectLocked(page);
      release();
      await expect.poll(() => delivered).toBe(true);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expectLocked(page);
      await expect(page.getByRole('region', { name: 'Saved changes', exact: true })).toHaveCount(0);
      await expect(page.getByText('Committed before expiry', { exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(scalar(app.database, 'SELECT name FROM ticket WHERE id=1')).toBe('Committed before expiry');
    } finally {
      release();
    }
  });

  test('signing out in one tab immediately locks another tab and removes its open dialog', async ({ page, context }) => {
    await login(page, app);
    await openRecord(page, app);
    const other = await context.newPage();
    try {
      await openRecord(other, app);
      await other.getByRole('button', { name: /Search/ }).click();
      await expect(other.getByRole('combobox', { name: 'Search', exact: true })).toBeVisible();
      await page.locator('button.account').click();
      await expect(other.getByRole('combobox', { name: 'Search', exact: true })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      await expectLocked(other);
      await expect(other.locator('#session-lock')).toContainText('Account changed');
      await other.locator('#session-lock').getByRole('button', { name: 'Reload', exact: true }).click();
      await expect(other.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    } finally {
      await other.close();
    }
  });
});
