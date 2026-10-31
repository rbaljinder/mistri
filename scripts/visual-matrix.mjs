#!/usr/bin/env node
/**
 * The visual review matrix: every Storybook story and a set of real sample-App
 * pages, in every built-in look, light and dark, at a desk and on a phone. An
 * App's page is also seen in the App's own look (the `default` column: no
 * look chosen, so Payday's, Forecourt's and Compass's own themes), dark on a
 * phone, and whole: the window is made as tall as the room, so what is below
 * the fold is reviewed too.
 *
 * The browser suite asserts behaviour and a few measured rules; it does not
 * look at a page. One afternoon of looking found a dozen shared defects that
 * nearly seven hundred passing tests had walked past, so a release now looks
 * too. This writes what it saw to `.visual/` (gitignored):
 *
 *   .visual/current/…png   this run's captures
 *   .visual/baseline/…png  the captures a later run is compared with (--baseline)
 *   .visual/index.html     one page to review: every subject as a sheet of
 *                          looks × variants, changed images first, each with
 *                          its baseline and a diff
 *
 * The baseline is local, never committed: fifteen hundred screenshots are not
 * source, and fonts differ between machines. Compare on one machine.
 *
 * It starts its own Apps (Lintel, Ladle and Tick, the public examples; the fixtures Compass, Thread,
 * Forecourt, Payday, Depot, Commons and Parcel; and Ignition when `TABLEWALK_TEST_PG` names a PostgreSQL server), each seeded
 * into a fresh temporary directory and read against one pinned clock, so "last
 * 30 days" means the same rows on every run. Compass is served writable and
 * signed out of nothing, so its New form, a working lead's actions and a
 * field in edit are captured as states of their own. Storybook is not
 * started here: run `npx storybook dev -p 6006` in storybook/, or pass
 * --only apps.
 *
 *   node scripts/visual-matrix.mjs                  capture and compare
 *   node scripts/visual-matrix.mjs --baseline       capture and keep as the baseline
 *   node scripts/visual-matrix.mjs --only stories   (or apps)
 *   node scripts/visual-matrix.mjs --looks mono,sage --filter record
 *   node scripts/visual-matrix.mjs --styles --filter lintel/,tick/   (a filter is one or more substrings, by commas)
 *   node scripts/visual-matrix.mjs --smoke --only apps
 *   node scripts/visual-matrix.mjs --smoke --only apps --shard 2/6
 *   node scripts/visual-matrix.mjs --smoke --only apps --density compact,comfortable --targets
 *   node scripts/visual-matrix.mjs --only apps --filter lintel/ --serve   (start, sign in, wait: .visual/serve.json)
 *
 * `--shard k/n` runs the k-th of n parts, split by App (so a part seeds and
 * starts only its own Apps) and packed by page count: on CI the smoke rides
 * along every browser shard instead of adding twenty minutes to one.
 * `--smoke` is CI's: every page in every look renders without a page error
 * and without the page scrolling sideways, or the run fails. It keeps no
 * baseline, compares nothing (pixel baselines need one machine's fonts) and
 * takes no pictures, and it reads each page at a desk in light and on a phone
 * in dark only: the two widths and the two modes, at half the captures.
 *
 * `--tokens` (`npm run test:tokens`) reads the same App pages, at the smoke's
 * two variants, under four canary themes (scripts/token-canary.mjs): every
 * role a color of its own, so a color a page draws that is not a role, a role
 * faded or two mixed is a literal no App's theme can reach, and the run fails
 * naming the element. It takes no pictures either.
 *
 * `--styles` reads the same App pages in every look and all four variants and
 * keeps, for each, a fingerprint of every element's computed style (and its
 * ::before and ::after where drawn) under .visual/styles: with `--baseline`
 * as the baseline, else compared with it, naming each element and property
 * that moved. It is how a change meant to leave every look as it was — a
 * cascade move, a token renamed, a default given a name — is shown to.
 *
 *   node scripts/visual-matrix.mjs --styles --baseline   before the change
 *   node scripts/visual-matrix.mjs --styles              after it: exits 1 on any difference
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { register } from 'tsx/esm/api';
import { selectVisualApps } from './visual-selection.mjs';

/* Parcel and Ignition start the way their browser specs start them
   (e2e/support), which are TypeScript. */
