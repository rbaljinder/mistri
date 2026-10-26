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
 * The page follows the App's source (server/app/appLive.ts, client
 * appLive.ts). A save to a module the App imports is drawn on the record
 * already open — same address, same page, no reload — and a save that does
 * not load is said over the last good App, placed in its file, until the
 * next good save takes it away.
 *
 * A server of its own over a fresh App directory and database (listen(0),
 * mkdtemp): the spec edits the App's files, which nothing else may share.
 */
let origin = '';
let directory = '';
let appDirectory = '';
let child: ChildProcess | undefined;

const resources = (label: string) => `export const task = {
  labels: { status: '${label}' },
};
`;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-live-browser-'));
  const db = join(directory, 'tasks.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
      INSERT INTO task VALUES (1, 'Call the depot', 'open'), (2, 'File the report', 'open');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'live', url: db }] }));
  appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.ts'),
    `import { task } from './resources.ts';
export default {
  id: 'live',
  name: 'Live proof',
  connection: 'live',
  resources: { task },
  views: { tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['subject', 'status'] } },
  home: 'tasks',
  nav: ['tasks'],
};
`,
  );
  writeFileSync(join(appDirectory, 'resources.ts'), resources('Status'));
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
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
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
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

test('a save is drawn where the reader stands, and a broken one is said over the last good App', async ({ page }) => {
  /* The page follows once its stream is open. */
  const following = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/app/live');
  await page.goto(`${origin}/tasks/1`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Call the depot' })).toBeVisible();
  await expect(main).toContainText('Status');
  const address = page.url();
  /* Gone if the page loads again: the save must be drawn in place. */
  await page.evaluate(() => Object.assign(window, { stillThisPage: true }));
  await following;

  writeFileSync(join(appDirectory, 'resources.ts'), resources('Stage'));
  await expect(main).toContainText('Stage');
  await expect(main).not.toContainText('Status');
  expect(page.url()).toBe(address);
  expect(await page.evaluate(() => (window as unknown as { stillThisPage?: boolean }).stillThisPage)).toBe(true);

  /* A save that does not parse: the last good App stays, and the overlay places the failure. */
  writeFileSync(join(appDirectory, 'resources.ts'), resources('Broken').replace('};', ''));
  const problem = page.getByRole('alert', { name: 'The last save did not load' });
  await expect(problem).toBeVisible();
  await expect(problem).toContainText(/resources\.ts:\d+/);
  await expect(problem.locator('pre .is-at')).toHaveCount(1);
  await expect(main).toContainText('Stage');

  /* The next good save takes it away. */
  writeFileSync(join(appDirectory, 'resources.ts'), resources('Phase'));
  await expect(problem).toHaveCount(0);
  await expect(main).toContainText('Phase');
  expect(page.url()).toBe(address);
  expect(await page.evaluate(() => (window as unknown as { stillThisPage?: boolean }).stillThisPage)).toBe(true);
});
