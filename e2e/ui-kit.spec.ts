import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';
import { TMP } from './support/fixtures';
import { rows, scalar } from './support/db';

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      const directory = mkdtempSync(join(TMP, 'ui-kit-'));
      db = join(directory, 'desk.db');
      execFileSync(process.execPath, [resolve('test/fixtures/apps/kit-desk/seed.mjs'), db], { stdio: 'pipe' });
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((done) => reservation.close(() => done()));
      origin = `http://127.0.0.1:${port}`;
      const started = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          '--config',
          `${db}.json`,
          '--app',
          'test/fixtures/apps/kit-desk',
          '--port',
          String(port),
        ],
        { env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
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
        const timer = setTimeout(() => fail(new Error(`Kit desk did not start: ${log}`)), 20_000);
        const ready = () => {
          if (log.includes('Listening on ')) {
            clearTimeout(timer);
            done();
          }
        };
        started.stdout!.on('data', ready);
        started.once('exit', () => {
          clearTimeout(timer);
          fail(new Error(`Kit desk exited: ${log}`));
        });
      });
    },
    async () => {
      if (!child || child.exitCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    },
  ),
});

/**
 * An App's control kit (`uiKit`, Preview; test/fixtures/apps/kit-desk): the
 * kit is named in the page head and installed before the first render, so a
 * button, a dialog, a row's menu, a typeahead and a date field are the kit's
 * from the first paint — each says so with `data-kit` — and the page around
 * them is still the platform's. The database is asked what a save wrote.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp), so it runs
 * beside the other parallel specs and edits nothing they read.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test("a record page draws the kit's controls from the first paint, with nothing moving", async ({ page }) => {
  await page.goto(`${origin}/tasks/1`);
  const kit = await page.locator('meta[name="mistri-ui-kit"]').getAttribute('content');
  expect(kit).toMatch(/^\/_components\/ui-kit-[0-9a-f]+\.js$/);
  await expect(page.getByRole('heading', { name: 'Order paper' })).toBeVisible();
  await expect(page.locator('[data-kit="button"]', { hasText: 'Close task' })).toBeVisible();
  // Applied before the first render, not swapped in after it: the page that paints is the page that stays.
  const shifts = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
            if (!entry.hadRecentInput) total += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => done(total), 500);
      }),
  );
  expect(shifts).toBe(0);
});

test("a row's menu is the kit's menu, and its verb asks through the kit's dialog", async ({ page }) => {
  await page.goto(`${origin}/tasks`);
  await expect(page.locator('[data-kit="drop-menu"]', { hasText: 'Export' })).toBeVisible();
  const row = page.locator('.result-table tbody tr', { hasText: 'Order paper' });
  await row.getByRole('button', { name: 'Actions for Order paper' }).click();
  const menu = page.locator('[data-kit="drop-menu"]').getByRole('menu');
  await menu.locator('[data-kit="drop-item"]', { hasText: 'Close task' }).click();
  const dialog = page.locator('[data-kit="modal"]').getByRole('dialog');
  await expect(dialog).toContainText('Close task?');
  // Cancelled, so the record page's own confirmation below finds the task still open.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-kit="modal"]')).toHaveCount(0);
  expect(scalar(db, 'SELECT status FROM task WHERE id = 1')).toBe('open');
});

test("an action's confirmation is the kit's dialog, and confirming it writes", async ({ page }) => {
  await page.goto(`${origin}/tasks/1`);
  await page.locator('[data-kit="button"]', { hasText: 'Close task' }).click();
  const dialog = page.locator('[data-kit="modal"]').getByRole('dialog');
  await expect(dialog).toContainText('Close task?');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-kit', 'button');
  await dialog.getByRole('button', { name: 'Close task' }).click();
  await expect(page.locator('[data-kit="modal"]')).toHaveCount(0);
  await expect.poll(() => scalar(db, 'SELECT status FROM task WHERE id = 1')).toBe('closed');
});

test("a New form saves through the kit's typeahead, date field and buttons", async ({ page }) => {
  await page.goto(`${origin}/tasks/new`);
  await page.getByRole('textbox', { name: 'Title' }).fill('Book the van');

  const owner = page.getByRole('combobox', { name: 'Owner' });
  await expect(owner).toHaveAttribute('data-kit', 'typeahead');
  await owner.fill('Bea');
  await page.getByRole('option', { name: 'Bea Birch' }).click();
  await expect(owner).toHaveValue('Bea Birch');

  const due = page.locator('[data-kit="date-field"]');
  await due.getByRole('button', { name: 'Choose date for Due' }).click();
  await due.getByLabel('Calendar for Due').fill('2026-04-01');
  await expect(due.getByRole('textbox', { name: 'Due' })).toHaveValue('2026-04-01');

  await expect(page.locator('[data-kit="button"]', { hasText: 'Cancel' })).toBeVisible();
  await page.locator('[data-kit="button"]', { hasText: /^Add$/ }).click();
  await expect
    .poll(() => rows(db, "SELECT owner_id, due, status FROM task WHERE title = 'Book the van'").map((task) => ({ ...task })))
    .toEqual([{ owner_id: 2, due: '2026-04-01', status: 'open' }]);
});
