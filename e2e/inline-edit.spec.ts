import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './support/harness';
import { TMP } from './support/fixtures';
import { scalar } from './support/db';

/* The day the Compass database is seeded for, and the instant its server
   believes it is — fixtures.ts's CRM pair, spelled here because importing a
   fixture name reads as addressing the shared CRM server (e2e-lanes.mjs). */
const CRM_TODAY = '2026-09-04';
const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;

/**
 * A list view's `editable` in Compass's Tasks: priority, due date and owner
 * change in place, and "Set field…" writes one owner to a selection. Every
 * cell is the record form's update — the database's own CHECK refuses a
 * priority of 9, the cell puts the stored value back and says why — and the
 * database is asked what was written, never the screen alone.
 *
 * A server of its own over a fresh Compass database (listen(0), mkdtemp),
 * so it runs beside the other parallel specs and edits nothing they read.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'inline-edit-'));
  db = join(directory, 'crm.db');
  execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), db], {
    stdio: 'pipe',
    env: { ...process.env, MISTRI_CRM_TODAY: CRM_TODAY },
  });
  const config = join(directory, 'crm.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));
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
      config,
      '--app',
      'test/fixtures/apps/crm',
      '--port',
      String(port),
    ],
    {
      env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0', MISTRI_CLOCK: CRM_CLOCK },
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
    const timer = setTimeout(() => fail(new Error(`Compass did not start: ${log}`)), 20_000);
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`Compass exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
});

/** The Open tab of Tasks, as a table, and the key of the row at `index`. */
async function openTasks(page: Page) {
  await page.goto(`${origin}/tasks?tab=open`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.locator('.result-table tbody tr[data-row-key]').first()).toBeVisible();
}
const rowAt = (page: Page, index: number) => page.locator('.result-table tbody tr[data-row-key]').nth(index);
async function idOf(page: Page, index: number): Promise<number> {
  const key = await rowAt(page, index).getAttribute('data-row-key');
  return Number((JSON.parse(key!) as Array<[string, string]>).find(([column]) => column === 'id')![1]);
}
const task = (id: number, column: string) => scalar(db, `SELECT ${column} FROM task WHERE id = ?`, id);

test('a priority is changed in place: Enter saves the record, Esc puts it back, Tab moves on', async ({ page }) => {
  await openTasks(page);
  const id = await idOf(page, 0);
  const row = rowAt(page, 0);
  const before = Number(task(id, 'priority'));
  const next = before === 1 ? 2 : 1;

  // Esc: the stored value, nothing written.
  await row.getByRole('button', { name: 'Edit Priority' }).click();
  await row.getByRole('textbox', { name: 'Priority' }).fill(String(next));
  await page.keyboard.press('Escape');
  await expect(row.getByRole('button', { name: 'Edit Priority' })).toHaveText(String(before));
  expect(Number(task(id, 'priority'))).toBe(before);

  // Enter: the record form's update, confirmed in the toast, stored.
  await row.getByRole('button', { name: 'Edit Priority' }).click();
  await row.getByRole('textbox', { name: 'Priority' }).fill(String(next));
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast').getByText('Saved Priority.')).toBeVisible();
  await expect.poll(() => Number(task(id, 'priority'))).toBe(next);
  await expect(row.getByRole('button', { name: 'Edit Priority' })).toHaveText(String(next));

  // Tab: saves (unchanged here) and opens the row's next editable cell, the due date.
  await row.getByRole('button', { name: 'Edit Priority' }).click();
  await page.keyboard.press('Tab');
  await expect(row.getByRole('textbox', { name: 'Due' })).toBeFocused();
  await page.keyboard.press('Escape');
});

