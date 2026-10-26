#!/usr/bin/env node
/**
 * The documentation's pictures, regenerated from the example Apps and the fixtures that were examples.
 *
 * Forty-odd screenshots once stood on the site with nothing to reproduce any
 * of them, so each went stale silently when a look or a sample changed.
 * site/shots.json lists a picture per entry: which App, which address, who is
 * signed in, which look, scheme and size, and which part of the page to keep.
 * This script seeds each sample App into a throwaway database, runs
 * `mistri shot --scale 2` against it on a free port (never a shared one),
 * crops to the entry's `clip`, and writes a WebP under site/src/assets/.
 *
 *   node scripts/docs-shots.mjs                 every entry
 *   node scripts/docs-shots.mjs guide/list      entries whose file contains the text
 *   node scripts/docs-shots.mjs --list          print the manifest, run nothing
 *   node scripts/docs-shots.mjs --out <dir>     write there instead of site/src/assets (to compare before replacing)
 *   node scripts/docs-shots.mjs --whole --out <dir>  each picture uncropped, its clip ignored (to choose a clip)
 *
 * An entry is { file, app, route, viewport: "desk" | "phone", width?, full?: true, scheme?: "light" | "dark",
 * look?, compare?, as?, clip?: { x, y, width, height } } with the clip in CSS pixels, so a
 * 1280 x 800 clip is a 2560 x 1600 picture; `width` narrows or widens the window
 * (`shot --width`); `compare: "<look>"` puts that built-in look on the left of the entry's `look` (`shot --compare`), a sheet two windows wide that `scale: 1` keeps light. An entry with `recipes: "<part>"` is that part's contact sheet (`shot --recipes`): the page in
 * each of the part's values, one thumbnail apiece, for the gallery the theming docs show. Every seed, the server and the page read one pinned day
 * (TODAY below), so "due in 3 days" and "last 30 days" are the same picture on
 * any day it is taken, and a changed one is a change worth reviewing
 * (visual-matrix.mjs --baseline) before it is committed.
 *
 * An entry with "served": true is an App's address `shot` does not take, such as its sign-in screen: the App is
 * served here, signed out, and captured as the Workbench is below.
 *
 * An entry with "story": "<id>" instead of an App is that story of the component library (Storybook, built into
 * site/dist/components by `npm run build:site` — build it first), in `look` (the library's Look button) and light,
 * captured as what the story drew in a window of `width` by `height` (1240 by 900 by default): the Component tour's pictures.
 *
 * The database browser is not an App, so `shot` cannot take it. An entry with
 * "workbench": "demo" instead of an App is the browser over the --demo
 * database (connection "demo", read-only), served here on a free port with its own
 * config directory and the same pinned day, and captured as `shot` captures:
 * the tour dismissed, motion reduced, fonts loaded, the network idle.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = join(ROOT, 'site/shots.json');
export const ASSETS = join(ROOT, 'site/src/assets');

/* The day every picture is taken on: the seeders' own "today" switches and the
   server's and the page's clock (MISTRI_CLOCK, TABLEWALK_CLOCK) all say it. visual-matrix.mjs
   reads the same day. */
export const TODAY = '2026-09-04';
const CLOCK = `${TODAY}T16:00:00.000Z`;
const PINNED = {
  MISTRI_CRM_TODAY: TODAY,
  DEPOT_TODAY: TODAY,
  COMMONS_TODAY: TODAY,
  ATELIER_TODAY: TODAY,
  LINTEL_TODAY: TODAY,
  TABLEWALK_CLOCK: CLOCK,
  MISTRI_CLOCK: CLOCK,
};

