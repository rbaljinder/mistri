/**
 * Web Vitals, measured on the client as the package ships it, and held to a
 * budget.
 *
 * Google calls a page "good" at CLS ≤ 0.1, LCP ≤ 2.5 s and INP ≤ 200 ms, at
 * the 75th percentile of real visits. Nothing here had ever measured any of
 * the three (test/load's README said so), and layout shift was the thing the
 * maintainer noticed first. This starts the compiled server
 * (`node --conditions=mistri-built packages/{tablewalk,mistri}/dist/server/index.js`) the way test/built-client-browser.mjs does —
 * its own ports, its own temporary data — and records, with the browser's own
 * PerformanceObserver:
 *
 *   - CLS, the largest session window of unexpected shifts (1 s gap, 5 s
 *     cap), and each shift's sources by the node that moved and where from;
 *   - LCP, its element and its time from navigation;
 *   - INP, the slowest interaction's event duration (input delay, handlers,
 *     and the paint after), with the CPU slowed to a quarter of the reference
 *     machine's speed, as Lighthouse's mobile run slows it 4× (REFERENCE_SPEED
 *     says why it is scaled).
 *
 * Every surface's first paint, cold and warm (a public form, the landing, an
 * App's shell, the Workbench); rooms (a list, a record, a dashboard, a board
 * and a calendar); and the interactions a person repeats all day (open a
 * record from a list, Back, open a related record, filter, sort, a column's
 * menu, type in search, switch tab, open a dialog). On Compass, Forecourt
 * (public pages, photographs), the Workbench and, where TABLEWALK_TEST_PG
 * names a PostgreSQL server, Ignition (a tenant App and its public intake);
 * at a desk (1280) and on a phone (390). Each is the median of --runs visits.
 *
 * The budgets are ours and tighter than Google's, so a slower machine or a
 * busier CI runner still lands green; they live in BUDGET below, and an
 * exception lives beside it with its reason, the way scripts/bundle-budget.mjs
 * keeps its ceilings.
 *
 *   node test/built-client-vitals.mjs                 measure and check
 *   node test/built-client-vitals.mjs --report <file> also write the tables as Markdown
 *   node test/built-client-vitals.mjs --print         measure, check nothing
 *   node test/built-client-vitals.mjs --runs 5 --only compass --width 390
 *
 * Build first (`npm run build`).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { readyBrowserChild } from './support/ownedBrowserChild.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* Each binary's compiled entry: an App's start is mistri's, a database's tablewalk's. */
const built = {
  tablewalk: join(root, 'packages/tablewalk/dist/server/index.js'),
  mistri: join(root, 'packages/mistri/dist/server/index.js'),
};
assert.ok(
  existsSync(built.tablewalk) &&
    existsSync(built.mistri) &&
    ['tablewalk', 'mistri'].every((product) => existsSync(join(root, `packages/${product}/dist/client/index.html`))),
  'Build the package first: npm run build.',
);

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const RUNS = Number(option('--runs') ?? 3);
const ONLY = option('--only')?.split(',');
const WIDTHS = option('--width')?.split(',').map(Number) ?? [1280, 390];
const FILTER = option('--filter');
const REPORT = option('--report');
const PRINT = args.includes('--print');
/* `--advisory-inp` reports INP overruns without failing. CI passes it: a shared
   runner scored against the reference machine was slowed 7×, and at that rate an
   interaction's time is mostly the runner's noise. Layout shift and LCP, which a
   slow CPU barely moves, stay gates there. A local run holds all three. */
const ADVISORY_INP = args.includes('--advisory-inp');
const SERVE = args.includes('--serve');

/* The budgets, per measure. Google's "good" is CLS 0.1, LCP 2.5 s, INP 200 ms.
   CLS: 0.01, a tenth of Google's, with 0 the aim — a shift a person can see
   is a bug, and every source this suite has found was one element moving
   for want of a reserved box.
   LCP: 1,200 ms from a cold cache on this machine's loopback, half of
   Google's: the network is free here, so what is left is our own script,
   style and first query, and a real visitor adds their network to it.
   INP: 100 ms with the CPU slowed 4×, half of Google's: an interaction that
   is slow on a fast machine is slower on a phone. */
