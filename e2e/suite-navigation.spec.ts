/** Owned suite entry/navigation acceptance. Requires a current built client.
 * Every test owns its databases and reserved ephemeral port; no preview server.
 * Bare-root defaults must never override an explicit switch to the root App. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect, test as base } from './support/harness';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant';
import type { AppSwitcherConfig } from '../packages/mistri/src/client/components/SuiteAppSwitcher';

const BASE = '/tools',
  PASSWORD = 'suite-navigation-password-long-enough';
const APP_ROWS = { lender: 'Lender fixture note', benefits: 'Benefits fixture note' };
type AppId = keyof typeof APP_ROWS;
interface Account {
  id: string;
  email: string;
}
interface Preference {
  accountId: string;
  defaultApp: string | null;
  revision: number;
}

async function startNavigationSuite(switcher: AppSwitcherConfig) {
  const temporaryRoot = join(tmpdir(), 'opencode');
  mkdirSync(temporaryRoot, { recursive: true });
  const dir = mkdtempSync(join(temporaryRoot, 'tw-suite-navigation-'));
  let running: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const apps = [];
    for (const id of ['lender', 'benefits'] as const) {
      const home = join(dir, id);
      mkdirSync(home);
      const db = new DatabaseSync(join(home, 'business.db'));
      try {
        db.exec(
          'CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE private_note(id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
        );
        db.prepare('INSERT INTO note VALUES (1, ?)').run(APP_ROWS[id]);
        db.prepare('INSERT INTO private_note VALUES (1, ?)').run(`${id} restricted note`);
      } finally {
        db.close();
      }
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id === 'lender' ? 'Lender' : 'Benefits',
          ui: { appSwitcher: switcher },
          resources: { note: {}, private_note: {} },
          auth: { providers: ['email'], roles: { reader: { read: ['note'] } } },
          views: { notes: { kind: 'list', from: 'note', show: ['body'] } },
          home: 'notes',
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db') }] }));
      apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: id === 'lender' ? '/' : '/benefits' });
    }
    const file = join(dir, 'suite.json');
    const environment = { SECRET: 'owned-navigation-suite-secret-longer-than-thirty-two-characters' };
    writeFileSync(
      file,
      JSON.stringify({
        port,
        basePath: BASE,
        apps,
        identity: {
          id: 'shared',
          name: 'Navigation Suite',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
      }),
    );
    running = await startConfiguredSuite(file, environment);
    const origin = running.publicURL;
    return {
      origin,
      chooser: `${origin}${BASE}/_mistri/apps`,
      appURL: (id: AppId) => `${origin}${BASE}${id === 'lender' ? '' : '/benefits'}/notes`,
      grant: (id: AppId, subjectId: string, roles = ['reader'], expectedRevision = 0) =>
        changeSuiteGrant(file, { appId: id, subjectId, roles, expectedRevision }, environment),
      async account(request: APIRequestContext, email = 'reader@example.test'): Promise<Account> {
        const response = await request.post(`${origin}${BASE}/api/auth/sign-up/email`, {
          headers: { origin },
          data: { name: 'Suite Reader', email, password: PASSWORD },
        });
        expect(response.status()).toBe(200);
        return { id: (await response.json()).user.id, email };
      },
      async preference(request: APIRequestContext, accountId: string): Promise<Preference> {
        const response = await request.get(`${origin}${BASE}/api/suite/preferences`, { headers: { 'x-mistri-account': accountId } });
        expect(response.status()).toBe(200);
        return response.json();
      },
      async setDefault(request: APIRequestContext, accountId: string, defaultApp: string | null) {
        const current = await this.preference(request, accountId);
        const response = await request.post(`${origin}${BASE}/api/suite/preferences`, {
          headers: { origin, 'x-mistri-account': accountId },
          data: { defaultApp, expectedRevision: current.revision },
        });
        expect(response.status()).toBe(200);
        return (await response.json()) as Preference;
      },
      async restart() {
        await running!.close();
        running = undefined;
        running = await startConfiguredSuite(file, environment);
      },
      async close() {
        try {
          await running?.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await running?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
type Suite = Awaited<ReturnType<typeof startNavigationSuite>>;
const test = base.extend<{ suite: Suite; switcher: AppSwitcherConfig }>({
  switcher: [{ placement: 'navbar', apps: 'authorized' }, { option: true }],
  suite: async ({ switcher }, use) => {
    const suite = await startNavigationSuite(switcher);
    try {
      await use(suite);
    } finally {
      await suite.close();
    }
  },
});
test.use({ storageState: { cookies: [], origins: [] }, carryFirstPaint: false, viewport: { width: 390, height: 844 } });
test.setTimeout(90_000);
test.beforeEach(async ({ page }) => {
  await prepare(page);
});

async function prepare(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('mistri.tour.v1', 'done');
  });
}
async function signIn(page: Page, suite: Suite, account: Account) {
  await page.goto(suite.chooser);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#account')).toHaveText(account.id);
}
async function expectHome(page: Page, id: AppId) {
  await expect(page.locator('#content').getByText(APP_ROWS[id], { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
}
async function phoneFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const popup of await page.locator('[role="menu"]:visible, [role="dialog"]:visible, [role="listbox"]:visible').all()) {
    const box = await popup.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  }
}
async function openPreferences(page: Page) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: /^Preferences/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Preferences', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function nativeSession(request: APIRequestContext, suite: Suite) {
  // The suite deliberately does not expose Better Auth's get-session route.
  // Its unchanged native session token, together with both Apps' whoami, proves session continuity.
  const cookies = (await request.storageState()).cookies.filter(
    (cookie) => cookie.name === 'mistri-shared.session_token' && cookie.domain === new URL(suite.origin).hostname,
  );
  expect(cookies).toHaveLength(1);
  return { name: cookies[0].name, value: cookies[0].value, path: cookies[0].path };
}
async function whoami(request: APIRequestContext, suite: Suite, id: AppId, accountId: string) {
  const response = await request.get(`${suite.origin}${BASE}${id === 'lender' ? '' : '/benefits'}/api/whoami?app=${id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ signedIn: true, accountId, appId: id, suite: { basePath: BASE } });
}
async function multiAccount(page: Page, suite: Suite) {
  const account = await suite.account(page.request);
  await suite.grant('lender', account.id);
  await suite.grant('benefits', account.id);
  return account;
}

test('bare root signs in at the suite; a child-only account lands in its one App, never at a Lender denial', async ({ page, suite }) => {
  const account = await suite.account(page.request);
  await suite.grant('benefits', account.id);
  expect(
    (
      await page.request.post(`${suite.origin}${BASE}/api/auth/sign-out`, {
        headers: { origin: suite.origin, 'x-mistri-account': account.id },
        data: {},
      })
    ).status(),
  ).toBe(200);
  await page.goto(`${suite.origin}${BASE}/`);
  await expect(page).toHaveURL(`${suite.chooser}?entry=1`);
  await expect(page.getByRole('heading', { name: 'Navigation Suite', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const signedOut = await page.request.get(`${suite.origin}${BASE}/benefits/api/whoami?app=benefits`);
  expect(signedOut.status()).toBe(200);
  expect(await signedOut.json()).toMatchObject({ signedIn: false, signIn: { suite: { basePath: BASE } } });
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The only App the account has is where the suite's address takes it.
  await expectHome(page, 'benefits');
  await expect(page).toHaveURL(`${suite.origin}${BASE}/benefits/`);
  await page.goto(suite.chooser);
  await expect(page.getByRole('link', { name: 'Benefits', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lender', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeHidden();
  await expect(page.getByText(/access denied|not authorized|sign in to Lender/i)).toHaveCount(0);
  await phoneFits(page);
  await page.getByRole('link', { name: 'Benefits', exact: true }).click();
  await expectHome(page, 'benefits');
  await whoami(page.request, suite, 'benefits', account.id);
  await expect(page.getByRole('button', { name: 'Switch App', exact: true })).toHaveCount(0);
});

test('390px keyboard switcher uses document navigation and native new-tab anchors with the same session', async ({
  page,
  context,
  suite,
}) => {
  const account = await multiAccount(page, suite),
    session = await nativeSession(page.request, suite);
  const before = await suite.preference(page.request, account.id);
  await page.goto(suite.appURL('lender'));
  await expectHome(page, 'lender');
  await whoami(page.request, suite, 'lender', account.id);
  const trigger = page.getByRole('button', { name: 'Switch App', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const benefits = page.getByRole('menuitem', { name: 'Benefits', exact: true });
  await expect(benefits).toHaveAttribute('href', `${BASE}/benefits/`);
  expect(await benefits.evaluate((node) => node.tagName)).toBe('A');
  await phoneFits(page);
  await page.evaluate(() => {
    document.documentElement.dataset.previousDocument = 'lender';
  });
  // As with the Default App list below: Base UI moves focus into the menu a frame
  // after it opens, and an End pressed before that lands on the trigger and is lost.
  await expect(page.locator('[role="menu"]:focus-within')).toHaveCount(1);
  await page.keyboard.press('End');
  await expect(benefits).toBeFocused();
  const navigation = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() && request.resourceType() === 'document' && new URL(request.url()).pathname === `${BASE}/benefits/`,
  );
  await page.keyboard.press('Enter');
  await navigation;
  await expectHome(page, 'benefits');
  expect(await page.locator('html').getAttribute('data-previous-document')).toBeNull();
  await whoami(page.request, suite, 'benefits', account.id);
  expect(await nativeSession(page.request, suite)).toEqual(session);
  expect(await suite.preference(page.request, account.id)).toEqual(before);
  await page.getByRole('button', { name: 'Switch App', exact: true }).click();
  const lender = page.getByRole('menuitem', { name: 'Lender', exact: true });
  expect(await lender.evaluate((node) => node.tagName)).toBe('A');
  const href = (await lender.getAttribute('href'))!;
  // The middle click's background tab is waited for by its document request, not as a
  // page: Playwright reports a tab only once it has attached to it, and a tab whose
  // navigation commits during the attach is never reported. Reproducing a CI hang, the
  // tab loaded Lender and ran its queries, and no `page` event came. The request is
  // reported either way, and carries the cookie the tab really sent.
  const inPlace: string[] = [];
  page.on('request', (sent) => {
    if (sent.isNavigationRequest()) inPlace.push(sent.url());
  });
  const opened = context.waitForEvent('request', {
    timeout: 15_000,
    predicate: (sent) => sent.isNavigationRequest() && sent.url() === `${suite.origin}${href}`,
  });
  await lender.click({ button: 'middle' });
  const request = await opened;
  expect((await request.allHeaders()).cookie).toContain(`${session.name}=${session.value}`);
  const tab = await context.newPage();
  try {
    await prepare(tab);
    await tab.goto(`${suite.origin}${href}`);
    await expectHome(tab, 'lender');
    expect(await nativeSession(tab.request, suite)).toEqual(session);
    expect(await suite.preference(tab.request, account.id)).toEqual(before);
  } finally {
    await tab.close();
  }
  // A new tab, not this one: the switcher must not turn a middle click into a navigation here.
  expect(inPlace).toEqual([]);
});

test('real Preferences saves by keyboard, survives fresh login and suite restart, and chooser persists Ask each time', async ({
  page,
  browser,
  suite,
}) => {
  const account = await multiAccount(page, suite);
  await page.goto(suite.appURL('lender'));
  await expectHome(page, 'lender');
  const dialog = await openPreferences(page);
  const choice = dialog.getByRole('button', { name: 'Default App', exact: true });
  await expect(choice).toBeEnabled();
  await expect(choice).toContainText('Ask each time');
  await expect(dialog.getByText(/Saved to your account/)).toBeVisible();
  await choice.focus();
  await page.keyboard.press('Space');
  // Base UI moves focus into the list a frame after it opens, and only the list
  // answers Home and End: a key pressed in that frame lands on the button and is
  // lost. Wait for the list to hold focus, as a person sees it open, before walking it.
  await expect(dialog.getByRole('option', { name: 'Ask each time', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(dialog.getByRole('option', { name: 'Benefits', exact: true })).toBeFocused();
  await phoneFits(page);
  await page.keyboard.press('Enter');
  await expect(choice).toContainText('Benefits');
  await dialog.getByRole('button', { name: 'Save default App', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Default App saved to your account.', { exact: true })).toBeVisible();
  await phoneFits(page);
  const saved = await suite.preference(page.request, account.id);
  expect(saved).toMatchObject({ accountId: account.id, defaultApp: 'benefits', revision: 1 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`${suite.origin}${BASE}/`);
  await expectHome(page, 'benefits');

  // Neither cookies nor local storage are copied. This is another login to the same account.
  const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const another = await fresh.newPage();
    await prepare(another);
    await signIn(another, suite, account);
    expect(await suite.preference(another.request, account.id)).toEqual(saved);
    await another.goto(`${suite.origin}${BASE}/`);
    await expectHome(another, 'benefits');
    const preferences = await openPreferences(another);
    await expect(preferences.getByRole('button', { name: 'Default App', exact: true })).toContainText('Benefits');
  } finally {
    await fresh.close();
  }
  await page.goto('about:blank');
  await suite.restart();
  const restarted = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const another = await restarted.newPage();
    await prepare(another);
    await signIn(another, suite, account);
    expect(await suite.preference(another.request, account.id)).toEqual(saved);
    await another.goto(`${suite.origin}${BASE}/`);
    await expectHome(another, 'benefits');
    await another.goto(suite.chooser);
    await expect(another.getByLabel('Default App', { exact: true })).toHaveValue('benefits');
    await another.getByLabel('Default App', { exact: true }).selectOption('');
    await another.getByRole('button', { name: 'Save default App', exact: true }).click();
    await expect(another.locator('#preference-status')).toContainText('Default App saved.');
    expect(await suite.preference(another.request, account.id)).toEqual({ accountId: account.id, defaultApp: null, revision: 2 });
    await another.reload();
    await expect(another.getByLabel('Default App', { exact: true })).toHaveValue('');
    await another.goto(`${suite.origin}${BASE}/`);
    await expect(another).toHaveURL(suite.chooser);
    await phoneFits(another);
    // An explicit child choice leaves Ask each time untouched and is shown by real Preferences too.
    await another.getByRole('link', { name: 'Benefits', exact: true }).click();
    await expectHome(another, 'benefits');
    const preferences = await openPreferences(another);
    await expect(preferences.getByRole('button', { name: 'Default App', exact: true })).toContainText('Ask each time');
    expect(await suite.preference(another.request, account.id)).toEqual({ accountId: account.id, defaultApp: null, revision: 2 });
  } finally {
    await restarted.close();
  }
});

test('explicit switch to Lender reaches its home even when Benefits is the saved root default', async ({ page, suite }) => {
  const account = await multiAccount(page, suite);
  const saved = await suite.setDefault(page.request, account.id, 'benefits');
  await page.goto(`${suite.origin}${BASE}/`);
  await expectHome(page, 'benefits');
  await page.getByRole('button', { name: 'Switch App', exact: true }).click();
  const lender = page.getByRole('menuitem', { name: 'Lender', exact: true });
  expect(await lender.evaluate((node) => node.tagName)).toBe('A');
  await lender.click();
  // Keep this assertion: routing an explicit App link through the default entry is a contract conflict.
  await expectHome(page, 'lender');
  expect(await suite.preference(page.request, account.id)).toEqual(saved);
});

test('revoked default falls back to chooser and refresh removes the unavailable switcher link', async ({ page, suite }) => {
  const account = await multiAccount(page, suite);
  await suite.setDefault(page.request, account.id, 'benefits');
  await page.goto(suite.appURL('lender'));
  await expectHome(page, 'lender');
  await page.getByRole('button', { name: 'Switch App', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Benefits', exact: true })).toBeVisible();
  await suite.grant('benefits', account.id, [], 1);
  const refresh = page.waitForResponse(`${suite.origin}${BASE}/api/suite/apps`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refresh;
  await expect(page.getByRole('menuitem', { name: 'Benefits', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch App', exact: true })).toHaveCount(0);
  await page.goto(`${suite.origin}${BASE}/`);
  await expect(page).toHaveURL(suite.chooser);
  await expect(page.getByRole('link', { name: 'Lender', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Benefits', exact: true })).toHaveCount(0);
  expect((await suite.preference(page.request, account.id)).defaultApp).toBe('benefits');
  expect((await page.request.get(`${suite.origin}${BASE}/benefits/api/schema`)).status()).toBe(401);
  await phoneFits(page);
});

interface DelayControl {
  arm: string[];
  arrived: number;
  delivered: number;
  release(): void;
}
type DelayWindow = typeof window & { suiteNavigationDelay: DelayControl };
/** Capture real server answers, then ignore the caller's abort for only armed reads.
 * This tests the response fence independently of browser cancellation. */
