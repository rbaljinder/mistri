import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Frame } from '@playwright/test';
import { expect, test } from './support/harness';
import { openShot, shotContext } from '../packages/mistri/src/server/build/shot';

/**
 * TC6: a theme's suggested menu placement (defineTheme's `shell.placement`) is seen where a theme is tried: the
 * theme bench's frames move the menu as the spec being written says, and shot draws a look shot by name with the
 * menu where it suggests. Both drew it where the App wore it.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp), with --dev for the bench.
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-theme-placement-'));
  const db = join(directory, 'shop.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE supplier (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO supplier VALUES (1, 'Cascade Cycle Supply');
      INSERT INTO part VALUES (1, 'Chain');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: db, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.ts'),
    `import { defineApp, defineTheme, listView } from '@mistriwork/mistri/app';
// Plain says nothing of the menu, so the App wears it at the side; Harbor suggests the top.
const plain = defineTheme({ id: 'plain', label: 'Plain', extends: 'lumen' });
const harbor = defineTheme({ id: 'harbor', label: 'Harbor', extends: 'lumen', shell: { placement: 'top' } });
export default defineApp({
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: { supplier: {}, part: {} },
  views: { suppliers: listView('Suppliers', 'supplier'), parts: listView('Parts', 'part') },
  nav: ['suppliers', 'parts'],
  home: 'suppliers',
  ui: { customThemes: [plain, harbor], theme: { preset: 'plain' } },
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
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port), '--dev'],
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

/** Whether a frame draws the App's menu in the bar on top (app.js), rather than at the side. */
const onTop = (frame: Frame) => frame.evaluate(() => document.body.classList.contains('app-topnav'));

test("the bench's frames move the menu as the theme being written suggests", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2200, height: 900 });
  await page.goto(`${origin}/_mistri/theme/`);
  // The first visit compiles the client under tsx (devclient.ts): give it the time a cold start takes.
  const light = page.frameLocator('#light');
  await expect(light.getByRole('heading', { name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  const frame = page.frame({ name: 'mistri-theme-bench:light' })!;
  expect(await onTop(frame)).toBe(false);
  const spec = page.locator('#spec');
  const written = JSON.parse(await spec.inputValue()) as Record<string, unknown>;
  expect(written.id).toBe('plain');
  await spec.fill(JSON.stringify({ ...written, shell: { placement: 'top' } }, null, 2));
  await expect.poll(() => onTop(frame), { timeout: 10_000 }).toBe(true);
  await expect(light.locator('#topnav')).toContainText('Parts');
  // And back where the App wears it when the spec says nothing.
  await spec.fill(JSON.stringify(written, null, 2));
  await expect.poll(() => onTop(frame), { timeout: 10_000 }).toBe(false);
  await expect(page.locator('#shell')).toHaveText('');
  // A type control writes its path into the spec, and the frames wear it: the base size every size grows with.
  await page.locator('select[data-path="type.base"]').selectOption('16px');
  expect(JSON.parse(await spec.inputValue()).type).toEqual({ base: '16px' });
  await expect
    .poll(() => frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--type-k').trim()), { timeout: 10_000 })
    .toBe('calc(16 / 13)');
  await page.locator('select[data-path="type.roles.section.case"]').selectOption('small-caps');
  expect(JSON.parse(await spec.inputValue()).type).toEqual({ base: '16px', roles: { section: { case: 'small-caps' } } });
  await page.locator('select[data-path="type.base"]').selectOption('');
  expect(JSON.parse(await spec.inputValue()).type).toEqual({ roles: { section: { case: 'small-caps' } } });
  // A weight is written as the number the spec takes, not the word the select holds.
  await page.locator('select[data-path="type.roles.title.weight"]').selectOption('600');
  expect(JSON.parse(await spec.inputValue()).type.roles.title).toEqual({ weight: 600 });
  // A pattern behind the page, worn by the frames.
  await page.locator('select[data-path="surface.ground.kind"]').selectOption('grid');
  expect(JSON.parse(await spec.inputValue()).surface).toEqual({ ground: { kind: 'grid' } });
  await expect
    .poll(() => frame.evaluate(() => document.documentElement.getAttribute('data-surface-ground')), { timeout: 10_000 })
    .toBe('grid 1');
});

test('shot draws a look shot by name with the menu where it suggests', async ({ browser }) => {
  test.setTimeout(90_000);
  const look = { app: 'shop', theme: 'harbor', own: true, label: 'Harbor', placement: 'top' as const };
  for (const [worn, top] of [
    [undefined, false],
    [look, true],
  ] as const) {
    const context = await shotContext(browser, origin, { viewport: { width: 1280, height: 800 }, dark: false, look: worn });
    try {
      const page = await context.newPage();
      await openShot(page, origin, '/suppliers');
      await expect(page.locator('.page-title, h1').first()).toBeVisible({ timeout: 45_000 });
      expect(await page.evaluate(() => document.body.classList.contains('app-topnav'))).toBe(top);
    } finally {
      await context.close();
    }
  }
});