export const BUDGET = { cls: 0.01, lcp: 1200, inp: 100, inpRoom: 200 };
/* inpRoom: an interaction that starts a room over — opening a record, Back,
   a tab, a filter, a search — is a navigation, and a navigation now holds a
   picture of the screen it leaves until the new room is complete
   (packages/kit/src/client/navigationHold.ts), which is why none of them moves anything.
   Copying that screen and laying the copy out costs 60–90 ms of the
   navigation's frame on the slowed CPU, so these measure 140–185 ms where
   they measured 40–80 before it. They are held to Google's own "good",
   200 ms, until the picture is cheaper; every other interaction keeps 100. */
/* A measure a page may not yet meet, by `<app> <width> <page>`, each with its
   cause. Empty is the goal; an entry is a decision made here, with the reason
   beside it. */
export const EXCEPTIONS = {};

/* The CPU an interaction is measured on. Lighthouse slows the CPU 4× for
   its mobile run, whatever machine it is on; a gate that runs here and on a
   CI runner half as fast would then measure two different phones. So the
   browser's speed is measured first, on a fixed piece of script, and the
   slowdown is scaled to it: 4× on the reference machine (an Apple M-series
   laptop, where the benchmark below scores about 11 rounds a millisecond),
   less on a slower one, so the effective CPU is the same everywhere. A
   machine already slower than the target is not slowed at all, and says so
   in the report. */
const REFERENCE_SPEED = 11;
const SLOWDOWN = 4;

const VIEWPORTS = { 1280: { width: 1280, height: 900 }, 390: { width: 390, height: 844 } };
/* The seeded Apps' "today" (scripts/visual-matrix.mjs): date phrases read the same every run. */
const TODAY = '2026-09-04';

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-vitals-'));

/** The compiled server, as `npx tablewalk` runs it. */
async function start(name, serveArgs, env = {}) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--conditions=mistri-built', serveArgs.includes('--app') ? built.mistri : built.tablewalk, ...serveArgs, '--port', String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: scratch,
        XDG_CONFIG_HOME: join(scratch, `${name}-xdg`),
        TABLEWALK_OPEN: '0',
        MISTRI_OPEN: '0',
        TABLEWALK_CLOCK: `${TODAY}T16:00:00.000Z`,
        MISTRI_CLOCK: `${TODAY}T16:00:00.000Z`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const owner = await readyBrowserChild(child, name, { startupMs: 60000 });
  return { origin: `http://127.0.0.1:${port}`, stop: owner.stop };
}

/**
 * Recorded in the page from its first script: every layout shift with its
 * sources, every LCP candidate with its element, every event that belongs to
 * an interaction. A node is named when the entry arrives, because by the time
 * the run reads it the node may be gone.
 */
const OBSERVE = `(() => {
  const v = window.__vitals = { shifts: [], lcp: [], events: [] };
  const name = node => {
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return '(removed)';
    let said = node.tagName.toLowerCase();
    if (node.id) said += '#' + node.id;
    const classes = [...node.classList].slice(0, 3);
    if (classes.length) said += '.' + classes.join('.');
    const text = (node.getAttribute('aria-label') || node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 32);
    return text ? said + ' "' + text + '"' : said;
  };
  const box = r => r ? Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : '';
  const watch = (type, take, extra = {}) => {
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) take(entry); }).observe({ type, buffered: true, ...extra }); }
    catch { /* not in this browser */ }
  };
  watch('layout-shift', e => v.shifts.push({ t: e.startTime, value: e.value, recent: e.hadRecentInput,
    sources: (e.sources || []).map(s => ({ node: name(s.node), from: box(s.previousRect), to: box(s.currentRect) })) }));
  watch('largest-contentful-paint', e => v.lcp.push({ t: e.startTime, size: e.size, node: name(e.element), url: e.url || '' }));
  watch('event', e => { if (e.interactionId) v.events.push({ id: e.interactionId, type: e.name, t: e.startTime, duration: e.duration,
    delay: e.processingStart - e.startTime, handlers: e.processingEnd - e.processingStart,
    paint: e.startTime + e.duration - e.processingEnd, target: name(e.target) }); }, { durationThreshold: 16 });
})();`;

/** CLS as Google defines it: the worst session window of shifts without recent input. */
function cls(shifts) {
  let worst = 0,
    window = 0,
    first = -Infinity,
    last = -Infinity;
  for (const shift of shifts.filter((s) => !s.recent).sort((a, b) => a.t - b.t)) {
    if (shift.t - last > 1000 || shift.t - first > 5000) {
      window = 0;
      first = shift.t;
    }
    window += shift.value;
    last = shift.t;
    worst = Math.max(worst, window);
  }
  return worst;
}

