import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'mistri-short-name-'));
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
      writeFileSync(
        join(appDirectory, 'app.json'),
        JSON.stringify({
          id: 'northwind',
          name: 'Northwind Field Service',
          shortName: 'Northwind',
          connection: 'rail',
          resources: { task: {} },
          views: { tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['subject'] } },
          home: 'tasks',
          nav: ['tasks'],
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
    },
    async () => {
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
    },
  ),
});

/**
 * A long App name was cut by a phone's bar to "Northwind Fi…". With a `shortName` the bar says that instead under
 * 600px, and the full name stays in the button, read, so the home button is still called by it; at a desk the full
 * name is drawn as before.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test("a phone's bar says the short name, and the home button is still called by the full one", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${origin}/`);
  const brand = page.locator('.topbar .brand-name');
  await expect(brand.locator('.brand-short')).toBeVisible();
  await expect(brand.locator('.brand-short')).toHaveText('Northwind');
  const long = await brand.locator('.brand-long').boundingBox();
  expect(long!.width).toBeLessThanOrEqual(1);
  await expect(page.locator('#home-button')).toHaveAccessibleName(/^Northwind Field Service$/);
  expect(await page.evaluate(() => document.title)).toContain('Northwind Field Service');
});

test('at a desk the bar says the full name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/`);
  const brand = page.locator('.topbar .brand-name');
  await expect(brand.locator('.brand-long')).toHaveText('Northwind Field Service');
  await expect(brand.locator('.brand-long')).toBeVisible();
  await expect(brand.locator('.brand-short')).toBeHidden();
});
