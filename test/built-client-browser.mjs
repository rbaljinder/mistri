/**
 * The client as the package ships it, in a real browser.
 *
 * Every other browser suite runs the server under tsx, which serves the
 * source tree through Vite: none of the build's choices exist there — no
 * content-named files, no compressed copies, no chunks loaded on demand. So
 * this starts the compiled server (`node --conditions=mistri-built packages/{tablewalk,mistri}/dist/server/index.js`) and looks at
 * what it sends: Forecourt's public landing and one of its lists, and the
 * Workbench, each from a cold cache and again from a warm one. It fails on
 * a console error or an uncaught page error anywhere, on a script or a
 * stylesheet sent uncompressed or without its year of caching, on a warm
 * visit that downloads an asset again, and on a chunk that fails to load
 * without the reload prompt taking its place, and on a first visit heavier
 * than its ceiling. What each first visit fetched is printed, compressed and
 * not.
 *
 * Build first (`npm run build`). Its own servers and temporary directory;
 * nothing under e2e/.tmp, so it does not share the browser suites' fixtures.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-built-client-'));
const IMMUTABLE = 'public, max-age=31536000, immutable';
/* What a cold first visit may take off the wire, page and assets, before the
   room paints, by the surface it draws (vite.config.ts, `surfaces`). Every
   page sent about 390 KB at 0.8.0 before the split, and after it a sign-in
   screen 217 KB, an App page 361 and the Workbench 373; scripts/bundle-budget.mjs
   holds each surface's own ceiling at build time, and this holds what a
   browser actually fetched for a real room. The public pages must never
   fetch the shell, nor an App page the Workbench's tools. After the
   interface's words moved into the catalog (scripts/bundle-budget.mjs says
   what it cost and what left for parts on demand) a sign-in screen took
   215.7 KB, an App page 374.5 and the Workbench 386.5, and the ceilings sit
   about 1% above. 0.8.2's navigation hold and startup hold, and the places
   held for what arrives late (scripts/bundle-budget.mjs says what each
   cost), took a sign-in screen to 219.2 KB, an App page to 379.7 and the
   Workbench to 392.4; the ceilings sit about 0.5% above. */
