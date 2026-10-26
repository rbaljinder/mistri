import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { scalar } from './support/db';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';

/**
 * An App has no Undo (0.8.2 WR1): its writes run side by side on a writer
 * pool, and a change is corrected by another change. The "Added" and
 * "Deleted" confirmations say what happened and offer only to be dismissed,
 * Cmd+Z asks the server nothing, and the record's history still keeps each
 * change. The database is asked what happened, never the screen alone.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let db = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-undo-browser-'));
  db = join(directory, 'records.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
      INSERT INTO task VALUES (1, 'Call the depot', 'open'), (2, 'File the report', 'open');`);
  } finally {
    source.close();
  }
  provisionSqliteRecordHistory(db);
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'history', url: db, writable: true }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'undo',
      name: 'Undo proof',
      connection: 'history',
      resources: { task: { access: 'write', delete: true, labels: { subject: 'Subject' } } },
      views: { tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['subject', 'status'] } },
      pages: { task: { base: 'task', sections: [{ kind: 'fields', show: ['subject', 'status'] }, { kind: 'history' }] } },
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

const toast = (page: import('@playwright/test').Page) => page.locator('.toast:not([hidden])');

test("an App's Added confirmation offers no Undo, and Cmd+Z asks the server nothing", async ({ page }) => {
  const reverts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/revert')) reverts.push(request.url());
  });
  await page.goto(`${origin}/undo/tasks`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await page.getByRole('button', { name: /^\+ New/ }).click();
  const form = page.locator('.newpanel');
  await form.getByLabel('Subject', { exact: true }).fill('Order the parts');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(toast(page)).toContainText('Added');
  await expect.poll(() => Number(scalar(db, "SELECT count(*) FROM task WHERE subject = 'Order the parts'"))).toBe(1);
  await expect(toast(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => Number(scalar(db, "SELECT count(*) FROM task WHERE subject = 'Order the parts'"))).toBe(1);
  expect(reverts).toEqual([]);
});

test("an App's Deleted confirmation offers no Undo, only to be dismissed", async ({ page }) => {
  await page.goto(`${origin}/tasks/2`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page)).toContainText('Deleted');
  await expect.poll(() => Number(scalar(db, 'SELECT count(*) FROM task WHERE id = 2'))).toBe(0);
  // One quiet confirmation: its own words, and a way to dismiss it.
  await expect(toast(page).getByRole('button')).toHaveText(['×']);
});