async function installDelay(page: Page) {
  await page.addInitScript(() => {
    const releases: Array<() => void> = [];
    const state: DelayControl = {
      arm: [],
      arrived: 0,
      delivered: 0,
      release() {
        releases.splice(0).forEach((release) => release());
      },
    };
    (window as DelayWindow).suiteNavigationDelay = state;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      const index = state.arm.indexOf(path);
      if (index < 0 || (init?.method ?? 'GET') !== 'GET') return original(input, init);
      state.arm.splice(index, 1);
      const response = await original(input, { ...init, signal: undefined });
      const buffered = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      const held = new Promise<void>((resolve) => releases.push(resolve));
      state.arrived++;
      await held;
      state.delivered++;
      return buffered;
    };
  });
}
async function releaseDelayed(page: Page, count: number) {
  await page.evaluate(() => (window as DelayWindow).suiteNavigationDelay.release());
  await page.waitForFunction((count) => (window as DelayWindow).suiteNavigationDelay.delivered === count, count);
  // Let response continuations and React's resulting commit run before negative assertions.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('a retired chooser refresh cannot restore revoked Apps or an old preference', async ({ page, suite }) => {
  const account = await multiAccount(page, suite);
  await suite.setDefault(page.request, account.id, 'benefits');
  await installDelay(page);
  await page.goto(suite.chooser);
  await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('benefits');
  await page.evaluate((basePath) => {
    (window as DelayWindow).suiteNavigationDelay.arm = [`${basePath}/api/suite/apps`];
    location.hash = 'first-refresh';
  }, BASE);
  await page.waitForFunction(() => (window as DelayWindow).suiteNavigationDelay.arrived === 1);
  try {
    await suite.grant('benefits', account.id, [], 1);
    await suite.setDefault(page.request, account.id, null);
    await page.evaluate(() => {
      location.hash = 'new-refresh';
    });
    await expect(page.getByRole('link', { name: 'Benefits', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('');
    await releaseDelayed(page, 1);
    await expect(page.getByRole('link', { name: 'Lender', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Benefits', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('');
  } finally {
    await page.evaluate(() => (window as DelayWindow).suiteNavigationDelay.release());
  }
});

test('late App/preference responses cannot publish after the browser locks for another account', async ({ page, browser, suite }) => {
  const first = await multiAccount(page, suite);
  await suite.setDefault(page.request, first.id, 'lender');
  let other: BrowserContext | undefined;
  try {
    other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const second = await suite.account(other.request, 'second@example.test');
    await suite.grant('benefits', second.id);
    await installDelay(page);
    await page.goto(suite.appURL('lender'));
    await expectHome(page, 'lender');
    await expect(page.getByRole('button', { name: 'Switch App', exact: true })).toBeVisible();
    await page.evaluate((basePath) => {
      (window as DelayWindow).suiteNavigationDelay.arm = [`${basePath}/api/suite/apps`, `${basePath}/api/suite/preferences`];
    }, BASE);
    await openPreferences(page);
    await page.waitForFunction(() => (window as DelayWindow).suiteNavigationDelay.arrived === 2);
    expect(
      (
        await page.request.post(`${suite.origin}${BASE}/api/auth/sign-out`, {
          headers: { origin: suite.origin, 'x-mistri-account': first.id },
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.post(`${suite.origin}${BASE}/api/auth/sign-in/email`, {
          headers: { origin: suite.origin },
          data: { email: second.email, password: PASSWORD },
        })
      ).status(),
    ).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#session-lock')).toBeVisible();
    await releaseDelayed(page, 2);
    await expect(page.getByRole('button', { name: 'Switch App', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Preferences', exact: true })).toHaveCount(0);
    await expect(page.getByText(APP_ROWS.lender, { exact: true })).toHaveCount(0);
    await page.goto(suite.appURL('benefits'));
    await expectHome(page, 'benefits');
    await whoami(page.request, suite, 'benefits', second.id);
    const preferences = await openPreferences(page);
    await expect(preferences.getByRole('button', { name: 'Default App', exact: true })).toContainText('Ask each time');
    await preferences.getByRole('button', { name: 'Default App', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Lender', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Benefits', exact: true })).toBeVisible();
    expect(await suite.preference(page.request, second.id)).toEqual({ accountId: second.id, defaultApp: null, revision: 0 });
  } finally {
    await page.evaluate(() => (window as Partial<DelayWindow>).suiteNavigationDelay?.release()).catch(() => {});
    await other?.close();
  }
});

test.describe('explicitly authored grouped navbar', () => {
  test.use({
    switcher: {
      placement: 'navbar',
      label: 'Explore your workspaces and account services',
      groups: [
        { label: 'Everyday work', links: [{ label: 'Lender home', to: { app: 'lender', kind: 'home' } }] },
        {
          label: 'People and benefits',
          links: [
            { label: 'Benefits plans, enrollment and employee eligibility notes', to: { app: 'benefits', kind: 'view', view: 'notes' } },
          ],
        },
        {
          label: 'Unavailable records',
          links: [{ label: 'Restricted note', to: { app: 'benefits', kind: 'record', resource: 'private_note', key: { id: 1 } } }],
        },
      ],
    },
  });

  test('checked groups form desktop columns, stack at 390px, and keep authored keyboard navigation', async ({ page, suite }) => {
    const account = await multiAccount(page, suite),
      before = await suite.preference(page.request, account.id);
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.goto(suite.appURL('lender'));
    await expectHome(page, 'lender');
    const trigger = page.getByRole('button', { name: 'Explore your workspaces and account services', exact: true });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter');
    const work = page.getByRole('group', { name: 'Everyday work', exact: true });
    const people = page.getByRole('group', { name: 'People and benefits', exact: true });
    await expect(work).toBeVisible();
    await expect(people).toBeVisible();
    await expect(page.getByRole('group', { name: 'Unavailable records', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Restricted note', exact: true })).toHaveCount(0);
    const left = (await work.boundingBox())!,
      right = (await people.boundingBox())!;
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
    expect(right.x).toBeGreaterThan(left.x + 1);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Enter');
    await expect(people).toBeVisible();
    const top = (await work.boundingBox())!,
      bottom = (await people.boundingBox())!;
    expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height);
    await phoneFits(page);
    const link = people.getByRole('menuitem', { name: 'Benefits plans, enrollment and employee eligibility notes', exact: true });
    expect(await link.evaluate((node) => node.tagName)).toBe('A');
    await expect(page.locator('[role="menu"]:focus-within')).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expectHome(page, 'benefits');
    await whoami(page.request, suite, 'benefits', account.id);
    expect(await suite.preference(page.request, account.id)).toEqual(before);
  });
});