/** Read what the page recorded since `since` (performance.now()). */
async function readVitals(page, since = 0) {
  return page.evaluate((since) => {
    const v = globalThis.__vitals;
    return { shifts: v.shifts.filter((s) => s.t >= since), lcp: v.lcp.at(-1) ?? null, events: v.events.filter((e) => e.t >= since) };
  }, since);
}

/** Rounds of a fixed string-building loop a millisecond, the median of five. */
async function benchmark(browser) {
  const page = await browser.newPage();
  await page.setContent('<p>benchmark</p>');
  const speeds = [];
  for (let i = 0; i < 5; i++)
    speeds.push(
      await page.evaluate(() => {
        const started = performance.now();
        let rounds = 0;
        while (performance.now() - started < 250) {
          const parts = [];
          for (let n = 0; n < 2000; n++) parts.push(`${n}:${(n * 7919) % 104729}`);
          if (parts.join(',').length) rounds++;
        }
        return rounds / (performance.now() - started);
      }),
    );
  await page.close();
  return median(speeds);
}
let cpuRate = SLOWDOWN;
let cpuSpeed = REFERENCE_SPEED;

/** The page has stopped moving: the network idle, then a second of nothing and two frames. */
async function settle(page, quietMs = 1000) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(quietMs);
  await page.evaluate(() => new Promise((done) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done))));
}

/** Each App this suite visits: seeded into the scratch directory and served from the build. */
const APPS = {
  async compass() {
    const db = join(scratch, 'compass.db');
    execFileSync(process.execPath, [join(root, 'test/fixtures/databases/crm/make-crm-db.mjs'), db], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, MISTRI_CRM_TODAY: TODAY },
    });
    // Writable, as a team runs it: New and a record's actions are drawn.
    writeFileSync(`${db}.json`, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));
    return start('compass', ['--config', `${db}.json`, '--app', 'test/fixtures/apps/crm']);
  },
  async forecourt() {
    // Forecourt's seed migrates its command journal through @mistriwork/mistri/commands, which tsx resolves from source.
    const db = join(scratch, 'forecourt.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(root, 'test/fixtures/databases/forecourt/seed.mjs'), db], {
      cwd: root,
      stdio: 'ignore',
    });
    return start(
      'forecourt',
      [
        '--config',
        `${db}.json`,
        '--app',
        'test/fixtures/apps/forecourt',
        '--commands',
        'test/fixtures/apps/forecourt/commands.ts',
        '--policy',
        'test/fixtures/apps/forecourt/policy.ts',
      ],
      {
        BETTER_AUTH_SECRET: 'disposable-built-client-vitals-secret-at-least-thirty-two-characters',
        MISTRI_AUTH_ADMIN_EMAIL: 'staff@forecourt.example.test',
        MISTRI_AUTH_ADMIN_PASSWORD: 'disposable-built-client-password',
      },
    );
  },
  async workbench() {
    return start('workbench', ['--demo', '--no-config']);
  },
  /* A tenant App: Ignition, PostgreSQL-only, deployed the way its browser
     specs deploy it (e2e/support/ignitionServer.ts), but from the build. Run
     where TABLEWALK_TEST_PG names a server, and said skipped where not. */
  async ignition() {
    if (!process.env.TABLEWALK_TEST_PG) return undefined;
    const { register } = await import('tsx/esm/api');
    register();
    const { startIgnition } = await import('../e2e/support/ignitionServer.ts');
    const fixture = await startIgnition({ directory: join(scratch, 'ignition'), entry: [built] });
    return { origin: fixture.origin, stop: fixture.stop, fixture };
  },
};

/** The first of these that is on screen: a desk's row or a phone's card. */
const shown = (page, selector) => page.locator(selector).filter({ visible: true }).first();
const ROW = '#content tbody tr td:first-child, #content .record-summary-title, #content .cards-open';
const openRow = async (page, pattern) => {
  await shown(page, ROW).click();
  await page.waitForURL(pattern);
  await page.locator('.page-head').first().waitFor();
};
/* Back the way a reader goes back inside the App: the trail's Back where
   there is one, else the browser's. */
