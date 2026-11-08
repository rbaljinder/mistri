import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';
import { TMP } from './support/fixtures';

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      const directory = mkdtempSync(join(TMP, 'embed-react-'));
      db = join(directory, 'crm.db');
      execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), db], {
        stdio: 'pipe',
        env: { ...process.env, MISTRI_CRM_TODAY: CRM_TODAY },
      });
      const config = join(directory, 'crm.json');
      writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));
      /* Port 0: the host listens on what the OS gives it and says which, so no port is reserved, released and raced for. */
      const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/support/embedReactHost.ts', config, '0'], {
        env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', MISTRI_CLOCK: CRM_CLOCK },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = started;
      let log = '';
      started.stdout!.on('data', (chunk) => {
        log += String(chunk);
      });
      started.stderr!.on('data', (chunk) => {
        log += String(chunk);
      });
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`The host did not start: ${log}`)), 30_000);
        started.stdout!.on('data', () => {
          const said = /Host listening on (\d+)/.exec(log);
          if (said) {
            origin = `http://127.0.0.1:${said[1]}`;
            clearTimeout(timer);
            done();
          }
        });
        started.once('exit', () => {
          clearTimeout(timer);
          fail(new Error(`The host exited: ${log}`));
        });
      });
    },
    async () => {
      if (!child || child.exitCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    },
  ),
});

/* The day the Compass database is seeded for, and the instant its server believes it is (embed-handler.spec.ts says
   why they are spelled here). */
const CRM_TODAY = '2026-09-04';
const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;

/**
 * Compass inside someone else's React app (@mistriwork/mistri/react): the host's router owns the address, the App is drawn
 * at `/crm` under it, and the server is the handler mounted at `/api/mistri` in the host's own server
 * (e2e/support/embedReactHost.ts). Walked as a person would — a host link in, a list, a record, a verb that writes,
 * the browser's Back and Forward, a host link out — with the two promises of the styling checked in computed
 * styles: the host's stylesheet does not reach the App, and the App's does not reach the host.
 *
 * The host is its own process on a free port over a fresh Compass database (mkdtemp), so it runs beside the other
 * parallel specs. Its page is served from source through Vite, so the first visit compiles the shell.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.describe.configure({ timeout: 60_000 });

const statusOf = (id: number) => {
  const handle = new DatabaseSync(db, { readOnly: true, timeout: 5000 });
  try {
    return (handle.prepare('SELECT status FROM lead WHERE id = ?').get(id) as { status: string }).status;
  } finally {
    handle.close();
  }
};

const pathOf = (page: Page) => new URL(page.url()).pathname;

test('the App under the host’s router: a host link in, list, record, a verb, Back and Forward, a host link out', async ({ page }) => {
  /* Every request of tablewalk's goes to the mount; none to an /api the host did not give it. */
  const stray: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api') && !url.pathname.startsWith('/api/mistri/')) stray.push(url.pathname);
  });

  await page.goto(`${origin}/`);
  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  expect(pathOf(page)).toBe('/crm/leads');
  // The shell names the room; the host decides what the tab says.
  await expect(page).toHaveTitle('Leads · Compass · Host');

  // The first tab, New, is where the list opens, newest first: Margot Fontaine (127) heads it.
  await page
    .getByRole('row', { name: /Margot Fontaine/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Margot Fontaine' })).toBeVisible();
  await expect.poll(() => pathOf(page)).toBe('/crm/leads/127');

  await page.getByRole('button', { name: 'Start working', exact: true }).first().click();
  await expect.poll(() => statusOf(127)).toBe('working');
  await expect(page.getByRole('button', { name: 'Start working', exact: true })).toHaveCount(0);

  // The browser's Back and Forward are the host router's, and the shell follows them.
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/crm/leads');
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  await page.goForward();
  await expect.poll(() => pathOf(page)).toBe('/crm/leads/127');
  await expect(page.getByText('Mark lost')).toBeVisible();

  // A host link into another room of the App, then out of the App altogether, and Back into it.
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'The host' })).toBeVisible();
  // Gone with the last element: no sheet of tablewalk's is left on the host's page.
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/crm/accounts');
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();

  expect(stray).toEqual([]);
});