/** How each sample App's database is made. Each seeder writes `<db>.json` (or this does), naming the connection. */
export const SEEDS = {
  tick: (db) => ['examples/databases/tick/seed.mjs', db],
  /* It provisions the command journal through @mistriwork/mistri/commands, which is TypeScript. */
  'loaner-desk': (db) => ['--import', 'tsx', 'test/fixtures/databases/loaner-desk/seed.mjs', db],
  thread: (db) => ['test/fixtures/databases/thread/seed.mjs', db],
  /* Its seed imports the App's commands.ts, which is TypeScript. */
  depot: (db) => ['--import', 'tsx', 'test/fixtures/databases/depot/seed.mjs', db],
  commons: (db) => ['test/fixtures/databases/commons/seed.mjs', db],
  compass: (db) => ['test/fixtures/databases/crm/make-crm-db.mjs', db],
  /* Its prices come from the App's pricing.ts, which is TypeScript. */
  atelier: (db) => ['--import', 'tsx', 'test/fixtures/databases/atelier/seed.mjs', db],
  /* Its stores (auth, jobs, history) are provisioned through the App's own TypeScript. */
  lintel: (db) => ['--import', 'tsx', 'examples/databases/lintel/seed.mjs', db],
};

/** What an App is served with beyond its directory and database, as its README starts it: Lintel's jobs module and
 * row policy, and the secrets they read (made here, used for one run). `people` are accounts made in the run's own
 * store before its first picture, each with the role an entry's `as` names: a seeded person's address, so `--as`
 * signs in as someone the App's people table holds — a name in the menu and on a greeting, and rows of their own —
 * rather than a fresh "A manager" who owns nothing. */
export const SERVE = {
  lintel: {
    args: ['--jobs', 'examples/apps/lintel/jobs.ts', '--policy', 'examples/apps/lintel/policy.ts'],
    env: () => ({ LINTEL_MAIL_SECRET: randomBytes(24).toString('base64url'), PAYMENT_CALLBACK_SECRET: randomBytes(16).toString('hex') }),
    people: [
      { name: 'Maya Okafor', email: 'maya.okafor@lintel.example.test', role: 'manager' },
      { name: 'Andre Okoye', email: 'andre.okoye@example.test', role: 'resident' },
    ],
  },
};

/** Where each App's source is: Tick and Lintel ship as examples; the rest are fixtures that were examples until
 * 0.9.2, whose pictures the docs still show (Compass is the CRM fixture). */
export const appDirectory = (app) =>
  app === 'tick' || app === 'lintel' ? `examples/apps/${app}` : `test/fixtures/apps/${app === 'compass' ? 'crm' : app}`;

/** The browser's databases, by name: each made by a script beside the server's own code. */
export const WORKBENCH = {
  demo: (db) => [
    '--import',
    'tsx',
    '-e',
    `const d = await import('./packages/engine/src/server/demo.ts'); d.makeDemoDatabase(${JSON.stringify(db)}); d.seedDemoDatabase(${JSON.stringify(db)}, { scale: 150 });`,
  ],
};

const SIZE = { desk: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer()
      .once('error', fail)
      .listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => done(port));
      });
  });

/** The database browser over one of WORKBENCH's databases, listening; `stop` ends it. */
async function startWorkbench(name, directory) {
  const db = join(directory, `${name}.db`);
  const made = spawnSync(process.execPath, WORKBENCH[name](db), { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...PINNED } });
  if (made.status !== 0) throw new Error(`making the ${name} database failed: ${made.stderr}`);
  /* Named as `--demo` names it, so the addresses are the ones the pages print (/demo/customer/~1); --demo itself
     would open a browser window. */
  const config = join(directory, `${name}.json`);
  writeFileSync(config, JSON.stringify({ connections: [{ name, url: db }] }));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--config', config, '--port', String(port)],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, ...PINNED, XDG_CONFIG_HOME: join(directory, 'workbench-config') },
    },
  );
  return listening(child, port, `the database browser over ${name}`);
}

/** A sample App served here, signed out, over the database `seed` made; `stop` ends it. For an address `shot` does
 * not take — the sign-in screen is the App's door, not one of its routes. */
