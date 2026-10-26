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
 * A record page's `history()`: a cell edited in a list, a Save on the page
 * and an action from its bar each become one entry on the page — who, what,
 * and each field from what to what in the App's words (the caption, a
 * vocabulary's word, a reference by its record's name) — and a column the
 * App redacts says only that it changed. The database is asked what the
 * store kept, never the screen alone.
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
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-history-browser-'));
  db = join(directory, 'records.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO person VALUES (1, 'Ada North'), (2, 'Bea South');
      CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'on_hold', 'done')),
        owner_id INTEGER REFERENCES person(id), budget INTEGER);
      INSERT INTO task VALUES (1, 'Call the depot', 'open', 1, 500), (2, 'File the report', 'open', 2, 100);`);
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
      id: 'history',
      name: 'History proof',
      connection: 'history',
      resources: {
        task: {
          access: 'write',
          labels: { subject: 'Subject', owner_id: 'Owner', budget: 'Budget' },
          audit: { redact: ['budget'] },
          actions: { putOnHold: { label: 'Put on hold', set: { status: 'on_hold' }, when: 'status = open' } },
        },
        person: {},
      },
      views: {
        tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['subject', 'status', 'owner_id.name'], editable: ['owner_id'] },
      },
      pages: {
        task: { base: 'task', sections: [{ kind: 'fields', show: ['subject', 'status', 'owner_id', 'budget'] }, { kind: 'history' }] },
      },
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

test("a cell, a Save and an action each become one entry on the record, in the App's words", async ({ page }) => {
  await page.goto(`${origin}/history/tasks`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  // The list reads newest first; task 1 is the one the store is asked about.
  const row = page.locator('.result-table tbody tr[data-row-key]').filter({ hasText: 'Call the depot' });
  await row.getByRole('button', { name: 'Edit Owner' }).click();
  await row.locator('.picker-input').fill('Bea');
  await page.locator('.picker-option', { hasText: 'Bea South' }).first().click();
  await expect.poll(() => Number(scalar(db, 'SELECT owner_id FROM task WHERE id = 1'))).toBe(2);

  // The budget is written as a Save would, through the record's own update.
  const saved = await page.evaluate(
    async () =>
      (
        await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: 'history', table: 'task', key: { id: 1 }, values: { budget: 750 }, expected: { budget: 500 } }),
        })
      ).status,
  );
  expect(saved).toBe(200);

  await page.goto(`${origin}/history/@task~1`);
  await page.getByRole('button', { name: 'Put on hold' }).click();
  await expect.poll(() => scalar(db, 'SELECT status FROM task WHERE id = 1')).toBe('on_hold');

  const section = page.locator('.page-history');
  await expect(section.getByRole('heading', { name: 'History' })).toBeVisible();
  const entries = section.locator('.history-entry');
  await expect(entries).toHaveCount(3);
  // Newest first: the action by its label, the vocabulary's words.
  await expect(entries.nth(0).locator('.history-what')).toHaveText('Put on hold');
  // Nobody is signed in to this App: a write is someone's, never an address.
  await expect(entries.nth(0).locator('.history-by')).toHaveText('Someone');
  await expect(section).not.toContainText('@');
  await expect(entries.nth(0)).toContainText('Open');
  await expect(entries.nth(0)).toContainText('On hold');
  // A redacted column changed, and its values are nowhere on the page.
  await expect(entries.nth(1)).toContainText('Budget');
  await expect(entries.nth(1).locator('.history-changed')).toHaveText('changed');
  await expect(section).not.toContainText('750');
  // The reference, by its people's names; the cell's write is a plain edit.
  await expect(entries.nth(2).locator('.history-what')).toHaveText('Edited');
  await expect(entries.nth(2).locator('.history-before')).toHaveText('Ada North');
  await expect(entries.nth(2).locator('.history-after')).toHaveText('Bea South');

  const stored = String(scalar(db, 'SELECT group_concat(changes_json) FROM __mistri_history_change'));
  expect(stored).not.toContain('750');
  expect(Number(scalar(db, 'SELECT COUNT(*) FROM __mistri_history_change'))).toBe(3);
});

test('a record nothing has changed says so, and reads on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/history/@task~2`);
  const section = page.locator('.page-history');
  await expect(section.locator('.empty-note')).toContainText('No changes recorded yet.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