/** What a person sees of an element: the properties a stylesheet crossing over would change. */
const LOOKED_AT = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'border-top-width',
  'border-left-width',
  'border-radius',
  'margin-top',
  'padding-left',
];

const looks = (page: Page, selectors: string[]) =>
  page.evaluate(
    ({ selectors, properties }) =>
      Object.fromEntries(
        selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return [selector, null];
          const style = getComputedStyle(element);
          return [selector, Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]))];
        }),
      ),
    { selectors, properties: LOOKED_AT },
  );

/* Inside the App: its heading, a tab, a cell, a button, the search box, a link of the chrome. */
const APP_PARTS = [
  '.mistri-body h1',
  '.mistri-body [role="tab"][aria-selected="true"]',
  '.mistri-body tbody tr:first-child td',
  '.mistri-body .applist-head-row button',
  '.mistri-body input[placeholder^="Search leads"]',
  '.mistri-body #home-button',
];
/* The host's own: its bar, a link in it, its body. */
const HOST_PARTS = ['body', '.host-bar', '.host-bar a'];

test('the host’s stylesheet does not reach the App, and the App’s does not reach the host', async ({ browser }) => {
  // The App as it looks on a page with no stylesheet of the host's, and as it looks under the host's (a layered
  // reset of element rules, and loud type on its body that every child would inherit).
  const bare = await browser.newPage();
  await bare.addInitScript(() => {
    (window as { __bareHost?: boolean }).__bareHost = true;
  });
  await bare.goto(`${origin}/crm/leads`);
  await expect(bare.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  const alone = await looks(bare, APP_PARTS);
  await bare.close();

  const page = await browser.newPage();
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'The host' })).toBeVisible();
  const hostBefore = await looks(page, [...HOST_PARTS, 'h1', 'button', 'p']);

  await page.getByRole('link', { name: 'Leads' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  const hosted = await looks(page, APP_PARTS);
  for (const part of APP_PARTS) expect(alone[part], part).not.toBeNull();
  expect(hosted).toEqual(alone);
  // The host's own chrome beside the App is as it was without it.
  expect(await looks(page, HOST_PARTS)).toEqual(Object.fromEntries(HOST_PARTS.map((part) => [part, hostBefore[part]])));

  // And with the App gone again, the host's page is untouched.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'The host' })).toBeVisible();
  expect(await looks(page, [...HOST_PARTS, 'h1', 'button', 'p'])).toEqual(hostBefore);
  await page.close();
});

test('a single list on a screen of the host’s: no chrome, its own address, and a record handed to the host', async ({ page }) => {
  await page.goto(`${origin}/lead-list`);
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toContainText('Working');
  // The App's chrome is the host's to draw.
  await expect(page.locator('.mistri-body .topbar')).toBeHidden();
  // The host's <main> is the page's one main landmark; the shell's content pane is a plain element inside it.
  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await page.locator('#content').evaluate((pane) => [pane.tagName, Boolean(pane.closest('main'))])).toEqual(['DIV', true]);

  await page.getByRole('row').nth(1).click();
  // The host was told which record, and shows it its own way; the list stays, and the address bar is the host's.
  await expect(page.getByLabel('Opened record')).toHaveText(/^lead \{"id":\d+\} \/leads\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
  expect(pathOf(page)).toBe('/lead-list');
});

test('a single record on a screen of the host’s', async ({ page }) => {
  await page.goto(`${origin}/lead/131`);
  await expect(page.getByText('Zoe Takahashi').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toBeVisible();
  await expect(page.locator('.mistri-body .topbar')).toBeHidden();
  expect(pathOf(page)).toBe('/lead/131');
});