register();
// After register(): the canaries are compiled by the TypeScript the server compiles a theme with.
const { CANARY_LOOKS, FIXED_TOKENS, canaryMoves, canaryTheme, tokenProbe } = await import('./token-canary.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Every App server this starts inherits it, as the browser specs' do (playwright.config.ts): a page per look signs in
   from 127.0.0.1 hundreds of times, so Better Auth's per-address limits are lifted on a loopback server. */
process.env.MISTRI_TEST_AUTH_LIMITS ??= 'off';
export const OUT = join(ROOT, '.visual');
export const LOOKS = ['workshop', 'lumen', 'mono', 'sage', 'ledger'];
/* An App's own look: nothing chosen, so the App's `ui.theme` is what draws.
   Stories have no App, so no such column. */
export const APP_DEFAULT = 'default';
/* The seeded Apps' "today" (e2e/support/fixtures.ts, CRM_CLOCK): the server
   reads date phrases against it and the page's clock is set to it. */
const TODAY = '2026-09-04';
const CLOCK = `${TODAY}T16:00:00.000Z`;
export const VARIANTS = [
  { key: 'light-desk', mode: 'light', width: 1280, height: 1000, smoke: true },
  { key: 'dark-desk', mode: 'dark', width: 1280, height: 1000 },
  /* A phone is a touch screen: without `hasTouch` the page matched `(hover: hover)` and `(pointer: fine)`, so a
     queue's Review waited for a hover no phone has and a thumb's 44px rows were never drawn. */
  { key: 'light-phone', mode: 'light', width: 390, height: 844, touch: true },
  // Dark on a phone was never seen: the drawer, the sheet and a card's dark ground.
  { key: 'dark-phone', mode: 'dark', width: 390, height: 844, touch: true, apps: true, smoke: true },
  /* Reflow (WCAG 1.4.10): a 640px window at 200% zoom is 320 CSS pixels at twice the density. Its only look is the
     App's own — the cost is one load per App page, not one per look — and the smoke's sideways-scroll check is the
     point: a label, a figure or a step's row that will not wrap shows up here first. */
  { key: 'reflow-320', mode: 'light', width: 320, height: 640, scale: 2, touch: true, apps: true, appLookOnly: true, smoke: true },
];
/* A room is captured whole, up to this tall: past it, a list is its pager's job. */
const TALLEST = 4000;
/* A pixel counts as changed past this much in any channel: anti-aliasing
   moves a channel by a few steps between two captures of the same page. */
const CHANNEL_TOLERANCE = 24;
/* Changed pixels at or under this many are not reported (see compare). */
const NOISE_PIXELS = 50;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tokens = flag('--tokens');
const styles = flag('--styles');
const only = tokens || (styles && !option('--only')) ? 'apps' : option('--only');
const looks = option('--looks')?.split(',') ?? (tokens ? CANARY_LOOKS : [APP_DEFAULT, ...LOOKS]);
// The token run is a smoke run that reads colors: no pictures, the smoke's two variants.
const smoke = flag('--smoke') || tokens || styles;
// A style fingerprint reads every variant: a token that moves only by night or only on a phone is a difference too.
const variants = VARIANTS.filter((variant) => !smoke || variant.smoke || styles);
const filter = option('--filter');
const storybook = process.env.STORYBOOK_URL ?? 'http://localhost:6006';
const concurrency = Number(option('--jobs') ?? 4);
const [shardAt, shardOf] = (option('--shard') ?? '1/1').split('/').map(Number);
/* `--density compact,comfortable` reads every App page again at each density a person may save, which wins over the
   look's start: comfortable zooms the page by 1.12, and Lintel's rent roll scrolled sideways only there. */
const densities = option('--density')?.split(',') ?? [undefined];

/** The Apps of part `shardAt` of `shardOf`: heaviest first, each to the lightest part. */
function shardApps(list) {
  if (shardOf <= 1) return list;
  const weight = (app) => (app.signedOut?.length ?? 0) + app.pages.length;
  const parts = Array.from({ length: shardOf }, () => ({ load: 0, apps: [] }));
  for (const app of [...list].sort((a, b) => weight(b) - weight(a) || a.id.localeCompare(b.id))) {
    const lightest = parts.reduce((low, part) => (part.load < low.load ? part : low));
    lightest.apps.push(app);
    lightest.load += weight(app);
  }
  return parts[shardAt - 1].apps;
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function answering(url, seconds = 90, server) {
  for (let i = 0; i < seconds * 2; i++) {
    if (server && (server.exitCode !== null || server.signalCode !== null)) return false;
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function run(command, commandArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${commandArgs.join(' ')}: ${err.trim()}`))));
  });
}

/** One sample App: seeded into `dir`, served on a port of its own until the run ends. */
export async function startApp(dir, app) {
  if (app.start) return { ...app, ...(await app.start(dir)) };
  const port = await freePort();
  const db = join(dir, `${app.id}.db`);
  await app.seed(db);
  const env = {
    TABLEWALK_CLOCK: CLOCK,
    MISTRI_CLOCK: CLOCK,
    XDG_CONFIG_HOME: join(dir, `${app.id}-auth`),
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    MISTRI_AUTH_ADMIN_EMAIL: 'review@example.invalid',
    MISTRI_AUTH_ADMIN_PASSWORD: randomBytes(18).toString('base64url'),
    ...app.env,
  };
  const server = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      `packages/${app.serve(db).includes('--app') ? 'mistri' : 'tablewalk'}/src/server/index.ts`,
      ...app.serve(db),
      '--port',
      String(port),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  /* The tail of what it said, so a server that dies mid-run says why rather than leaving connection refusals. */
  let said = '',
    stopping = false;
  server.stderr.on('data', (chunk) => {
    said = (said + chunk).slice(-16_384);
  });
  server.on('exit', (code, signal) => {
    if (!stopping)
      console.error(`\n${app.id}'s server exited (${signal ?? `code ${code}`}) mid-run:\n${said.trim() || '(nothing on stderr)'}\n`);
  });
  const origin = `http://127.0.0.1:${port}`;
  if (!(await answering(`${origin}/`, 90, server))) {
    stopping = true;
    server.kill();
    throw new Error(`${app.id} did not start on ${origin}: ${said.trim()}`);
  }
  return {
    ...app,
    origin,
    stop: async () => {
      stopping = true;
      server.kill();
    },
    admin: { email: env.MISTRI_AUTH_ADMIN_EMAIL, password: env.MISTRI_AUTH_ADMIN_PASSWORD },
  };
}

/* Network idle, less the page's two streams. A signed-in page holds live sync's `/api/live` open for as long as it is
   shown, and a watched App's page its reload stream (`/api/app/live`); a request that never ends never settles, so
   neither is waited for. Every other request is, as 'networkidle' waits: none in flight for half a second. Only the
   network's, as there: a `blob:` or `data:` load is the page reading its own memory, and Chromium does not always say
   when one finishes (Tick's done tab waited 30 s on a `blob:` that never did, three looks running). */
const inFlight = new WeakMap();
export function tracked(page) {
  const open = new Set();
  const waited = (request) => {
    const url = new URL(request.url());
    return /^https?:$/.test(url.protocol) && !/\/api\/(?:app\/)?live$/.test(url.pathname);
  };
  const started = [];
  page.on('request', (request) => {
    if (!waited(request)) return;
    open.add(request);
    started.push(new URL(request.url()).pathname);
  });
  page.on('requestfinished', (request) => open.delete(request));
  page.on('requestfailed', (request) => open.delete(request));
  inFlight.set(page, { open, started });
  return page;
}
/* 60 s, not 30: on a shared CI runner a public page's chain of photos, several pages at once, once kept requests
   overlapping for 30 s with nothing wrong. A page that never settles still fails, naming what kept it busy. */
export async function quiet(page, { idleMs = 500, timeout = 60_000 } = {}) {
  const tracking = inFlight.get(page);
  if (!tracking) throw new Error('quiet(page) needs a page made by tracked()');
  const { open, started } = tracking;
  const first = started.length;
  const deadline = Date.now() + timeout;
  let since = Date.now();
  while (Date.now() - since < idleMs) {
    if (Date.now() > deadline) {
      const during = started.slice(first);
      const busiest = [...Map.groupBy(during, (path) => path)].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
      throw new Error(
        `the page's network did not go quiet in ${timeout} ms: ${during.length} requests began while waiting` +
          ` (${busiest.map(([path, hits]) => `${path} ×${hits.length}`).join(', ')}); in flight: ${[...open].map((request) => request.url()).join(', ') || 'none'}`,
      );
    }
    if (open.size) since = Date.now();
    await delay(50);
  }
}
export async function settledGoto(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await quiet(page);
}

/* A state a page is put in after it loads: a form open, a field in edit. */
export const click = (name) => async (page) => {
  await page
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .click();
  await quiet(page);
};

/** Ignition's dealership, entered the way its specs enter it: signed in, then the tenant chosen. */
async function startIgnitionApp() {
  const { startIgnition, DEALERS } = await import('../e2e/support/ignitionServer.ts');
  const session = await import('../e2e/support/ignitionSession.ts');
  const fixture = await startIgnition();
  /* A navigation throws the tab's chosen tenant away, so every capture
     enters afresh and walks to its room by the menu (ignitionSession.ts).
     Each entry opens a context the server keeps for its dormant window, and
     an account holds at most 32 (tenantContexts.ts): the matrix opens up to
     96, so it enters as each active dealership's administrator in turn —
     the same role and the same rooms, every dealer holding lead L-2001. */
  const dealers = [DEALERS.north, DEALERS.harbor, DEALERS.valley].map((dealer) => ({
    dealer,
    email: fixture.account('dealer_admin', dealer).email,
  }));
  let entries = 0;
  const into = (room, row) => async (page) => {
    const { dealer, email } = dealers[entries++ % dealers.length];
    await session.enter(page, fixture, email, dealer);
    if (room) await session.openRoom(page, room);
    if (row) await session.openRow(page, row, true);
  };
  /* A tenant lease is judged against the server's real clock (sessionIdentity.ts), so a tab frozen at the
     matrix's day, earlier than the server's, reads its lease as not yet begun and never shows a room. */
  return {
    origin: fixture.origin,
    stop: () => fixture.stop(),
    liveClock: true,
    pages: [
      ['home', into()],
      ['leads', into('lead')],
      ['lead', into('lead', 'L-2001')],
    ],
  };
}

export const APPS = [
  {
    id: 'compass',
    seed: (db) => run(process.execPath, ['test/fixtures/databases/crm/make-crm-db.mjs', db], { MISTRI_CRM_TODAY: TODAY }),
    /* Writable, as a team runs it: served read-only, New, a record's actions
       and editing were never drawn. Lead 11 is being worked, not converted. */
    serve: (db) => {
      writeFileSync(`${db}.json`, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));
      return ['--config', `${db}.json`, '--app', 'test/fixtures/apps/crm'];
    },
    pages: [
      ['dashboard', '/'],
      ['list', '/leads'],
      ['record', '/leads/~11'],
      // A deal: the stepper over the summary, the aside's card, tabs of related rows.
      ['opportunity', '/opportunities/~2'],
      ['calendar', '/task-calendar'],
      ['new', '/leads', click('+ New lead')],
      ['editing', '/leads/~11', click(/^Edit /)],
    ],
  },
  {
    id: 'thread',
    seed: (db) => run(process.execPath, ['test/fixtures/databases/thread/seed.mjs', db]),
    serve: (db) => ['--config', `${db}.json`, '--app', 'test/fixtures/apps/thread'],
    pages: [
      ['home', '/'],
      ['list', '/issues'],
      ['board', '/board'],
      ['planning', '/planning'],
    ],
  },
  /* Signed out, the marketplace a buyer browses; signed in as the
     administrator, the desk. Seeded against the matrix's own day. */
  {
    id: 'forecourt',
    seed: (db) => run(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/forecourt/seed.mjs', db], { FORECOURT_TODAY: TODAY }),
    serve: (db) => [
      '--config',
      `${db}.json`,
      '--app',
      'test/fixtures/apps/forecourt-market',
      '--commands',
      'test/fixtures/apps/forecourt-market/commands.ts',
      '--policy',
      'test/fixtures/apps/forecourt-market/policy.ts',
    ],
    signedOut: [
      ['sign-in', '/sign-in'],
      ['landing', '/'],
      ['cards', '/vehicles'],
      ['refined', '/vehicles?body_type=SUV&price=..30000&sort=price'],
      ['record', '/vehicles/1'],
    ],
    pages: [
      ['desk', '/'],
      ['pipeline', '/pipeline'],
      ['inquiry', '/inquiries/1'],
      ['stock', '/stock'],
    ],
  },
  {
    id: 'payday',
    seed: (db) => run(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/payday/seed.mjs', db]),
    serve: (db) => ['--config', `${db}.json`, '--app', 'test/fixtures/apps/payday', '--commands', 'test/fixtures/apps/payday/commands.ts'],
    signedOut: [['sign-in', '/']],
    pages: [
      ['home', '/'],
      ['people', '/people'],
      ['record', '/people/~1'],
    ],
  },
  /* Signed in as its administrator (a manager), dated to the matrix's "today". */
  {
    id: 'depot',
    seed: (db) => run(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/depot/seed.mjs', db], { DEPOT_TODAY: TODAY }),
    serve: (db) => ['--config', `${db}.json`, '--app', 'test/fixtures/apps/depot', '--commands', 'test/fixtures/apps/depot/commands.ts'],
    signedOut: [['sign-in', '/']],
    pages: [
      ['home', '/'],
      ['pick-lists', '/pick-lists'],
      ['products', '/products'],
      ['catalog', '/catalog'],
      ['product', '/products/~42'],
      ['purchasing', '/purchasing'],
    ],
  },
  /* Signed out, the forum as a visitor reads it; signed in as the bootstrapped
     administrator, a moderator's health dashboard and queue. Seeded against
     the matrix's own day, so "last 30 days" is the same rows every run. */
  {
    id: 'commons',
    seed: (db) => run(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/commons/seed.mjs', db], { COMMONS_TODAY: TODAY }),
    serve: (db) => [
      '--config',
      `${db}.json`,
      '--app',
      'test/fixtures/apps/commons',
      '--commands',
      'test/fixtures/apps/commons/commands.ts',
    ],
    signedOut: [
      ['sign-in', '/sign-in'],
      ['landing', '/'],
      ['latest', '/latest'],
      ['thread', '/latest/~42'],
      ['post', '/@post~205'],
      ['members', '/members'],
      ['member', '/members/~5'],
    ],
    pages: [
      ['health', '/'],
      ['queue', '/queue'],
    ],
  },
  /* The flagship: what a visitor reads signed out, and the office's rooms
     signed in as its administrator, who holds every role. */
  {
    id: 'lintel',
    /* Seeded for the real day, not TODAY: --jobs runs the lease clock on the server's real clock, which ends a lease
       whose notice has run out, so homes seeded "on notice" for September were turnover by October and the tab was empty. */
    seed: async (db) => {
      await run(process.execPath, ['--import', 'tsx', 'examples/databases/lintel/seed.mjs', db], {
        LINTEL_TODAY: new Date().toISOString().slice(0, 10),
      });
      // The hard names and a ledger past a thousand rows, so the matrix's reflow and phone shots meet them.
      await run(process.execPath, ['examples/databases/lintel/worst-case.mjs', db]);
    },
    env: { LINTEL_MAIL_SECRET: randomBytes(24).toString('base64url'), PAYMENT_CALLBACK_SECRET: randomBytes(16).toString('hex') },
    serve: (db) => [
      '--config',
      `${db}.json`,
      '--app',
      'examples/apps/lintel',
      '--jobs',
      'examples/apps/lintel/jobs.ts',
      '--policy',
      'examples/apps/lintel/policy.ts',
    ],
    signedOut: [
      ['sign-in', '/sign-in'],
      ['listings', '/listings'],
    ],
    pages: [
      ['today', '/today'],
      ['units', '/units'],
      ['leases', '/leases'],
      ['ledger', '/ledger'],
      ['repair-board', '/repair-board'],
      ['occupancy', '/occupancy'],
      ['lease', '/leases/1'],
      ['resident', '/residents/1'],
      // examples/databases/lintel/worst-case.mjs: the 58-character hyphenated name, and 1,100 charges on one lease.
      ['residents', '/residents'],
      ['worst-resident', '/residents/9001'],
      ['worst-lease', '/leases/9001'],
    ],
  },
  /* The general-path sample's staff App, served on its own: its host, the school's React site, is not a page of
     tablewalk's to picture. Signed in as its administrator; the check-in page on tonight's class. */
  {
    id: 'ladle',
    seed: (db) => run(process.execPath, ['examples/databases/ladle/seed.mjs', db]),
    serve: (db) => ['--config', `${db}.json`, '--app', 'examples/apps/ladle'],
    signedOut: [['sign-in', '/sign-in']],
    pages: [
      ['classes', '/'],
      ['bookings', '/bookings'],
      ['check-in', '/check-in?class=2'],
    ],
  },
  {
    id: 'tick',
    seed: (db) => run(process.execPath, ['examples/databases/tick/seed.mjs', db]),
    serve: (db) => ['--config', `${db}.json`, '--app', 'examples/apps/tick'],
    pages: [
      ['tasks', '/'],
      ['done', '/?tab=done'],
    ],
  },
  {
    id: 'parcel',
    start: async () => {
      const { startParcel } = await import('../e2e/support/httpSourceServer.ts');
      return startParcel();
    },
    pages: [
      ['shipments', '/'],
      ['carriers', '/carriers'],
      ['carrier', '/@carrier~car-01'],
    ],
  },
  /* Read by `--styles` only: the rooms `npm run smoke` walks — the database browser over the built-in demo, which
     wears no look and so is read once, and the App the smoke opens over it — so a refactor of the shared sheets is
     proven on the Workbench too. A release's pictures are of the sample Apps. */
  {
    id: 'workbench',
    stylesOnly: true,
    looks: [APP_DEFAULT],
    seed: async () => {},
    serve: () => ['--demo', '--no-config'],
    pages: [
      ['landing', '/demo'],
      ['table', '/demo/invoice'],
      ['record', '/demo/invoice/~1'],
    ],
  },
  {
    id: 'fieldops',
    stylesOnly: true,
    seed: async () => {},
    serve: () => ['--demo', '--app', 'test/fixtures/apps/fieldops', '--no-config'],
    pages: [
      ['home', '/'],
      ['work-orders', '/work-orders'],
      ['work-order', '/work-orders/1'],
    ],
  },
  /* PostgreSQL-only, and two-realm: run where a server is named, and said
     skipped where not, as its browser specs do. */
  ...(process.env.TABLEWALK_TEST_PG ? [{ id: 'ignition', start: startIgnitionApp, pages: [] }] : []),
];

/** A session for an App that signs people in: its bootstrapped administrator. */
export async function signIn(browser, app) {
  const context = await browser.newContext();
  try {
    const page = tracked(await context.newPage());
    await settledGoto(page, `${app.origin}${app.signedOut[0][1]}`);
    await page.getByLabel('Email').fill(app.admin.email);
    await page.getByLabel('Password', { exact: true }).fill(app.admin.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // A signed-in page reloads itself; the form is gone once the session holds.
    await page.getByLabel('Password', { exact: true }).waitFor({ state: 'detached', timeout: 20_000 });
    await quiet(page);
    /* The bootstrapped account is named for its address ("review"); a person
       reviewing Depot's "Hello, {me.name}" should read a person's name there,
       given the way any account gives one (Better Auth's own update-user). */
    const named = await page.request.post(`${app.origin}/api/auth/update-user`, {
      headers: { origin: app.origin },
      data: { name: 'Morgan Reyes' },
    });
    if (!named.ok()) throw new Error(`${app.id}: naming the review account answered ${named.status()}.`);
    const state = await context.storageState();
    if (!state.cookies.length) throw new Error(`${app.id}: signing in left no session cookie.`);
    return state;
  } finally {
    await context.close();
  }
}

/** Every shot this run takes: subject × look × variant. */
async function subjects(apps) {
  const list = [];
  if (only !== 'apps') {
    let index;
    try {
      index = await (await fetch(`${storybook}/index.json`)).json();
    } catch {
      index = null;
    }
    if (!index) console.warn(`Storybook is not answering at ${storybook}; stories are skipped.`);
    for (const entry of Object.values(index?.entries ?? {})) {
      if (entry.type !== 'story') continue;
      list.push({
        group: 'stories',
        name: entry.id,
        url: (look, mode) => `${storybook}/iframe.html?id=${entry.id}&viewMode=story&globals=look:${look};mode:${mode}`,
      });
    }
  }
  for (const app of apps) {
    for (const [name, path, act, signedIn] of [
      ...(app.signedOut ?? []).map(([name, path]) => [name, path, undefined, false]),
      ...app.pages.map(([name, path, act]) => [name, path, act, Boolean(app.signedOut)]),
    ]) {
      /* A page is an address, or — where an address cannot say it (a
         tenant chosen in the tab) — the steps that reach it. */
      list.push({
        group: app.id,
        name,
        app,
        signedIn,
        act,
        ...(typeof path === 'function' ? { reach: path, url: () => `${app.origin}/` } : { url: () => `${app.origin}${path}` }),
      });
    }
  }
  return list.filter((subject) => !filter || filter.split(',').some((part) => `${subject.group}/${subject.name}`.includes(part)));
}

/**
 * Runs in the page (`--styles`): every element's computed style, its ::before and ::after where they are drawn, as a
 * fingerprint — one hash per element, by its place in the tree, and one per property over every element — so a
 * comparison names what moved without keeping megabytes of values. Custom properties are not compared: a token
 * renamed or newly named draws the same, and what it draws is what is read.
 */
function styleProbe() {
  const hash = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };
  const elements = {};
  const properties = {};
  const read = (style, prefix) => {
    const out = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (!name.startsWith('--')) out.push([`${prefix}${name}`, style.getPropertyValue(name)]);
    }
    return out;
  };
  const walk = (el, path) => {
    if (el.matches('script, style, link, template')) return;
    let all = read(globalThis.getComputedStyle(el), '');
    for (const pseudo of ['::before', '::after']) {
      const drawn = globalThis.getComputedStyle(el, pseudo);
      if (drawn.content !== 'none' && drawn.content !== 'normal') all = all.concat(read(drawn, pseudo));
    }
    elements[path] = hash(all.map(([name, value]) => `${name}:${value}`).join(';'));
    for (const [name, value] of all) properties[name] = hash(`${properties[name] ?? ''}|${path}=${value}`);
    [...el.children].forEach((child, index) => walk(child, `${path}.${index}`));
  };
  walk(globalThis.document.body, 'body');
  return { elements, properties };
}

/**
 * Runs in the page: every box inside the room that scrolls sideways — a card, a section, a related list, a
 * dashboard's table, the list itself. The page's own sideways scroll is the smoke's other check. A box whose job
 * is a row that scrolls (a phone's control strip, a board's lanes, a timeline) says so with
 * `data-scrolls`, and is not counted (docs/design.md, Standing layout rules).
 */
function sidewaysProbe() {
  const document = globalThis.document;
  const room = document.querySelector('#content, .content, .page-body, .public-page') ?? document.body;
  const found = [];
  for (const element of room.querySelectorAll('*')) {
    const over = element.scrollWidth - element.clientWidth;
    if (over <= 1 || element.clientWidth === 0) continue;
    if (!/auto|scroll/.test(globalThis.getComputedStyle(element).overflowX)) continue;
    if (element.closest('[data-scrolls]')) continue;
    const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList]
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join('')}`;
    const section = element.closest('section, [data-section], .card')?.querySelector('h2, h3, .section-title')?.textContent?.trim();
    found.push(`${name}${section ? ` in "${section.slice(0, 40)}"` : ''} scrolls sideways by ${over}px`);
  }
  return found;
}

/**
 * Runs in the page (`--targets`): every control smaller than 24px either way that has no 24px of its own around it
 * (WCAG 2.5.8, docs/design.md Access). A link inside a line of text is exempt, as the criterion exempts it.
 */
function targetProbe() {
  const document = globalThis.document;
  const found = [];
  const controls = document.querySelectorAll(
    'button, a[href], input:not([type=hidden]), select, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option]',
  );
  /* A control may reach past its box through an absolutely placed ::before (a nav group's fold, a chip's ×): that is
     where a pointer lands, so it is what is measured. */
  const reach = (element) => {
    const box = element.getBoundingClientRect();
    let { left, top, right, bottom } = box;
    for (const pseudo of ['::before', '::after']) {
      const style = globalThis.getComputedStyle(element, pseudo);
      if (style.content === 'none' || style.position !== 'absolute') continue;
      const px = (value) => (value.endsWith('px') ? Number.parseFloat(value) : 0);
      left = Math.min(left, box.left + px(style.left));
      top = Math.min(top, box.top + px(style.top));
      right = Math.max(right, box.right - px(style.right));
      bottom = Math.max(bottom, box.bottom - px(style.bottom));
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const boxes = [...controls]
    .map((element) => ({ element, box: reach(element) }))
    .filter(({ element, box }) => box.width > 0 && box.height > 0 && globalThis.getComputedStyle(element).visibility !== 'hidden');
  for (const { element, box } of boxes) {
    if (box.width >= 24 && box.height >= 24) continue;
    if (element.closest('[inert], [aria-hidden="true"]')) continue;
    const style = globalThis.getComputedStyle(element);
    if (element.tagName === 'A' && style.display === 'inline' && element.parentElement?.textContent?.trim() !== element.textContent?.trim())
      continue;
    // The spacing exception: a 24px circle on the target's centre meets no other target.
    const cx = box.left + box.width / 2,
      cy = box.top + box.height / 2;
    const crowded = boxes.some(
      (other) =>
        other.element !== element &&
        !other.element.contains(element) &&
        !element.contains(other.element) &&
        Math.max(other.box.left - cx, 0, cx - other.box.right) ** 2 + Math.max(other.box.top - cy, 0, cy - other.box.bottom) ** 2 < 144,
    );
    if (!crowded) continue;
    const name = `${element.tagName.toLowerCase()}${[...element.classList]
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('')}`;
    const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24);
    found.push(`${name}${label ? ` "${label}"` : ''} is ${Math.round(box.width)}×${Math.round(box.height)}`);
  }
  return [...new Set(found)];
}

export async function capture(browser, subject, look, variant, sessions, density) {
  const origin = subject.app?.origin;
  const state = subject.signedIn ? sessions.get(subject.app.id) : { cookies: [], origins: [] };
  const opening = Date.now();
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    ...(variant.scale ? { deviceScaleFactor: variant.scale } : {}),
    hasTouch: Boolean(variant.touch),
    colorScheme: variant.mode,
    reducedMotion: 'reduce',
    storageState: origin
      ? {
          ...state,
          origins: [
            {
              origin,
              localStorage: [
                { name: 'mistri.tour.v1', value: 'done' },
                ...(look === APP_DEFAULT || tokens ? [] : [{ name: 'mistri.visual-theme', value: look }]),
                ...(density ? [{ name: 'mistri.density', value: density }] : []),
              ],
            },
          ],
        }
      : undefined,
  });
  const contextMs = Date.now() - opening;
  try {
    const page = tracked(await context.newPage());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const canary = tokens ? canaryTheme(look) : undefined;
    /* A page read twice over is slower than a smoke's look, and the gate is the colors, not the clock. Every page
       waits for a quiet network, and an App's first public pages are served from source by a cold Vite: Forecourt's
       cards and Lintel's listings took 14s alone and passed 30s with four looks loading at once, which says nothing
       about a page a visitor fetches built. */
    page.setDefaultNavigationTimeout(canary ? 120_000 : 60_000);
    if (canary) {
      /* The App wears the canary as its own theme: its payload names it, and the copy the first paint carries is
         dropped so the page asks for the one answered here (e2e/support/harness.ts does the same). */
      await page.addInitScript(() => {
        const remove = () => globalThis.document.getElementById('mistri-first-paint')?.remove();
        const observer = new globalThis.MutationObserver(remove);
        observer.observe(globalThis.document, { childList: true, subtree: true });
        globalThis.document.addEventListener('DOMContentLoaded', () => (remove(), observer.disconnect()), { once: true });
      });
      await page.route(/\/api\/app(?:\?|$)/, async (route) => {
        const response = await route.fetch();
        const payload = await response.json().catch(() => undefined);
        if (!payload?.app?.ui) return route.fulfill({ response });
        payload.app.ui.customThemes = [...(payload.app.ui.customThemes ?? []), canary];
        payload.app.ui.theme = { preset: canary.id };
        return route.fulfill({ response, json: payload });
      });
      // Signed out, the App's look rides who-am-I (the sign-in page, a tenant chooser) instead.
      await page.route(/\/api\/whoami(?:\?|$)/, async (route) => {
        const response = await route.fetch();
        const me = await response.json().catch(() => undefined);
        for (const look of [me?.look, me?.signIn?.look]) {
          if (!look || typeof look !== 'object') continue;
          look.customThemes = [...(look.customThemes ?? []), canary];
          look.theme = { ...look.theme, preset: canary.id };
        }
        return me ? route.fulfill({ response, json: me }) : route.fulfill({ response });
      });
    }
    if (!subject.app?.liveClock) await page.clock.setFixedTime(new Date(CLOCK));
    const navigation = Date.now();
    if (subject.reach) await subject.reach(page);
    else await settledGoto(page, subject.url(look, variant.mode));
    if (subject.act) await subject.act(page);
    const navigationMs = Date.now() - navigation;
    const fontsStarted = Date.now();
    await page.evaluate(() => globalThis.document.fonts.ready);
    const fontsMs = Date.now() - fontsStarted;
    // The fixed settling delay belongs to screenshot review, not the smoke
    // gate: smoke already waits for navigation and fonts and takes no picture.
    if (!smoke) await page.waitForTimeout(300);
    /* A page that focuses its first field (sign-in, a list's filter) does so a
       moment after load, so its ring came and went between runs. Focus is
       reviewed in the primitives' focus stories, not here. */
    await page.evaluate(() =>
      globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement.blur() : undefined,
    );
    // The page never scrolls sideways (docs/design.md): a wide thing scrolls in its own box.
    const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
    if (overflow > 1) errors.push(`the page scrolls sideways by ${overflow}px`);
    // Nor does a card, a section or a table inside it (docs/design.md): a table fits, wraps, or leaves columns out.
    if (origin) errors.push(...(await page.evaluate(sidewaysProbe)));
    if (origin && flag('--targets')) errors.push(...(await page.evaluate(targetProbe)).map((target) => `target ${target}`));
    // A section its error boundary caught raises no page error; its mark is the signal.
    const caught = await page.locator('[data-section-error]').count();
    if (caught) errors.push(`${caught} section(s) could not be drawn`);
    if (canary) {
      const worn = await page.evaluate(() => globalThis.document.documentElement.dataset.visualTheme);
      if (worn !== canary.id) errors.push(`the page wears ${worn ?? 'no theme'}, not ${canary.id}`);
      else errors.push(...(await page.evaluate(tokenProbe, { moves: canaryMoves(variant.mode), tolerance: 3, fixed: FIXED_TOKENS })));
    }
    if (styles) {
      const file = join(OUT, 'styles', 'current', subject.group, subject.name, `${look}-${variant.key}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(await page.evaluate(styleProbe)));
      return { errors, styles: file, timing: { contextMs, navigationMs, fontsMs } };
    }
    if (smoke) return { errors, timing: { contextMs, navigationMs, fontsMs } };
    /* The whole room. An App is a fixed shell whose pane scrolls, so a
       full-page screenshot is still one window: the window is made as tall as
       the pane's content instead, and the layout fills it as it would a tall
       screen. */
    if (origin) {
      const below = await page.evaluate(() =>
        Math.max(
          0,
          ...[...globalThis.document.querySelectorAll('#content, .content, .page-body, .newpanel-body')].map(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        ),
      );
      if (below > 0) {
        await page.setViewportSize({ width: variant.width, height: Math.min(TALLEST, variant.height + below) });
        await page.waitForTimeout(300);
      }
    }
    await page.waitForTimeout(100);
    const file = join(OUT, 'current', subject.group, subject.name, `${look}-${variant.key}${density ? `-${density}` : ''}.png`);
    mkdirSync(dirname(file), { recursive: true });
    /* A page is captured once it has stopped moving: two shots a moment apart
       that agree, as Playwright's own screenshot assertion does. A filter rail
       settled a pixel lower on some runs, after "network idle". */
    let shot = await page.screenshot({ caret: 'hide', animations: 'disabled' });
    for (let tries = 0; tries < 6; tries++) {
      await page.waitForTimeout(250);
      const again = await page.screenshot({ caret: 'hide', animations: 'disabled' });
      if (again.equals(shot)) break;
      shot = again;
    }
    writeFileSync(file, shot);
    return { file, errors };
  } finally {
    await context.close();
  }
}

/** Changed pixels between two captures, and a diff image, measured in a page:
    the browser decodes PNG, so the matrix needs no image library. */
async function compare(page, before, after) {
  const url = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  return page.evaluate(
    async ([a, b, tolerance, noise]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new globalThis.Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { ratio: 1, diff: null };
      const canvas = (image) => {
        const c = globalThis.document.createElement('canvas');
        c.width = image.width;
        c.height = image.height;
        const g = c.getContext('2d');
        g.drawImage(image, 0, 0);
        return g.getImageData(0, 0, c.width, c.height);
      };
      const p = canvas(x),
        q = canvas(y);
      const out = new globalThis.ImageData(p.width, p.height);
      const w = p.width,
        h = p.height;
      const near = (i, j) =>
        Math.abs(p.data[i] - q.data[j]) <= tolerance &&
        Math.abs(p.data[i + 1] - q.data[j + 1]) <= tolerance &&
        Math.abs(p.data[i + 2] - q.data[j + 2]) <= tolerance;
      /* Changed only if nothing within a pixel of it in the other capture
       matches, both ways round: at 1x a fractional top snaps to a different
       pixel from run to run, and that is not a change anyone can review. */
      const unmatched = (i) => {
        const x0 = (i / 4) % w,
          y0 = Math.floor(i / 4 / w);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x1 = x0 + dx,
              y1 = y0 + dy;
            if (x1 >= 0 && y1 >= 0 && x1 < w && y1 < h && near(i, (y1 * w + x1) * 4)) return false;
          }
        return true;
      };
      let changed = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        const moved = !near(i, i) && unmatched(i);
        if (moved) changed++;
        out.data[i] = moved ? 230 : q.data[i] * 0.25 + 190;
        out.data[i + 1] = moved ? 30 : q.data[i + 1] * 0.25 + 190;
        out.data[i + 2] = moved ? 60 : q.data[i + 2] * 0.25 + 190;
        out.data[i + 3] = 255;
      }
      const c = globalThis.document.createElement('canvas');
      c.width = p.width;
      c.height = p.height;
      c.getContext('2d').putImageData(out, 0, 0);
      // A few dozen pixels is a photograph's gradient dithering, not a change.
      if (changed <= noise) return { ratio: 0, diff: null };
      return { ratio: changed / (p.width * p.height), diff: c.toDataURL('image/png') };
    },
    [url(before), url(after), CHANNEL_TOLERANCE, NOISE_PIXELS],
  );
}