// Named action IDs and computed-column resolution in 0.8.2 measured 383 KB
// for Forecourt and 395.7 KB for the Workbench; keep about 0.5% headroom.
// First Paint carries identity and App answers in private HTML (8–9.5 KB on
// the wire here). The complete cold visits are 224.8 KB public, 388.9 KB App,
// 396.8 KB Workbench; retain roughly 0.5% headroom. Asset budgets stay separate.
// 0.8.7's view roles, find(), the record search ⌘K now shares and a card's description took Forecourt's cold
// visit to 391.3 KB; the App ceiling moves to 393 (about 0.5% above).
// 0.8.8's rich text renderer, its allowlist and the .rich-text rules are on every first page
// (scripts/bundle-budget.mjs, its newest paragraph, says what they weigh): cold visits measured
// 394 KB Forecourt's landing, 395.5 KB its list and 400.1 KB the Workbench; about 0.5% above.
// 0.8.8's row-defined fields put a JSON key's path into the query language and the Save folding on every
// first page (bundle-budget.mjs again): the Workbench's cold visit measured 402.7 KB; about 0.5% above.
// 0.8.8 wave 4's flows: a resource's `flows` is read and checked by the App's own parser on every first page
// (the section itself, its words and its rules are a part loaded on demand). Forecourt's list measured 398.3 KB;
// the App ceiling is 400, about 0.5% above.
// 0.8.9 ships Lumen's face (Inter's Latin subset, 47.3 KB, sent as it is: a woff2 is compressed already) with
// Lumen's sheet, both preloaded by the page of an App that wears it; Forecourt wears a theme on Sage, so `app` holds
// still and a Lumen App is held apart. Tick's list, which also fetches its quick-add and New form parts on the first
// visit, measured 472.1 KB, of which the face is 47.3 and Lumen's sheet 3.9; the ceiling is 475, about 0.5% above.
// 0.8.11's date-and-time command input: a command's `datetime` field and the instant it accepts are read and
// checked by the shared command rules on every page that can draw a form, a public one included (the field's
// clock and zone arithmetic are a part loaded on demand). Forecourt's staff sign-in measured 226.3 KB; the public
// ceiling is 227, about 0.5% above.
// 0.8.13: a yes-or-no is read as an integer before an aggregate (schema.ts aggregateInput) in the statement
// compilers every Workbench page carries, and a relative day reads the zone-aware day. The Workbench's cold visit
// measured 405.2 KB; the ceiling is 407, about 0.5% above.
// 0.8.14's New menu: `ui.shell.new` is read and checked by the App's own parser on every first page, and the
// shell holds the menu's host and the palette's fetch of its lines (the menu itself is a part loaded on demand).
// Forecourt's list measured 400.2 KB; the App ceiling is 402, about 0.5% above.
// 1.0: server-drawn public pages are hydrated rather than drawn afresh (serverDrawing.js and react-dom's
// hydrateRoot ride on every first page, imageWidths.ts on the public one), and the embed seams (shell host,
// request identity) sit under the shell; the palette left the shell's first paint for a part loaded on demand
// (scripts/bundle-budget.mjs, its newest paragraph). Cold visits measured 227.6 KB Forecourt's staff sign-in,
// 402.6 KB its list and 407.7 KB the Workbench. Tick's New form, fetched on the first visit, now carries a form's
// lines and live values (FormLines and its sheet) and the shared form rules: 483.6 KB. Each ceiling about 0.5% above.
// The 1.0 gaps after it (scripts/bundle-budget.mjs says what each weighs, and why none could wait for onDemand.tsx):
// a true/false field said in its display rule's words, a reference picker that says it is wrong, the shell's own
// words in Spanish and a dashboard's window in its address, a related list's row menu, and the release review's
// cut-word fixes in the grid, the cards and a property rail. Cold visits measured 406.4 KB Forecourt's landing,
// 409.4 KB its list, 493.6 KB Tick's list and 411.7 KB the Workbench; the staff sign-in held. Each about 0.5% above.
// 0.9.1's segments, cross-table filters, consumes and display conventions are drawn by a list's first screen
// (scripts/bundle-budget.mjs, its newest paragraph). Cold visits measured 412.8 KB Forecourt's landing, 415.9 KB its
// list, 503 KB Tick's list and 418.4 KB the Workbench; the staff sign-in held. Each about 0.5% above.
// 0.9.3's first screens: a required field's caption says so to a screen reader (CommandFields, FormSurface,
// Dropdown), a public form's reference is a picker over what the visitor may read (CommandReference.tsx), a list
// a signed-out visitor may not read offers the sign-in in place (TableRoom.tsx; the screen itself loads on demand),
// a record's address is the person's own (appAddress.ts) and the startup outline asks /healthz before it says the
// server is down (index.html). Each is drawn before anything onDemand.tsx fetches. Cold visits measured 415.3 KB
// Forecourt's landing, 418.3 KB its list, 506.5 KB Tick's list and 420.8 KB the Workbench; the staff sign-in held.
// Each about 0.5% above.
// 0.9.4's theme vocabulary, frozen for 1.0 (type roles, per-role weights, shadows, motion, parts), is read by every
// first screen; slimming it is the next release's work (scripts/bundle-budget.mjs, its newest paragraph). Cold visits
// measured 422.8 KB Forecourt's list, 511.1 KB Tick's list and 425.2 KB the Workbench; the rest held. Each about 0.5%
// above.
// 0.9.5's design pass draws on every first screen: two type and space scales, compact density for Mono and Sage, two-line
// list heads, page layouts by shape and the grouped related lists (scripts/bundle-budget.mjs, its newest paragraph).
// Cold visits measured 233.9 KB the staff sign-in, 428.1 KB Forecourt's landing, 431.1 KB its list, 519.4 KB Tick's
// list and 433.5 KB the Workbench. Each about 0.5% above.
// 0.9.6's layout, states and phone passes and its mode seam (scripts/bundle-budget.mjs) had already taken three
// visits past their ceilings before the shell split: 236.7 KB the staff sign-in, 435.9 KB Forecourt's list, 527.3 KB
// Tick's list and 439 KB the Workbench. The split took the Workbench's tools off an App's first visit (429.3 KB
// Forecourt's landing, 432.4 KB its list, 523.8 KB Tick's list) and left them two chunks on the Workbench's, which
// names what it reads from the shell's by name (440.8 KB); the sign-in held. Each about 0.5% above.
// 0.9.8 takes the App's chrome out of the shell chunk into one of its own, which an App's page preloads beside it
// (vite.config.ts `surfaces`): the Workbench's landing no longer fetches it (420.8 KB), and an App's page fetches the
// same code in one more file, which brotli compresses about 5 KB worse (436.3 KB Forecourt's landing, 439.3 KB its
// list; Tick's held). Each about 0.5% above.
// 0.9.9's live sync puts its keys, its hold registry and the header filing each read's tables on every first page, and
// an App's page fetches the stream's part after it paints (scripts/bundle-budget.mjs, its newest paragraph). Cold
// visits measured 238.1 KB the staff sign-in, 438.3 KB Forecourt's landing, 441.4 KB its list, 527.7 KB Tick's list and
// 422.8 KB the Workbench. Each about 0.5% above.
// 1.0.0-rc.1's forms waves and the three branches merged onto it (rc/rc1-rest, rc/forms-followup, rc/tenant-live;
// scripts/bundle-budget.mjs, its newest paragraphs, says what each weighs): the field vocabulary's reader, the intake
// frame, the guard's seam and the quiet form on every form's first paint, the hero blocks' sheet on the public page,
// `<picture>` sources and format-named fallbacks, the valid check and review lines, and tenant-live's session check
// asked again. Cold visits measured 243.2 KB the staff sign-in, 441.1 KB Forecourt's landing, 444.5 KB its list,
// 534.2 KB Tick's list and 391.5 KB the Workbench (held). Each ceiling passed moves to about 0.5% above.
// rc.1's final merge adds the consistency pass (the label row's rules in primitives.css, the sign-in door's primary,
// the wide landing; scripts/bundle-budget.mjs, its newest paragraphs) to every first stylesheet. Cold visits measured
// 244.6 KB the staff sign-in, 442.5 KB Forecourt's landing, 445.9 KB its list, 535.9 KB Tick's list and 392.5 KB the
// Workbench; only the sign-in passed its ceiling, which moves to about 0.5% above.
// rc.2 makes Workshop the look an App wears by default, so Tick's list is held as a Workshop App: Barlow's regular and
// condensed bold preloaded beside Workshop's sheet, the semibold fetched where the page sets a word in it (65.1 KB of
// faces where Lumen's Inter was 47.1), and every built-in look's twelve palettes in the entry (about 1.4 KB in brotli
// on every first paint, scripts/bundle-budget.mjs). Measured: 246.5 KB the staff sign-in, 448 KB Forecourt's list and
// 562 KB Tick's list; each ceiling passed moves to about 0.5% above.
// rc.3 adds Ledger to the built-in looks and its palettes to the entry, the request-instant and kept-breakdown seams, and
// the security branch's client strings (scripts/bundle-budget.mjs, its newest paragraphs). Measured: 248.6 KB the staff
// sign-in, 447 KB Forecourt's landing, 450.3 KB its list, 562.8 KB Tick's list and 395.1 KB the Workbench; the
// sign-in passed its ceiling and the list met it, so both move to about 0.5% above.
const FIRST_PAINT_WIRE_KB = { public: 249.9, app: 452.6, workshop: 565, workbench: 425 };
const NEVER = {
  public: ['/assets/shell', '/assets/chrome', '/assets/workbench', '/assets/tenant'],
  app: ['/assets/workbench', '/assets/tenant', '/assets/public'],
  workshop: ['/assets/workbench', '/assets/tenant', '/assets/public'],
  workbench: ['/assets/chrome', '/assets/tenant', '/assets/public'],
};

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** The compiled server, as `npx tablewalk` would run it, answering once it says it listens. */
async function start(name, args, env = {}) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--conditions=mistri-built', args.includes('--app') ? built.mistri : built.tablewalk, ...args, '--port', String(port)],
    {
      cwd: root,
      // --demo has a fixed basename within tmpdir(); give each run its own
      // temporary root so it cannot reseed another preview's demo database.
      env: {
        ...process.env,
        TMPDIR: scratch,
        XDG_CONFIG_HOME: join(scratch, `${name}-xdg`),
        TABLEWALK_OPEN: '0',
        MISTRI_OPEN: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const owner = await readyBrowserChild(child, name);
  return { origin: `http://127.0.0.1:${port}`, stop: owner.stop };
}

/**
 * One visit, watched at the network: every static file the page fetched, how
 * it came (the wire's bytes, the decoded bytes, its encoding, its caching,
 * whether the browser's cache answered), and every error it printed.
 */
async function visit(context, url, ready) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const files = new Map();
  const fromCache = new Set();
  /* A revalidated page reaches the page as the cached 200; the status the
     server actually sent — a 304 — is only in the extra-info event. */
  const wireStatus = new Map();
  cdp.on('Network.requestServedFromCache', ({ requestId }) => fromCache.add(requestId));
  cdp.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => wireStatus.set(requestId, statusCode));
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const path = new URL(response.url).pathname;
    if (!response.url.startsWith(new URL(url).origin) || path.startsWith('/api/')) return;
    const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    files.set(requestId, {
      path,
      status: response.status,
      headers,
      wire: 0,
      decoded: 0,
      cached: Boolean(response.fromDiskCache || response.fromMemoryCache || response.fromPrefetchCache),
    });
  });
  cdp.on('Network.dataReceived', ({ requestId, dataLength }) => {
    const file = files.get(requestId);
    if (file) file.decoded += dataLength;
  });
  cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
    const file = files.get(requestId);
    if (file) {
      file.wire = encodedDataLength;
      file.cached ||= fromCache.has(requestId);
    }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(url);
  await ready(page);
  await page.waitForLoadState('networkidle');
  for (const [requestId, file] of files) file.status = wireStatus.get(requestId) ?? file.status;
  return { page, errors, files: [...files.values()] };
}

