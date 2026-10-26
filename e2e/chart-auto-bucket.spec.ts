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
 * A chart that says `auto` (packages/engine/src/shared/autoBucket.ts): three signups in a month, drawn over two windows. A bar a day
 * was thirty-one empty bars and three full ones; the chart now picks the unit from the window and the data, says it
 * under its title, and draws the weeks or months, not the days.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp), so it runs in the parallel lane.
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-auto-bucket-'));
  const db = join(directory, 'records.db');
  const source = new DatabaseSync(db);
  try {
    // Dates relative to the clock the server reads, so the windows below always hold them: one a day ago, one at
    // twelve, one at twenty-seven. Asked for each day, that is three bars among twenty-seven.
    source.exec(`CREATE TABLE signup (id INTEGER PRIMARY KEY, email TEXT NOT NULL, created_at DATE NOT NULL);
      INSERT INTO signup VALUES
        (1, 'a@example.com', date('now', '-1 day')),
        (2, 'b@example.com', date('now', '-12 days')),
        (3, 'c@example.com', date('now', '-27 days'));`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'growth', url: db }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'growth',
      name: 'Growth',
      connection: 'growth',
      resources: { signup: {} },
      views: {
        overview: {
          kind: 'dashboard',
          label: 'Overview',
          windows: ['last 30 days', 'last 12 months'],
          window: 'last 30 days',
          sections: [{ kind: 'chart', from: 'signup', by: 'auto created_at', over: 'created_at', title: 'Signups' }],
        },
      },
      home: 'overview',
      nav: ['overview'],
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

/** What the chart draws: the bucket labels' count and the sum of its values, read from the table assistive technology reads. */
const drawn = async (page: import('@playwright/test').Page) => {
  const cells = await page.locator('.chart-data td').allTextContents();
  return { buckets: cells.length, total: cells.reduce((sum, cell) => sum + Number(cell), 0) };
};

test('a sparse month is drawn in weeks, a year in months, and the chart says which', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${origin}/overview?period=last-30-days`);
  await expect(page.locator('.chart-unit')).toHaveText('by week');
  await expect(page.locator('.chart-line')).toBeVisible();
  const month = await drawn(page);
  // Three signups, not three among twenty-seven days: the weeks they fall in and the ones between, never a bar a day.
  expect(month.total).toBe(3);
  expect(month.buckets).toBeGreaterThanOrEqual(4);
  expect(month.buckets).toBeLessThanOrEqual(6);

  await page.goto(`${origin}/overview?period=last-12-months`);
  await expect(page.locator('.chart-unit')).toHaveText('by month');
  await expect(page.locator('.chart-line')).toBeVisible();
  const year = await drawn(page);
  expect(year.total).toBe(3);
  expect(year.buckets).toBeLessThanOrEqual(2);
});

test('the unit is said from the first paint and the slot does not move when it is', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${origin}/overview?period=last-30-days`);
  const note = page.locator('.chart-unit');
  await expect(note).toBeAttached();
  const before = await note.boundingBox();
  await expect(note).toHaveText('by week');
  const after = await note.boundingBox();
  expect(after!.height).toBe(before!.height);
  expect(after!.y).toBe(before!.y);
});