function report(results) {
  const rel = (file) => relative(OUT, file);
  const changed = results.filter((result) => result.ratio > 0).sort((a, b) => b.ratio - a.ratio);
  const errors = results.filter((result) => result.errors.length);
  const bySubject = new Map();
  for (const result of results) {
    const key = `${result.subject.group}/${result.subject.name}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(result);
  }
  const cell = (
    result,
  ) => `<figure class="${result.ratio > 0 ? 'moved' : ''}"><a href="${rel(result.file)}"><img loading="lazy" src="${rel(result.file)}"></a>
    <figcaption>${result.look} · ${result.variant.key}${result.baseline === undefined ? '' : result.ratio > 0 ? ` · <b>${(result.ratio * 100).toFixed(2)}% changed</b>` : ' · same'}</figcaption></figure>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Visual matrix</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #111; background: #f4f4f4; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 32px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(${VARIANTS.length}, minmax(0, 1fr)); gap: 8px; }
  figure { margin: 0; background: #fff; border: 1px solid #ddd; } figure.moved { border: 2px solid #d02040; }
  img { width: 100%; display: block; } figcaption { padding: 4px 6px; font-size: 12px; color: #444; }
  .pair { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
  .errors li { color: #b00020; }
</style>
<h1>Visual matrix — ${results.length} captures, ${changed.length} changed${errors.length ? `, ${errors.length} with page errors` : ''}</h1>
${errors.length ? `<ul class="errors">${errors.map((result) => `<li>${result.subject.group}/${result.subject.name} ${result.look} ${result.variant.key}: ${result.errors.join('; ')}</li>`).join('')}</ul>` : ''}
${
  changed.length
    ? `<h2>Changed since the baseline (baseline · now · diff)</h2>${changed
        .map(
          (
            result,
          ) => `<p>${result.subject.group}/${result.subject.name} — ${result.look} · ${result.variant.key} — ${(result.ratio * 100).toFixed(2)}%</p>
<div class="pair"><img loading="lazy" src="${rel(result.baseline)}"><img loading="lazy" src="${rel(result.file)}">${result.diff ? `<img loading="lazy" src="${result.diff}">` : '<p>Size changed.</p>'}</div>`,
        )
        .join('')}`
    : ''
}
<h2>Everything</h2>
${[...bySubject]
  .map(
    ([key, list]) =>
      `<h2>${key}</h2>${looks
        .map(
          (look) =>
            `<div class="grid">${VARIANTS.map((variant) => {
              const result = list.find((item) => item.look === look && item.variant === variant);
              return result ? cell(result) : '<div></div>';
            }).join('')}</div>`,
        )
        .join('')}`,
  )
  .join('')}`;
  writeFileSync(join(OUT, 'index.html'), html);
  return { changed: changed.length, errors: errors.length };
}

/* Run as a script, it is the matrix; imported (scripts/surface-atlas.mjs), it lends its Apps, its serving and its
   capture, so a page another tool pictures is seeded, served, signed in and captured exactly as the matrix does. */
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function main() {
  if (!process.env.TABLEWALK_TEST_PG && only !== 'stories')
    console.warn('Ignition is skipped: TABLEWALK_TEST_PG names no PostgreSQL server.');
  const started = Date.now();
  const temp = mkdtempSync(join(tmpdir(), 'tablewalk-visual-'));
  const apps = [];
  const browser = await chromium.launch();
  try {
    if (only !== 'stories') {
      console.log('Seeding and starting the sample Apps…');
      // Keep successful starts even when a sibling fails, so finally can stop
      // every process before removing its fixture directory.
      const startedApps = await Promise.allSettled(
        shardApps(
          selectVisualApps(
            APPS.filter((app) => styles || !app.stylesOnly),
            filter,
          ),
        ).map((app) => startApp(temp, app)),
      );
      apps.push(...startedApps.filter((result) => result.status === 'fulfilled').map((result) => result.value));
      const failed = startedApps.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    const list = await subjects(apps);
    const sessions = new Map();
    const signingIn = apps.filter((app) => list.some((subject) => subject.app === app && subject.signedIn));
    // Distinct Apps have distinct accounts, stores and browser contexts. Keep
    // two sign-ins in flight on one runner, not one after another (or one per
    // page); wait for both to settle before teardown if either fails.
    for (let i = 0; i < signingIn.length; i += 2) {
      const batch = await Promise.allSettled(signingIn.slice(i, i + 2).map(async (app) => [app.id, await signIn(browser, app)]));
      for (const result of batch) if (result.status === 'fulfilled') sessions.set(...result.value);
      const failed = batch.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    /* `--serve`: start and sign in, write where each App answers and its session (.visual/serve.json), and wait to be
       stopped, so a probe or a picture can be taken by hand against the same seeded Apps. */
    if (flag('--serve')) {
      const served = apps.map((app) => {
        const state = join(OUT, `serve-${app.id}.json`);
        mkdirSync(OUT, { recursive: true });
        writeFileSync(state, JSON.stringify(sessions.get(app.id) ?? { cookies: [], origins: [] }));
        return { id: app.id, origin: app.origin, state };
      });
      writeFileSync(join(OUT, 'serve.json'), JSON.stringify(served, null, 2));
      console.log(`Serving ${served.map((app) => `${app.id} at ${app.origin}`).join(', ')}; stop with Ctrl-C.`);
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    }
    const setupMs = Date.now() - started;
    rmSync(join(OUT, 'current'), { recursive: true, force: true });
    /* The App's own look and dark-on-a-phone are App columns: a story has no
       App to take a look from, and its phone captures already read both modes. */
    const jobs = (flag('--serve') ? [] : list).flatMap((subject) =>
      looks
        .filter((look) => !subject.app?.looks || subject.app.looks.includes(look))
        .flatMap((look) =>
          variants
            .filter((variant) => subject.app || (look !== APP_DEFAULT && !variant.apps))
            .filter((variant) => !variant.appLookOnly || look === APP_DEFAULT)
            .flatMap((variant) => (subject.app ? densities : [undefined]).map((density) => ({ subject, look, variant, density }))),
        ),
    );
    console.log(
      `${list.length} subjects × ${looks.length} looks × ${variants.length} variants = ${jobs.length} ${smoke ? 'page loads' : 'captures'}`,
    );
    const results = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          try {
            results.push({ ...job, ...(await capture(browser, job.subject, job.look, job.variant, sessions, job.density)) });
          } catch (error) {
            console.warn(`${job.subject.group}/${job.subject.name} ${job.look} ${job.variant.key}: ${error.message.split('\n')[0]}`);
          }
          if (results.length % 50 === 0) console.log(`  ${results.length}/${jobs.length}`);
        }
      }),
    );
    if (styles) {
      const missing = jobs.length - results.length;
      const broken = results.filter((result) => result.errors.length);
      for (const result of broken)
        console.error(`${result.subject.group}/${result.subject.name} ${result.look} ${result.variant.key}: ${result.errors.join('; ')}`);
      if (flag('--baseline')) {
        cpSync(join(OUT, 'styles', 'current'), join(OUT, 'styles', 'baseline'), { recursive: true });
        console.log(`${results.length} style fingerprints kept as the baseline.`);
      } else {
        let moved = 0,
          unmatched = 0;
        for (const result of results) {
          const baseline = join(OUT, 'styles', 'baseline', relative(join(OUT, 'styles', 'current'), result.styles));
          if (!existsSync(baseline)) {
            unmatched++;
            continue;
          }
          const before = JSON.parse(readFileSync(baseline, 'utf8')),
            after = JSON.parse(readFileSync(result.styles, 'utf8'));
          const paths = [...new Set([...Object.keys(before.elements), ...Object.keys(after.elements)])].filter(
            (path) => before.elements[path] !== after.elements[path],
          );
          if (!paths.length) continue;
          moved++;
          const props = [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])].filter(
            (name) => before.properties[name] !== after.properties[name],
          );
          console.error(
            `${result.subject.group}/${result.subject.name} ${result.look} ${result.variant.key}: ${paths.length} element(s) moved (${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ', …' : ''}); properties: ${props.slice(0, 12).join(', ')}${props.length > 12 ? ', …' : ''}`,
          );
        }
        console.log(
          `${results.length} style fingerprints: ${moved} differ from the baseline${unmatched ? `, ${unmatched} have none` : ''}, ${broken.length} with errors, ${missing} failed to load.`,
        );
        process.exitCode = moved || unmatched || broken.length || missing ? 1 : 0;
      }
    } else if (smoke) {
      const broken = results.filter((result) => result.errors.length);
      const missing = jobs.length - results.length;
      for (const result of broken)
        console.error(
          `${result.subject.group}/${result.subject.name} ${result.look} ${result.variant.key}${result.density ? ` ${result.density}` : ''}: ${result.errors.join('; ')}`,
        );
      console.log(
        `${results.length} page loads in ${Math.round((Date.now() - started) / 1000)}s: ${broken.length} with errors, ${missing} failed to load.`,
      );
      console.log(`  fixture startup and sign-in: ${Math.round(setupMs / 1000)}s`);
      // Piggyback on the required gate rather than running a second costly
      // matrix: where the runner time goes determines the next safe cut.
      const totals = { contextMs: 0, navigationMs: 0, fontsMs: 0 };
      for (const result of results) for (const key of Object.keys(totals)) totals[key] += result.timing[key];
      console.log(
        `  stage durations (sum across concurrent pages, not runner time): context ${Math.round(totals.contextMs / 1000)}s, ` +
          `navigation/action ${Math.round(totals.navigationMs / 1000)}s, fonts ${Math.round(totals.fontsMs / 1000)}s`,
      );
      process.exitCode = broken.length || missing ? 1 : 0;
    } else if (flag('--baseline')) {
      // Only what this run captured is replaced: `--only apps --baseline` keeps the stories' baseline.
      cpSync(join(OUT, 'current'), join(OUT, 'baseline'), { recursive: true });
    } else if (existsSync(join(OUT, 'baseline'))) {
      const page = await browser.newPage();
      for (const result of results) {
        const baseline = join(OUT, 'baseline', relative(join(OUT, 'current'), result.file));
        if (!existsSync(baseline)) continue;
        Object.assign(result, { baseline, ...(await compare(page, baseline, result.file)) });
      }
      await page.close();
    }
    for (const result of results) result.ratio ??= 0;
    if (!smoke) {
      const { changed, errors } = report(results);
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(
        `${results.length} captures in ${seconds}s. ${flag('--baseline') ? 'Kept as the baseline.' : `${changed} changed since the baseline.`}${errors ? ` ${errors} with page errors.` : ''}`,
      );
      console.log(`Review: ${join(OUT, 'index.html')}`);
    }
  } finally {
    await browser.close();
    await Promise.allSettled(apps.map((app) => app.stop()));
    rmSync(temp, { recursive: true, force: true });
    if (existsSync(OUT) && !readdirSync(OUT, { withFileTypes: true }).length) rmSync(OUT, { recursive: true, force: true });
  }
}
