import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';

/**
 * G153: with the side menu folded to its rail, the entries' words are visually
 * hidden by taking them out of flow (position: absolute). When nothing inside
 * the scrolling list was positioned, those words were placed against an
 * ancestor outside it, so a menu longer than the window made the whole page
 * taller: empty space under the content and a page scroll. The list must be
 * the containing block, so the page never outgrows the window.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-rail-overflow-'));
  const db = join(directory, 'records.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL);
      INSERT INTO task VALUES (1, 'Call the depot');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'rail', url: db }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  const views: Record<string, unknown> = {};
  const nav: string[] = [];
  for (let i = 0; i < 60; i++) {
    views[`tasks${i}`] = { kind: 'list', from: 'task', label: `Task list number ${i}`, show: ['subject'] };
    nav.push(`tasks${i}`);
  }
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'rail',
      name: 'Rail overflow',
      connection: 'rail',
      resources: { task: {} },
      views,
      pages: { task: { base: 'task', sections: [{ kind: 'fields', show: ['subject'] }] } },
      home: 'tasks0',
      nav,
      ui: { shell: { placement: 'side', rail: true } },
    }),
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port)],
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
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 20_000);
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

test('a folded rail with a menu taller than the window leaves the page no taller than the window', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.goto(`${origin}/`);
  await expect(page.locator('#table-list button').first()).toBeVisible();
  await page.locator('.sidebar-footer > .sidebar-collapse').click();
  await expect(page.locator('body')).toHaveClass(/app-nav-rail/);
  await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
  const list = await page.locator('#table-list').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(list.scroll).toBeGreaterThan(list.client);
  const page_ = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollHeight,
    inner: window.innerHeight,
  }));
  expect(page_.scroll).toBeLessThanOrEqual(page_.inner);
});