function sizes(files) {
  const kb = (bytes) => Math.round(bytes / 102.4) / 10;
  const fetched = files.filter((file) => !file.cached && file.status === 200);
  return {
    files: fetched.length,
    wireKB: kb(fetched.reduce((n, f) => n + f.wire, 0)),
    decodedKB: kb(fetched.reduce((n, f) => n + f.decoded, 0)),
  };
}

/** Assets are compressed and kept; the page carries fresh, account-bound first-paint data. */
function assertShipped(label, files) {
  const page = files.find((file) => file.headers['content-type']?.startsWith('text/html'));
  assert.ok(page, `${label}: no page`);
  assert.equal(page.headers['cache-control'], 'private, no-store', `${label}: first-paint data is never cached`);
  assert.equal(page.headers.etag, undefined, `${label}: personal HTML has no reusable ETag`);
  assert.match(page.headers.vary ?? '', /Cookie/i, `${label}: the page varies by reader`);
  const assets = files.filter((file) => file.path.startsWith('/assets/'));
  assert.ok(
    assets.some((file) => file.path.endsWith('.js')) && assets.some((file) => file.path.endsWith('.css')),
    `${label}: a script and a stylesheet`,
  );
  for (const file of assets) {
    assert.equal(file.headers['cache-control'], IMMUTABLE, `${label}: ${file.path} is kept for a year`);
    /* A woff2 is brotli inside already (vite.config.ts, TEXT): it is sent as it is. */
    if (file.decoded > 1024 && !file.path.endsWith('.woff2'))
      assert.equal(file.headers['content-encoding'], 'br', `${label}: ${file.path} arrives in brotli`);
  }
}