async function startApp(app, config, directory) {
  const port = await freePort();
  const serve = SERVE[app];
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/mistri/src/server/index.ts',
      '--config',
      config,
      '--app',
      appDirectory(app),
      ...(serve?.args ?? []),
      '--port',
      String(port),
    ],
    {
      cwd: ROOT,
      stdio: 'ignore',
      // An App that signs people in signs its sessions with a secret; this one lives for the run.
      env: {
        ...process.env,
        ...PINNED,
        ...serve?.env(),
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        XDG_CONFIG_HOME: join(directory, 'config'),
      },
    },
  );
  return listening(child, port, app);
}

async function listening(child, port, what) {
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 120; tries++) {
    if (
      await fetch(`${origin}/healthz`).then(
        (answer) => answer.ok,
        () => false,
      )
    )
      return { origin, stop: () => child.kill() };
    await new Promise((done) => setTimeout(done, 250));
  }
  child.kill();
  throw new Error(`${what} did not start on ${origin}`);
}

/** One picture of a page served here (the Workbench, or an App's door) as PNG bytes, taken the way `shot` takes an App's. */
async function workbenchShot(browser, origin, entry) {
  const viewport = { width: entry.width ?? SIZE[entry.viewport].width, height: SIZE[entry.viewport].height };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: entry.scheme === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] }] },
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
    await page.clock.setFixedTime(new Date(CLOCK));
    const answer = await page.goto(`${origin}${entry.route}`, { waitUntil: 'networkidle', timeout: 60_000 });
    if (!answer || answer.status() >= 400) throw new Error(`${entry.file}: ${entry.route} answered ${answer?.status()}`);
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.waitForTimeout(400);
    if (errors.length) throw new Error(`${entry.file}: the page threw: ${errors.join('; ')}`);
    return await page.screenshot({ caret: 'hide', animations: 'disabled', fullPage: Boolean(entry.full) });
  } finally {
    await context.close();
  }
}

