/**
 * The client as the package ships it, in a real browser.
 *
 * Every other browser suite runs the server under tsx, which serves the
 * source tree through Vite: none of the build's choices exist there — no
 * content-named files, no compressed copies, no chunks loaded on demand. So
 * this starts the compiled server (`node --conditions=mistri-built packages/mistri/dist/server/index.js`) and looks at
 * what it sends: Forecourt's public landing and one of its lists, its staff
 * sign-in and Tick's list, each from a cold cache and again from a warm one. It fails on
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
/* The binary's compiled entry. */
const built = join(root, 'packages/mistri/dist/server/index.js');
assert.ok(existsSync(built) && existsSync(join(root, 'packages/mistri/dist/client/index.html')), 'Build the package first: npm run build.');
const scratch = mkdtempSync(join(tmpdir(), 'mistri-built-client-'));
const IMMUTABLE = 'public, max-age=31536000, immutable';
/* What a cold first visit may take off the wire, page and assets, before the room paints, by the surface it draws
   (vite.config.ts, `surfaces`). scripts/bundle-budget.mjs holds each surface's own targets at build time; this holds
   what a browser actually fetched for a real room, and that the public pages never fetch the shell nor an App page
   another surface's chunks.

   The same rule as bundle-budget.mjs: a target is a round figure about 3% above what the build measured, and moves
   only in a release's budget commit, with its reason written here and a CHANGELOG line; it comes down when a release
   measures more than 5% under it. A feature that would cross pays its bytes back (onDemand, removal) or waits.

   History, condensed. At 0.8.0 every page sent about 390 KB; the split made a sign-in screen 217 KB, an App page 361
   and the Workbench 373. The interface's words moving into the catalog, the navigation and startup holds, the view
   roles, find() and the record search, the App chrome's own chunk (which brotli compresses about 5 KB worse), live
   sync's keys and holds, rc.1's forms waves, rc.2's Workshop default (Barlow's faces beside its sheet, and every
   built-in look's palettes in the entry), rc.3's Ledger, rc.11's money and documents fixes and rc.15's inputs, calendar
   and grouped grid each moved a ceiling by what they measured, about 0.5% above. The Workbench left for its own
   repository, and its ceiling with it. Complete cold visits at rc.16, measured: 252.2 KB the staff sign-in, 457.7 KB
   Forecourt's list, 570.5 KB Tick's list. rc.23's pages, steps, page presentations and form drafts (the App script's
   ceiling moved with them in bundle-budget.mjs) took Forecourt's list to 473.9 KB. rc.47's public-form refusal and
   reply words, radios from a table and the dark bar's workspace tab took the staff sign-in to 260.3 KB and Tick's list to
   590.4 KB; both moved about 0.5% above. */
const FIRST_PAINT_WIRE_KB = { public: 262, app: 488, workshop: 594 };
const NEVER = {
  public: ['/assets/shell', '/assets/chrome', '/assets/tenant'],
  app: ['/assets/tenant', '/assets/public'],
  workshop: ['/assets/tenant', '/assets/public'],
};

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** The compiled server, as `npx mistri` would run it, answering once it says it listens. */
async function start(name, args, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--conditions=mistri-built', built, ...args, '--port', String(port)], {
    cwd: root,
    // Each run its own temporary root, so nothing it seeds is another run's.
    env: {
      ...process.env,
      TMPDIR: scratch,
      XDG_CONFIG_HOME: join(scratch, `${name}-xdg`),
      TABLEWALK_OPEN: '0',
      MISTRI_OPEN: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  // Tick wears Workshop, the look an App wears by default, and so Workshop's faces (barlowFace.css).
  const tickDb = join(scratch, 'tick.db');
  execFileSync(process.execPath, [join(root, 'examples/databases/tick/seed.mjs'), tickDb], { cwd: root, stdio: 'ignore' });
  const tick = await start('tick', ['--config', `${tickDb}.json`, '--app', 'examples/apps/tick']);
  servers.push(tick);
  browser = await chromium.launch();

  /* A page is drawn when the parts it asked for have arrived and drawn what they hold: the cards come from a part loaded
     on demand (CardsList), after the App's first reads, and their photographs after that. Each step waits on the one
     before it, and on a slow runner the gap between two of them can outlast the 500 ms of quiet `networkidle` calls
     idle, which then closed the cold visit before the part was fetched and let the warm one fetch it "again". */
  const cardsDrawn = (page) =>
    page.waitForFunction(() => {
      const photos = [...globalThis.document.querySelectorAll('img.cards-image')].filter((img) => img.loading !== 'lazy');
      return photos.length > 0 && photos.every((img) => img.complete);
    });
  const landing = async (page) => {
    await page.getByRole('heading', { level: 1, name: 'Find a car you will love driving' }).waitFor();
    await cardsDrawn(page);
  };
  const list = async (page) => {
    await page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem').first().waitFor();
    await cardsDrawn(page);
  };
  const signIn = (page) => page.locator('.signin-title').waitFor();
  const tasks = (page) => page.getByRole('checkbox').first().waitFor();
  for (const [label, url, ready, surface] of [
    ['Forecourt staff sign-in (the public surface)', `${forecourt.origin}/sign-in`, signIn, 'public'],
    ['Forecourt public landing', `${forecourt.origin}/`, landing, 'app'],
    ['Forecourt list (an App list page)', `${forecourt.origin}/vehicles`, list, 'app'],
    ['Tick list (a Workshop App, its faces preloaded)', `${tick.origin}/`, tasks, 'workshop'],
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
      budgetFailures.push(`${label}: a cold first visit fetched ${wireKB} KB, over the ${FIRST_PAINT_WIRE_KB[surface]} KB target`);
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

  // An App list draws its cards through a chunk loaded on demand (CardsList);
  // that chunk arrives after the entry. After a deploy the old name is gone,
  // and the SPA fallback answers it with the page — which is what is served here.
  const broken = await browser.newContext();
  await broken.route(/\/assets\/CardsList-[\w-]+\.js$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Forecourt</title>' }),
  );
  const failed = await visit(broken, `${forecourt.origin}/vehicles`, (page) =>
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