const back = async (page, pattern) => {
  const button = page.getByRole('navigation', { name: 'Trail' }).getByRole('button', { name: 'Back', exact: true });
  if (await button.isVisible()) await button.click();
  else await page.goBack();
  await page.waitForURL(pattern);
};
const tourDone = (page) =>
  page.addInitScript(() => {
    try {
      localStorage.setItem('mistri.tour.v1', 'done');
    } catch {
      /* no storage */
    }
  });

/**
 * What is measured, at each App's own addresses: an App served alone stands
 * at the root (packages/mistri/src/shared/appAddress.ts). A `load` is a navigation, cold (a new browser profile)
 * and then warm (the same profile again); an `act` loads `path`, waits for it
 * to settle, slows the CPU 4×, then does what a person does and waits for the
 * result. `phone: false` where the control is not there on a phone.
 */
const SCENARIOS = [
  // Compass: the App shell and its rooms.
  { app: 'compass', kind: 'load', name: 'dashboard (App shell)', path: '/' },
  { app: 'compass', kind: 'load', name: 'list', path: '/leads' },
  /* A layout dashboard (the fixture's Pipeline layout): its template is in the payload, so the grid's tracks stand at
     the first paint, and a picked window re-flows nothing until every tile has answered it, in one swap. */
  { app: 'compass', kind: 'load', name: 'layout dashboard', path: '/pipeline-layout' },
  {
    app: 'compass',
    kind: 'act',
    name: 'pick a window on a layout dashboard',
    path: '/pipeline-layout',
    act: async (page) => {
      await shown(page, '.dash-windows button:has-text("Last 90 days")').click();
      await page.waitForURL(/period=last-90-days/);
    },
  },
  { app: 'compass', kind: 'load', name: 'record', path: '/leads/11' },
  { app: 'compass', kind: 'load', name: 'calendar', path: '/task-calendar' },
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'open a record from a list',
    path: '/leads',
    act: (page) => openRow(page, /\/leads\/\d+/),
  },
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'Back to the list',
    path: '/leads',
    before: (page) => openRow(page, /\/leads\/\d+/),
    act: (page) => back(page, /\/leads(\?|$)/),
  },
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'open a related record',
    path: '/accounts/13/opportunities',
    act: (page) => openRow(page, /\/opportunities\/\d+/),
  },
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'switch tab',
    path: '/leads',
    act: async (page) => {
      await page.locator('#content .tab', { hasText: 'Working' }).first().click();
      await page.waitForURL(/tab=working/);
    },
  },
  /* By source: a status that is also a tab becomes the tab. A desk opens the
     column's picker in the bar; a phone, the sheet of every filter. */
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'filter',
    path: '/leads',
    act: async (page) => {
      if (await page.locator('#content .applist-sheet-open').isVisible()) {
        await page.locator('#content .applist-sheet-open').click();
        await page.getByRole('dialog').locator('fieldset[data-column="source"] input').first().click();
        await page.getByRole('dialog').getByRole('button', { name: /^Show/ }).click();
      } else {
        await page.locator('#content .applist-add', { hasText: 'Source' }).first().click();
        await shown(page, '.filter-pop input[type="checkbox"]').click();
        await shown(page, '.filter-pop-foot button[type="submit"]').click();
      }
      await page.waitForURL(/source=/);
    },
  },
  {
    app: 'compass',
    kind: 'act',
    name: 'sort',
    path: '/leads',
    phone: false,
    act: async (page) => {
      await shown(page, '#content .th-sort').click();
      await page.waitForURL(/sort=/);
    },
  },
  {
    app: 'compass',
    kind: 'act',
    name: 'open a column menu',
    path: '/leads',
    phone: false,
    act: async (page) => {
      await shown(page, '#content .th-filter').click();
      await shown(page, '[role="menu"], [role="dialog"], .th-menu').waitFor();
    },
  },
  {
    app: 'compass',
    kind: 'act',
    room: true,
    name: 'type in search',
    path: '/leads',
    act: async (page) => {
      const box = shown(page, '#content .applist-search-input');
      await box.pressSequentially('marco', { delay: 60 });
      await box.press('Enter');
      await page.waitForURL(/search=marco/);
    },
  },
  {
    app: 'compass',
    kind: 'act',
    name: 'open a dialog (New)',
    path: '/leads',
    act: async (page) => {
      await shown(page, '#content .applist-new').click();
      await page.getByRole('dialog').first().waitFor();
    },
  },

  // Forecourt: the public surface, the landing, photographs.
  { app: 'forecourt', kind: 'load', name: 'public form', path: '/form/inquire' },
  { app: 'forecourt', kind: 'load', name: 'sign-in (public surface)', path: '/sign-in' },
  { app: 'forecourt', kind: 'load', name: 'landing', path: '/' },
  { app: 'forecourt', kind: 'load', name: 'cards list', path: '/vehicles' },
  { app: 'forecourt', kind: 'load', name: 'record (gallery)', path: '/vehicles/1' },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'open a record from cards',
    path: '/vehicles',
    act: (page) => openRow(page, /\/vehicles\/\d+/),
  },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'Back to the cards',
    path: '/vehicles',
    before: (page) => openRow(page, /\/vehicles\/\d+/),
    act: (page) => back(page, /\/vehicles(\?|$)/),
  },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'open a related record',
    path: '/vehicles/1',
    act: async (page) => {
      await page.getByRole('list', { name: 'Similar vehicles' }).getByRole('button').first().click();
      await page.waitForURL((url) => !/\/vehicles\/1-/.test(url.pathname));
      await page.locator('.page-head').first().waitFor();
    },
  },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'switch tab',
    path: '/vehicles',
    act: async (page) => {
      // A tab a phone's row keeps too: SUVs folds under More at 390 (a strip of tabs fits its row).
      await page.locator('#content .tab', { hasText: 'Hybrid and electric' }).first().click();
      await page.waitForURL(/tab=/);
    },
  },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'sort',
    path: '/vehicles',
    act: async (page) => {
      await page.getByRole('button', { name: 'Sort', exact: true }).click();
      await page.getByRole('option', { name: 'Lowest price', exact: true }).click();
      await page.waitForURL(/sort=price/);
    },
  },
  {
    app: 'forecourt',
    kind: 'act',
    room: true,
    name: 'filter',
    path: '/vehicles',
    phone: false,
    act: async (page) => {
      await shown(page, '#content fieldset.facet input[type="checkbox"]').click();
      await page.waitForURL(/\?.+=/);
    },
  },
  {
    app: 'forecourt',
    kind: 'act',
    name: 'open a dialog (test drive)',
    path: '/vehicles/1',
    act: async (page) => {
      await page.getByRole('link', { name: 'Schedule a test drive' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },

  // The Workbench, the database browser's own first page and grid.
  { app: 'workbench', kind: 'load', name: 'landing', path: '/' },
  { app: 'workbench', kind: 'load', name: 'grid', path: '/demo/invoice' },
  {
    app: 'workbench',
    kind: 'act',
    room: true,
    name: 'open a record from the grid',
    path: '/demo/invoice',
    phone: false,
    act: async (page) => {
      await shown(page, '#content tbody tr td:nth-child(3)').click();
      await page.waitForURL(/~\d+/);
    },
  },
  {
    app: 'workbench',
    kind: 'act',
    name: 'sort',
    path: '/demo/invoice',
    phone: false,
    act: async (page) => {
      await page.locator('#content .th-sort', { hasText: 'total' }).click();
      await page.waitForURL(/sort/);
    },
  },
  {
    app: 'workbench',
    kind: 'act',
    room: true,
    name: 'filter by typing',
    path: '/demo/invoice',
    act: async (page) => {
      const box = shown(page, '#content .applist-quick-text');
      await box.pressSequentially('12', { delay: 60 });
      await box.press('Enter');
      await page.waitForURL(/12/);
    },
  },

  // A tenant App (Ignition): its public intake, and a dealership's rooms, entered as its specs enter them.
  { app: 'ignition', kind: 'load', name: 'public intake form', path: (fixture) => fixture.intake('north-motors') },
  {
    app: 'ignition',
    kind: 'act',
    name: 'choose a tenant (shell first paint)',
    path: () => '/',
    before: async (page, fixture) => {
      const session = await import('../e2e/support/ignitionSession.ts');
      await session.offeredContexts(page, fixture, fixture.account('dealer_admin', 'north-motors').email);
    },
    act: async (page) => {
      await page.locator('button[data-tenant="north-motors"]').click();
      await page
        .locator('.sidebar')
        .or(page.getByRole('navigation', { name: 'App menu' }))
        .filter({ visible: true })
        .first()
        .waitFor();
    },
  },
  {
    app: 'ignition',
    kind: 'act',
    room: true,
    name: 'open a room',
    path: () => '/',
    before: enterIgnition,
    act: async (page) => {
      const session = await import('../e2e/support/ignitionSession.ts');
      await session.openRoom(page, 'lead');
    },
  },
  {
    app: 'ignition',
    kind: 'act',
    room: true,
    name: 'open a record from a list',
    path: () => '/',
    before: async (page, fixture) => {
      await enterIgnition(page, fixture);
      const session = await import('../e2e/support/ignitionSession.ts');
      await session.openRoom(page, 'lead');
    },
    act: (page) => openRow(page, /\/lead/),
  },
];

async function enterIgnition(page, fixture) {
  const session = await import('../e2e/support/ignitionSession.ts');
  await session.enter(page, fixture, fixture.account('dealer_admin', 'north-motors').email, 'north-motors');
}

const median = (values) => {
  const sorted = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

/** The slowest interaction since the mark: its whole duration and where the time went. */
function slowest(events) {
  const byId = new Map();
  for (const event of events) if (!byId.has(event.id) || byId.get(event.id).duration < event.duration) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.duration - a.duration)[0] ?? null;
}

/** One visit and what it recorded. */
async function measureLoad(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await settle(page);
  const vitals = await readVitals(page);
  await page.close();
  return {
    cls: cls(vitals.shifts),
    lcp: vitals.lcp?.t ?? null,
    lcpNode: vitals.lcp ? `${vitals.lcp.node}${vitals.lcp.url ? ' (image)' : ''}` : '',
    shifts: vitals.shifts,
    errors,
  };
}

async function measureAct(context, origin, scenario, fixture) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const path = typeof scenario.path === 'function' ? scenario.path(fixture) : scenario.path;
  if (scenario.before && scenario.app === 'ignition') await scenario.before(page, fixture);
  else {
    await page.goto(origin + path);
    await settle(page, 500);
    if (scenario.before) {
      await scenario.before(page, fixture);
      await settle(page, 500);
    }
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  const since = await page.evaluate(() => performance.now());
  await scenario.act(page, fixture);
  await settle(page, 800);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const vitals = await readVitals(page, since);
  await page.close();
  const worst = slowest(vitals.events);
  return { cls: cls(vitals.shifts), inp: worst?.duration ?? null, worst, shifts: vitals.shifts, errors };
}

/** The shift sources over every run, heaviest first: what moved, and from where to where. */
function sources(runs) {
  const moved = new Map();
  for (const run of runs)
    for (const shift of run.shifts.filter((s) => !s.recent)) {
      const share = shift.value / Math.max(1, shift.sources.length);
      for (const source of shift.sources) {
        const seen = moved.get(source.node) ?? { node: source.node, value: 0, from: source.from, to: source.to };
        seen.value += share / runs.length;
        moved.set(source.node, seen);
      }
    }
  return [...moved.values()]
    .filter((s) => s.value >= 0.0005)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);
}

const rows = [];
async function runScenario(browser, scenario, width) {
  const server = servers[scenario.app];
  const fixture = server.fixture;
  const viewport = VIEWPORTS[width];
  const label = `${scenario.app} ${width} ${scenario.name}`;
  if (scenario.kind === 'load') {
    const url = server.origin + (typeof scenario.path === 'function' ? scenario.path(fixture) : scenario.path);
    const cold = [],
      warm = [];
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(OBSERVE);
      cold.push(await measureLoad(context, url));
      warm.push(await measureLoad(context, url));
      await context.close();
    }
    for (const [visit, runs] of [
      ['cold', cold],
      ['warm', warm],
    ])
      rows.push({
        label: `${label}, ${visit}`,
        app: scenario.app,
        width,
        name: `${scenario.name}, ${visit}`,
        kind: 'load',
        cls: median(runs.map((r) => r.cls)),
        lcp: median(runs.map((r) => r.lcp)),
        lcpNode: runs
          .map((r) => r.lcpNode)
          .sort()
          .at(Math.floor(runs.length / 2)),
        sources: sources(runs),
        errors: [...new Set(runs.flatMap((r) => r.errors))],
      });
  } else {
    const runs = [];
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(OBSERVE);
      await tourDone(context);
      try {
        runs.push(await measureAct(context, server.origin, scenario, fixture));
      } catch (error) {
        runs.push({ cls: null, inp: null, shifts: [], errors: [`could not run: ${error.message.split('\n')[0]}`] });
      }
      await context.close();
    }
    const worst =
      runs
        .map((r) => r.worst)
        .filter(Boolean)
        .sort((a, b) => a.duration - b.duration)
        .at(Math.floor(runs.length / 2)) ?? null;
    rows.push({
      label,
      app: scenario.app,
      width,
      name: scenario.name,
      kind: 'act',
      room: scenario.room === true,
      cls: median(runs.map((r) => r.cls)),
      inp: median(runs.map((r) => r.inp)),
      worst,
      sources: sources(runs.filter((r) => r.shifts)),
      errors: [...new Set(runs.flatMap((r) => r.errors))],
    });
  }
  for (const row of rows.slice(scenario.kind === 'load' ? -2 : -1))
    console.log(
      `${new Date().toISOString().slice(11, 19)} ${row.label}: CLS ${fmt.cls(row.cls)}${row.kind === 'load' ? `, LCP ${fmt.ms(row.lcp)}` : `, INP ${fmt.inp(row.inp, row)}`}${row.errors.length ? `  ! ${row.errors[0]}` : ''}`,
    );
}

