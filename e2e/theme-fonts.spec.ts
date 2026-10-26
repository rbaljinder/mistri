import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';

/**
 * An App theme's own face (`type.faces`) is drawn on a machine that has never
 * had it installed: the family is a name no machine carries ("Proof Sans",
 * Inter's Latin file under another name), so the heading is set in it only if
 * the page fetched it — from the App's own origin, and nowhere else.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-theme-fonts-browser-'));
  const db = join(directory, 'tasks.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL);
      INSERT INTO task VALUES (1, 'Call the depot'), (2, 'File the report');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'tasks', url: db }] }));
  const app = join(directory, 'app');
  mkdirSync(join(app, 'fonts'), { recursive: true });
  mkdirSync(join(app, 'node_modules'));
  mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  copyFileSync(resolve('packages/kit/src/client/fonts/inter-latin.woff2'), join(app, 'fonts', 'proof-sans.woff2'));
  copyFileSync(resolve('packages/kit/src/client/fonts/inter-latin.woff2'), join(app, 'fonts', 'other-serif.woff2'));
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.ts'),
    `import { defineApp, defineTheme, listView } from '@mistriwork/mistri/app';
const proof = defineTheme({
  id: 'proof',
  label: 'Proof',
  extends: 'lumen',
  type: {
    font: { heading: '"Proof Sans", serif' },
    faces: [{ family: 'Proof Sans', src: './fonts/proof-sans.woff2', weight: '100 900' }],
  },
});
// A second theme the App offers and the page does not wear: its face is never fetched.
const other = defineTheme({
  id: 'other',
  label: 'Other',
  extends: 'sage',
  type: {
    font: { heading: '"Other Serif", serif' },
    faces: [{ family: 'Other Serif', src: './fonts/other-serif.woff2', weight: '100 900' }],
  },
});
export default defineApp({
  id: 'fonts',
  name: 'Fonts proof',
  connection: 'tasks',
  resources: { task: {} },
  views: { tasks: listView('Tasks', 'task') },
  home: 'tasks',
  ui: { customThemes: [proof, other], theme: { preset: 'proof' } },
});
`,
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = started;
  let log = '';
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 30_000);
    started.stdout!.on('data', () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The fixture exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

test("an App theme's own face draws its heading, fetched from the App's origin and preloaded with the page", async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(request.url());
  });
  const answer = await page.goto(`${origin}/tasks`);
  const html = (await answer!.text()) ?? '';
  // The first paint says the face and preloads it: no flash of the fallback while the script loads.
  expect(html).toMatch(/<link rel="preload" as="font" type="font\/woff2" crossorigin href="\/_fonts\/proof-sans-[0-9a-f]{12}\.woff2">/);
  expect(html).toContain('font-family:"Proof Sans"');
  const heading = page.locator('h1').first();
  await expect(heading).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await heading.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/^"?Proof Sans"?/);
  // Loaded, not merely named: no machine has a face of this name.
  expect(await page.evaluate(() => document.fonts.check('700 16px "Proof Sans"'))).toBe(true);
  expect(fonts.length).toBeGreaterThan(0);
  for (const url of fonts) expect(url.startsWith(`${origin}/`)).toBe(true);
  expect(fonts.some((url) => /\/_fonts\/proof-sans-[0-9a-f]{12}\.woff2$/.test(url))).toBe(true);
  // The theme it offers and does not wear costs the page nothing: not preloaded, not declared, not fetched.
  // (The App's payload still lists the theme, so a reader can switch to it; what costs bytes is a preload or a face.)
  expect(html).not.toMatch(/<link rel="preload"[^>]*other-serif/);
  expect(html).not.toContain('font-family:"Other Serif"');
  expect(fonts.some((url) => url.includes('other-serif'))).toBe(false);
  expect(await page.evaluate(() => [...document.fonts].some((face) => face.family.includes('Other Serif')))).toBe(false);

  const file = await page.request.get(fonts.find((url) => url.includes('/_fonts/'))!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('font/woff2');
  expect(file.headers()['cache-control']).toContain('immutable');
  // Only a name the theme declared answers: nothing else in the App's directory is served.
  expect((await page.request.get(`${origin}/_fonts/app-000000000000.woff2`)).status()).toBe(404);
});