let browser;
const servers = [];
const report = {};
const budgetFailures = [];
async function stopServers() {
  const stopped = await Promise.allSettled(servers.map((server) => server.stop()));
  const failures = stopped.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Browser fixture teardown failed.',
    );
  rmSync(scratch, { recursive: true, force: true });
}
try {
  // Forecourt's seed migrates its command journal through @mistriwork/mistri/commands, which tsx resolves from source.
  const db = join(scratch, 'forecourt.db');
  execFileSync(process.execPath, ['--import', 'tsx', join(root, 'test/fixtures/databases/forecourt/seed.mjs'), db], {
    cwd: root,
    stdio: 'ignore',
  });
  const forecourt = await start(
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
      BETTER_AUTH_SECRET: 'disposable-built-client-browser-secret-at-least-thirty-two-characters',
      MISTRI_AUTH_ADMIN_EMAIL: 'staff@forecourt.example.test',
      MISTRI_AUTH_ADMIN_PASSWORD: 'disposable-built-client-password',
    },
  );
  servers.push(forecourt);
  // Tick wears Workshop, the look an App wears by default, and so Workshop's faces (workshopLook.css).
  const tickDb = join(scratch, 'tick.db');
  execFileSync(process.execPath, [join(root, 'examples/databases/tick/seed.mjs'), tickDb], { cwd: root, stdio: 'ignore' });
  const tick = await start('tick', ['--config', `${tickDb}.json`, '--app', 'examples/apps/tick']);
  servers.push(tick);
  const workbench = await start('workbench', ['--demo', '--no-config']);
  servers.push(workbench);
  browser = await chromium.launch();

  const landing = (page) => page.getByRole('heading', { level: 1, name: 'Find a car you will love driving' }).waitFor();
  const list = (page) => page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem').first().waitFor();
  const schema = (page) => page.locator('.diagram-schema > *').first().waitFor();
  const signIn = (page) => page.locator('.signin-title').waitFor();
  const tasks = (page) => page.getByRole('checkbox').first().waitFor();
  for (const [label, url, ready, surface] of [
    ['Forecourt staff sign-in (the public surface)', `${forecourt.origin}/sign-in`, signIn, 'public'],
    ['Forecourt public landing', `${forecourt.origin}/`, landing, 'app'],
    ['Forecourt list (an App list page)', `${forecourt.origin}/vehicles`, list, 'app'],
    ['Tick list (a Workshop App, its faces preloaded)', `${tick.origin}/`, tasks, 'workshop'],
    ['Workbench landing', `${workbench.origin}/`, schema, 'workbench'],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const cold = await visit(context, url, ready);
    assert.deepEqual(cold.errors, [], `${label}: errors on a cold visit`);
    assertShipped(label, cold.files);
    const faces = cold.files.filter((file) => file.path.endsWith('.woff2'));
    if (surface === 'workshop') {
      /* Each once: a preload's request is the one the sheet's @font-face uses, not a second. The semibold is not
         preloaded, and is fetched only where the page sets a word in it. */
      const names = faces.map((file) => file.path.replace(/-[\w-]{8}\.woff2$/, ''));
      assert.deepEqual(names, [...new Set(names)], `${label}: each face fetched once`);
      for (const face of ['/assets/barlow-400', '/assets/barlow-semi-condensed-700'])
        assert.ok(names.includes(face), `${label}: Workshop's ${face}`);
      assert.ok(
        names.every((name) => name.startsWith('/assets/barlow-')),
        `${label}: only Barlow (${names})`,
      );
      for (const face of faces) assert.equal(face.headers['content-type'], 'font/woff2', `${label}: the face's type`);
      assert.ok(
        await cold.page.evaluate(
          () =>
            globalThis.document.fonts.check('16px Barlow') &&
            globalThis.getComputedStyle(globalThis.document.body).fontFamily.startsWith('Barlow'),
        ),
        `${label}: the page is set in Barlow`,
      );
    } else assert.deepEqual(faces, [], `${label}: only a page wearing a look with faces of its own fetches them`);
    const chunks = cold.files.filter((file) => /^\/assets\/.+\.js$/.test(file.path)).map((file) => file.path.replace(/-[\w-]{8}\.js$/, ''));
    await cold.page.close();
    const warm = await visit(context, url, ready);
    assert.deepEqual(warm.errors, [], `${label}: errors on a warm visit`);
    const again = warm.files.filter((file) => file.path.startsWith('/assets/') && !file.cached);
    assert.deepEqual(
      again.map((file) => file.path),
      [],
      `${label}: a warm visit fetched assets again`,
    );
    const page = warm.files.find((file) => file.headers['content-type']?.startsWith('text/html') || file.status === 304);
    assert.equal(page?.status, 200, `${label}: a warm visit gets fresh first-paint data`);
    assert.equal(page?.headers['cache-control'], 'private, no-store', `${label}: warm HTML remains private`);
    const { wireKB } = sizes(cold.files);
    if (wireKB > FIRST_PAINT_WIRE_KB[surface])
      budgetFailures.push(`${label}: a cold first visit fetched ${wireKB} KB, over the ${FIRST_PAINT_WIRE_KB[surface]} KB ceiling`);
    const strays = chunks.filter((chunk) => NEVER[surface].some((prefix) => chunk.startsWith(prefix)));
    assert.deepEqual(strays, [], `${label}: fetched another surface's chunk`);
    report[label] = {
      cold: sizes(cold.files),
      html: sizes(cold.files.filter((file) => file.headers['content-type']?.startsWith('text/html'))),
      chunks,
      warm: { fetched: warm.files.filter((f) => !f.cached).map((f) => `${f.path} ${f.status}`) },
    };
    await context.close();
  }

  // The Workbench draws its schema through a chunk loaded on demand; that chunk
  // arrives after the entry. After a deploy the old name is gone, and the SPA
  // fallback answers it with the page — which is what is served here.
  const broken = await browser.newContext();
  await broken.route(/\/assets\/Diagram-[\w-]+\.js$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>tablewalk</title>' }),
  );
  const failed = await visit(broken, `${workbench.origin}/`, (page) =>
    page.getByRole('alert').filter({ hasText: 'could not be loaded' }).waitFor(),
  );
  assert.ok(await failed.page.getByRole('button', { name: 'Reload' }).isVisible(), 'a failed chunk offers a reload');
  assert.deepEqual(
    failed.errors.filter(
      (error) =>
        !error.includes('chunk did not load') &&
        !error.includes('Failed to fetch dynamically imported module') &&
        !error.includes('MIME type'),
    ),
    [],
    'a failed chunk is the only error',
  );
  await broken.close();
  report['chunk failure'] = 'the reload prompt replaced the part';

  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(budgetFailures, [], 'cold first-visit wire budgets');
  console.log('Built client browser checks passed: compressed, content-named and cached assets, on-demand chunks, no errors.');
} finally {
  try {
    await browser?.close();
  } finally {
    await stopServers();
  }
}