const fmt = {
  cls: (value) => (value === null || value === undefined ? '—' : value.toFixed(3)),
  ms: (value) => (value === null || value === undefined ? '—' : `${Math.round(value)} ms`),
  /* An interaction the browser did not report took under its 16 ms floor; a Back by the browser's own button has none. */
  inp: (value, row) =>
    value === null || value === undefined
      ? row.errors.length
        ? '—'
        : row.name.startsWith('Back')
          ? "none (the browser's Back)"
          : 'under 16 ms'
      : `${Math.round(value)} ms`,
};

/** What is over budget, each with the measure and its limit; exceptions said beside it. */
function overBudget() {
  const over = [];
  for (const row of rows) {
    const base = `${row.app} ${row.width} ${row.name.replace(/, (cold|warm)$/, '')}`;
    const excused = EXCEPTIONS[base] ?? {};
    if (row.errors.length) over.push(`${row.label}: ${row.errors.join('; ')}`);
    if (row.cls !== null && row.cls > (excused.cls ?? BUDGET.cls))
      over.push(
        `${row.label}: CLS ${fmt.cls(row.cls)} over ${excused.cls ?? BUDGET.cls}${row.sources[0] ? ` (${row.sources[0].node})` : ''}`,
      );
    if (row.kind === 'load' && row.lcp !== null && row.lcp > (excused.lcp ?? BUDGET.lcp))
      over.push(`${row.label}: LCP ${fmt.ms(row.lcp)} over ${excused.lcp ?? BUDGET.lcp} ms (${row.lcpNode})`);
    const inp = excused.inp ?? (row.room ? BUDGET.inpRoom : BUDGET.inp);
    if (row.kind === 'act' && row.inp !== null && row.inp > inp)
      over.push(`${row.label}: INP ${fmt.ms(row.inp)} over ${inp} ms (${row.worst?.type} on ${row.worst?.target})`);
  }
  return over;
}