const LIBRARY = join(ROOT, 'site/dist/components');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** The built component library over HTTP on a free port (its modules will not load from a file: address). */
async function startLibrary() {
  if (!existsSync(join(LIBRARY, 'iframe.html')))
    throw new Error('site/shots.json names a story, and the component library is not built: run npm --prefix storybook run build first.');
  const { createServer: createHttp } = await import('node:http');
  const server = createHttp((request, answer) => {
    const path = join(LIBRARY, decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(LIBRARY) || !existsSync(path)) return answer.writeHead(404).end();
    answer.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  const port = await new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/** One story of the library as PNG bytes: its root, at twice its CSS size. */
async function storyShot(browser, origin, entry) {
  const context = await browser.newContext({
    viewport: { width: entry.width ?? 1240, height: entry.height ?? 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
    await page.clock.setFixedTime(new Date(CLOCK));
    const globals = entry.look ? `&globals=look:${entry.look}` : '';
    await page.goto(`${origin}/iframe.html?id=${entry.story}&viewMode=story${globals}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.waitForTimeout(400);
    if (errors.length) throw new Error(`${entry.file}: the story threw: ${errors.join('; ')}`);
    /* The root fills the window; the picture is what the story drew in it, with a little air around it. */
    const clip = await page.evaluate(() => {
      const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      const root = globalThis.document.querySelector('#storybook-root').getBoundingClientRect();
      for (const node of globalThis.document.querySelectorAll('#storybook-root *')) {
        const rect = node.getBoundingClientRect();
        const style = globalThis.getComputedStyle(node);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'contents') continue;
        // A wrapper as tall as the window says nothing of where the story's drawing ends.
        if (rect.height >= root.height - 1 && node.children.length) continue;
        box.left = Math.min(box.left, rect.left);
        box.top = Math.min(box.top, rect.top);
        box.right = Math.max(box.right, rect.right);
        box.bottom = Math.max(box.bottom, rect.bottom);
      }
      const x = Math.max(0, Math.floor(box.left) - 16);
      const y = Math.max(0, Math.floor(box.top) - 16);
      return { x, y, width: Math.ceil(box.right) + 16 - x, height: Math.ceil(box.bottom) + 16 - y };
    });
    const png = await page.screenshot({ clip, fullPage: true, caret: 'hide', animations: 'disabled' });
    /* An empty popup's box or a chart's spare height can reach past the drawing: the plain ground around it is
       trimmed, and 16px of it put back. */
    const { info } = await sharp(png).trim({ threshold: 4 }).toBuffer({ resolveWithObject: true });
    const ground = (await sharp(png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()).toJSON().data;
    const edge = { top: 32, bottom: 32, left: 32, right: 32, background: { r: ground[0], g: ground[1], b: ground[2], alpha: 1 } };
    return await sharp(png)
      .extract({ left: -info.trimOffsetLeft, top: -info.trimOffsetTop, width: info.width, height: info.height })
      .extend(edge)
      .png()
      .toBuffer();
  } finally {
    await context.close();
  }
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')).shots;
}

/** The App's `people` as accounts in the store under `xdg`, made through its native account creation and given their
 * roles there; the store is the run's alone, so nothing of the reader's is touched. */
function makePeople(app, xdg) {
  const people = SERVE[app]?.people;
  if (!people?.length) return;
  /* An async function, not top-level await: the snippet is evaluated as a script, which loads the App as it loads. */
  const script = `(async () => {
    const { createAppAccounts } = await import('./packages/mistri/src/server/tenant/tenantMaintenance.ts');
    const { randomBytes } = await import('node:crypto');
    const people = ${JSON.stringify(people)};
    await createAppAccounts(${JSON.stringify(appDirectory(app))}, people.map(({ name, email }) => ({ name, email, password: randomBytes(18).toString('base64url') })));
  })().catch((error) => { console.error(error); process.exit(1); });`;
  const made = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...PINNED, ...SERVE[app].env?.(), XDG_CONFIG_HOME: xdg },
  });
  if (made.status !== 0) throw new Error(`making ${app}'s accounts failed: ${made.stderr}`);
  const store = join(xdg, 'mistri', 'auth', `${app}.db`);
  if (!existsSync(store)) throw new Error(`${app}'s accounts were made, but not in ${store}`);
  const db = new DatabaseSync(store);
  try {
    for (const { email, role } of people) db.prepare('UPDATE "user" SET role = ? WHERE lower(email) = ?').run(role, email.toLowerCase());
  } finally {
    db.close();
  }
}

function seed(app, directory) {
  const db = join(directory, `${app}.db`);
  const args = SEEDS[app]?.(db);
  if (!args) throw new Error(`site/shots.json names an App with no seed here: ${app}. Known: ${Object.keys(SEEDS).join(', ')}.`);
  const made = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...PINNED } });
  if (made.status !== 0) throw new Error(`seeding ${app} failed: ${made.stderr}`);
  /* Compass's seeder writes only the database; the rest write their own writable connection. */
  if (!existsSync(`${db}.json`)) writeFileSync(`${db}.json`, JSON.stringify({ connections: [{ name: app, url: db, writable: true }] }));
  return `${db}.json`;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv.splice(at, 2)[1];
  };
  const out = flag('--out');
  const listOnly = argv.includes('--list');
  const whole = argv.includes('--whole');
  if (whole && !out) throw new Error("--whole writes uncropped pictures, so it needs --out <dir>: they never replace the site's.");
  const filters = argv.filter((arg) => !arg.startsWith('--'));
  const shots = readManifest().filter((entry) => !filters.length || filters.some((text) => entry.file.includes(text)));
  if (listOnly) {
    for (const entry of shots)
      console.log(
        `${entry.file}  ${entry.story ? `story ${entry.story}` : (entry.app ?? `workbench ${entry.workbench}`)} ${entry.route ?? ''} ${entry.look ?? 'own look'} ${entry.viewport}${entry.recipes ? ` recipes.${entry.recipes}` : ''}`,
      );
    return;
  }
  if (!shots.length) throw new Error('No manifest entry matches.');

  const work = mkdtempSync(join(tmpdir(), 'tablewalk-docs-shots-'));
  const configs = new Map();
  const workbenches = new Map();
  /* Each App seeded once, its people made once, its config's path. */
  const prepared = (app) => {
    if (!configs.has(app)) {
      configs.set(app, seed(app, work));
      makePeople(app, join(work, 'config'));
    }
    return configs.get(app);
  };
  let browser;
  try {
    for (const entry of shots) {
      const started = Date.now();
      if (entry.story) {
        if (!workbenches.has('library')) workbenches.set('library', await startLibrary());
        browser ??= await (await import('playwright')).chromium.launch();
        await write(
          whole ? { ...entry, clip: undefined } : entry,
          sharp(await storyShot(browser, workbenches.get('library').origin, entry)),
          out,
        );
        console.log(`${entry.file}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
        continue;
      }
      if (entry.workbench || entry.served) {
        const key = entry.workbench ?? `app:${entry.app}`;
        if (!workbenches.has(key)) {
          if (entry.workbench) workbenches.set(key, await startWorkbench(entry.workbench, work));
          else {
            workbenches.set(key, await startApp(entry.app, prepared(entry.app), work));
          }
        }
        browser ??= await (await import('playwright')).chromium.launch();
        await write(
          whole ? { ...entry, clip: undefined } : entry,
          sharp(await workbenchShot(browser, workbenches.get(key).origin, entry)),
          out,
        );
        console.log(`${entry.file}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
        continue;
      }
      const raw = join(work, `raw-${entry.file.replace(/[^a-z0-9]+/gi, '-')}`);
      const args = [
        '--import',
        'tsx',
        'packages/mistri/src/server/index.ts',
        'shot',
        '--app',
        appDirectory(entry.app),
        entry.route,
        '--config',
        prepared(entry.app),
        '--scale',
        String(entry.scale ?? 2),
        `--${entry.viewport}`,
        '--out',
        raw,
      ];
      if (entry.width) args.push('--width', String(entry.width));
      /* A part below the first screen (a dashboard's lower sections) is clipped from the whole page. */
      if (entry.full) args.push('--full');
      if (entry.look) args.push('--theme', entry.look);
      /* The App in `look` beside a built-in look, one picture of the two (the built-in on the left). */
      if (entry.compare) args.push('--compare', entry.compare);
      if (entry.scheme === 'dark') args.push('--dark');
      if (entry.as) args.push('--as', entry.as);
      if (entry.recipes) args.push('--recipes', entry.recipes);
      /* A form or menu a reader opens first (`"click": "Schedule visit"`). */
      if (entry.click) args.push('--click', entry.click);
      const serve = SERVE[entry.app];
      if (serve) args.push(...serve.args);
      /* Its own config directory: nothing of the reader's is read, and nothing is left behind. */
      const ran = spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...PINNED, ...serve?.env(), XDG_CONFIG_HOME: join(work, 'config') },
      });
      // A contact sheet's line names its labels after the file.
      const png = ran.stdout.trim().split('\n').pop()?.split('  (')[0];
      if (ran.status !== 0 || !png) throw new Error(`${entry.file}: mistri shot exited ${ran.status}\n${ran.stderr}`);
      await write(whole ? { ...entry, clip: undefined } : entry, sharp(png), out);
      console.log(`${entry.file}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  } finally {
    await browser?.close();
    for (const { stop } of workbenches.values()) stop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Crop to the entry's clip (CSS pixels, the picture at twice that, or at `scale`) and write the WebP. */
async function write(entry, image, out) {
  if (entry.clip) {
    const { x, y, width, height } = entry.clip;
    const scale = entry.scale ?? 2;
    image = image.extract({ left: x * scale, top: y * scale, width: width * scale, height: height * scale });
  }
  const target = join(out ? resolve(out) : ASSETS, entry.file);
  mkdirSync(dirname(target), { recursive: true });
  await image.webp({ quality: 80, effort: 4 }).toFile(target);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