test('a value the database refuses is put back, and the reason is said', async ({ page }) => {
  await openTasks(page);
  const id = await idOf(page, 1);
  const row = rowAt(page, 1);
  const before = String(task(id, 'priority'));
  await row.getByRole('button', { name: 'Edit Priority' }).click();
  await row.getByRole('textbox', { name: 'Priority' }).fill('9');
  await page.keyboard.press('Enter');
  // The App's own sentence for a database refusal, naming the field by its caption, never the engine's text.
  await expect(page.locator('.toast')).toContainText('Priority is not an allowed value.');
  await expect(row.getByRole('button', { name: 'Edit Priority' })).toHaveText(before);
  expect(String(task(id, 'priority'))).toBe(before);
});

test('the keyboard opens a cell: Enter or F2 on the cursor, and a click on it never opens the row', async ({ page }) => {
  await openTasks(page);
  const row = rowAt(page, 2);
  const cell = row.locator('td.cell-editable').first();
  await cell.click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(/\/tasks/);
  await page.keyboard.press('Escape');
  await cell.focus();
  await page.keyboard.press('F2');
  await expect(row.locator('.cell-edit-surface')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row.locator('.cell-edit-surface')).toHaveCount(0);
  // Esc leaves the cursor on the cell, where Enter opens the editor again.
  await expect(cell).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row.locator('.cell-edit-surface')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/tasks\?tab=open$/);
});

test('an owner is chosen by name in place, and "Set field…" hands a selection to one person', async ({ page }) => {
  await openTasks(page);
  const first = await idOf(page, 3);
  const second = await idOf(page, 4);
  const current = Number(task(first, 'owner_id'));
  const rep = scalar(db, 'SELECT id FROM sales_rep WHERE id <> ? ORDER BY id LIMIT 1', current) as number;
  const name = String(scalar(db, 'SELECT name FROM sales_rep WHERE id = ?', rep));

  const row = rowAt(page, 3);
  const currentName = String(scalar(db, 'SELECT name FROM sales_rep WHERE id = ?', current));
  /* The editor opens on the name the cell already draws, never the owner's
     id. It used to open on the id and rename itself when the label landed,
     which raced typing under a loaded gate (the search went out as
     "<current name>Freya"). The picker's own label request is held until
     the box has said the name, so only the cell's name can have said it. */
  const held: Array<() => Promise<void>> = [];
  const labels = /\/api\/(query|view\/run)$/;
  await page.route(labels, (route) => {
    if ((route.request().postData() ?? '').includes('"op":"in"')) held.push(() => route.continue().catch(() => {}));
    else void route.continue();
  });
  await row.getByRole('button', { name: 'Edit Owner' }).click();
  await expect(row.locator('.picker-input')).toHaveValue(currentName);
  // A request the page gave up on is already settled; the rest go on.
  for (const release of held) await release();
  await page.unroute(labels);
  await row.locator('.picker-input').fill(name.split(' ')[0]);
  await page.locator('.picker-option', { hasText: name }).first().click();
  await expect.poll(() => Number(task(first, 'owner_id'))).toBe(rep);
  await expect(row.getByRole('button', { name: 'Edit Owner' })).toContainText(name);

  // Hand both rows to the person before the first one's owner.
  const other = scalar(db, 'SELECT id FROM sales_rep WHERE id <> ? ORDER BY id DESC LIMIT 1', rep) as number;
  const otherName = String(scalar(db, 'SELECT name FROM sales_rep WHERE id = ?', other));
  await rowAt(page, 3).getByRole('checkbox').check();
  await rowAt(page, 4).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Set field…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set a field' });
  await expect(dialog).toContainText('Writes one value to 2 selected records.');
  await dialog.getByRole('button', { name: 'Field', exact: true }).click();
  await page.getByRole('option', { name: 'Owner', exact: true }).click();
  await dialog.locator('.picker-input').fill(otherName.split(' ')[0]);
  await dialog.locator('.picker-option', { hasText: otherName }).first().click();
  await dialog.getByRole('button', { name: 'Set Owner' }).click();
  await expect(page.locator('.queue-result')).toContainText('Set Owner: 2 applied.');
  await expect.poll(() => [Number(task(first, 'owner_id')), Number(task(second, 'owner_id'))]).toEqual([other, other]);
});