function markdown() {
  const cell = (text) => String(text).replaceAll('|', '\\|');
  const out = [
    `# Web Vitals, measured on the build`,
    '',
    `Median of ${RUNS} runs. Budgets: CLS ≤ ${BUDGET.cls}, LCP ≤ ${BUDGET.lcp} ms (loads), INP ≤ ${BUDGET.inp} ms (interactions; ${BUDGET.inpRoom} ms for one that starts a room over, marked ⇢; the CPU slowed to a quarter of the reference machine's: ` +
      `this one scored ${cpuSpeed.toFixed(1)} against ${REFERENCE_SPEED} and was slowed ${cpuRate.toFixed(1)}×${cpuSpeed < REFERENCE_SPEED / SLOWDOWN ? ', and is slower than the target even so' : ''}). ` +
      `Google's "good": CLS ≤ 0.1, LCP ≤ 2.5 s, INP ≤ 200 ms. ✗ marks a measure over our budget.`,
    '',
  ];
  for (const app of [...new Set(rows.map((r) => r.app))])
    for (const width of WIDTHS) {
      const mine = rows.filter((r) => r.app === app && r.width === width);
      if (!mine.length) continue;
      out.push(
        `## ${app}, ${width}px`,
        '',
        '| Page or interaction | CLS | LCP / INP | LCP element / slowest interaction | Shift sources (share of CLS, from → to) |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const row of mine) {
        const clsMark = row.cls !== null && row.cls > BUDGET.cls ? ' ✗' : '';
        const inpBudget = row.room ? BUDGET.inpRoom : BUDGET.inp;
        const time =
          row.kind === 'load'
            ? `LCP ${fmt.ms(row.lcp)}${row.lcp > BUDGET.lcp ? ' ✗' : ''}`
            : `INP ${fmt.inp(row.inp, row)}${row.inp > inpBudget ? ' ✗' : ''}`;
        const what =
          row.kind === 'load'
            ? row.lcpNode
            : row.worst
              ? `${row.worst.type} on ${row.worst.target} (delay ${Math.round(row.worst.delay)}, handlers ${Math.round(row.worst.handlers)}, paint ${Math.round(row.worst.paint)})`
              : '';
        const moved = row.sources.map((s) => `${s.node} ${s.value.toFixed(3)} (${s.from} → ${s.to || 'gone'})`).join('<br>');
        out.push(
          `| ${cell(row.name)}${row.room ? ' ⇢' : ''}${row.errors.length ? ` (${cell(row.errors[0])})` : ''} | ${fmt.cls(row.cls)}${clsMark} | ${time} | ${cell(what)} | ${cell(moved)} |`,
        );
      }
      out.push('');
    }
  return out.join('\n');
}

const servers = {};
async function stopServers() {
  await Promise.allSettled(Object.values(servers).map((server) => server?.stop()));
  rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  for (const [id, begin] of Object.entries(APPS))
    if (!ONLY || ONLY.includes(id)) {
      const server = await begin();
      if (server) servers[id] = server;
      else console.warn(`${id} is skipped: TABLEWALK_TEST_PG names no PostgreSQL server.`);
    }
  if (SERVE) {
    for (const [id, server] of Object.entries(servers)) console.log(id, server.origin);
    await new Promise((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    return;
  }
  const began = Date.now();
  const browser = await chromium.launch();
  cpuSpeed = await benchmark(browser);
  cpuRate = Math.max(1, (SLOWDOWN * cpuSpeed) / REFERENCE_SPEED);
  console.log(`CPU: ${cpuSpeed.toFixed(1)} rounds/ms (reference ${REFERENCE_SPEED}); interactions slowed ${cpuRate.toFixed(1)}×.`);
  try {
    /* Each server answers once before anything is measured: "cold" is a
       browser that has never seen the App, not a process whose first query
       is still compiling its statements. */
    for (const [id, server] of Object.entries(servers)) {
      const first = SCENARIOS.find((scenario) => scenario.app === id && scenario.kind === 'load');
      if (!first) continue;
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(server.origin + (typeof first.path === 'function' ? first.path(server.fixture) : first.path)).catch(() => {});
      await settle(page, 200);
      await context.close();
    }
    for (const width of WIDTHS)
      for (const scenario of SCENARIOS) {
        if (!servers[scenario.app] || (width < 600 && scenario.phone === false)) continue;
        if (FILTER && !`${scenario.app} ${scenario.name}`.includes(FILTER)) continue;
        await runScenario(browser, scenario, width);
      }
  } finally {
    await browser.close();
  }
  console.log(`Measured in ${Math.round((Date.now() - began) / 1000)} s.`);
  if (REPORT) writeFileSync(REPORT, markdown());
  const all = overBudget();
  const advisory = ADVISORY_INP ? all.filter((line) => /: INP /.test(line)) : [];
  const over = all.filter((line) => !advisory.includes(line));
  if (advisory.length) console.log(`\nINP over budget (advisory here):\n  ${advisory.join('\n  ')}`);
  if (over.length) console.log(`\nOver budget:\n  ${over.join('\n  ')}`);
  if (PRINT) return;
  assert.deepEqual(over, [], 'Web Vitals over budget');
  console.log(
    `Web Vitals within budget: CLS ≤ ${BUDGET.cls}, LCP ≤ ${BUDGET.lcp} ms, INP ≤ ${BUDGET.inp} ms (${BUDGET.inpRoom} ms starting a room over).`,
  );
}

try {
  await main();
} finally {
  await stopServers();
}
