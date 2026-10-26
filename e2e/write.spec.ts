/**
 * Write mode: staging, applying, and undoing.
 *
 * The frightening part of this tool, and the part where a rendering bug costs
 * data rather than patience. Every assertion here is about a thing the reader
 * has to be able to see before the write lands: that the edit is *staged* and
 * not saved, that the statement is shown before it runs, that the confirmation
 * offers a way back, and — the one that cannot be tested any other way — that
 * the database afterwards holds what the page claimed.
 *
 * The last test is the important one. `writable` is a property of the
 * *server's* config, not of the browser's toggle, and the browser will
 * cheerfully offer an editor on a connection the server will refuse. That is
 * the design: the guard is the one the page cannot talk its way past. Proving
 * it means driving the UI into a write it is not allowed to make.
 */
import { DEMO, DEMO_DB, expect, SCRATCH, SCRATCH_DB, test } from './support/ownServers';
import { scalar } from './support/db';
import { dataRows, enableWriteMode, follow, open, toast } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/** A row nothing else in the suite reads, so a write cannot disturb a read. */
const ROW = 2;
const EDITED = 'e2e-edited@example.com';

test('an edit is staged, applied, and undoable', async ({ page }) => {
  const original = String(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW));

  /* Chosen from the picker rather than by link, because switching database is
     one of the two ways someone arrives on a writable connection and the other
     one is already covered by the deep-link tests. */
  await open(page, DEMO, 'customer');
  await page.getByRole('button', { name: 'Database connection' }).click();
  await page.getByRole('option', { name: new RegExp(SCRATCH) }).click();
  await expect(page.locator('#db-label')).toContainText(SCRATCH);

  await enableWriteMode(page);

  // By boundary: the sidebar row's accessible name carries the row estimate.
  await page
    .locator('#table-list')
    .getByRole('button', { name: /^customer\b/ })
    .click();
  await dataRows(page).filter({ hasText: original }).click();

  const field = page.getByLabel('email (TEXT)');
  await expect(field).toHaveValue(original);
  await field.fill(EDITED);

  /* Staged, not saved. Several fields become one statement, and a bar that
     says so is what stops "I typed it, so it is in the database". */
  await expect(page.locator('.pending')).toContainText('1 unsaved change');
  expect(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW)).toBe(original);

  await page.getByRole('button', { name: 'Review & apply' }).click();

  /* The confirmation shows the statement and the before/after, because the
     question worth answering is not "are you sure" but "does this say what you
     think it says". */
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Apply this change?');
  await expect(confirm).toContainText('UPDATE "customer"');
  await expect(confirm).toContainText(original);
  await expect(confirm).toContainText(EDITED);
  await confirm.getByRole('button', { name: 'Apply' }).click();

  await expect(toast(page)).toContainText('Updated 1 column on customer.');
  /* And it announces itself: the toast is how a write reports, so it has to
     reach a screen reader without being looked for. The shown box comes and
     goes, and a region that arrives already holding its words is not heard,
     so it speaks through the status region it names, which is always on the
     page. */
  const live = page.locator(`#${await toast(page).getAttribute('data-live')}`);
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toContainText('Updated 1 column on customer.');
  await expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW)).toBe(EDITED);

  /* Undo is offered *here*, beside the confirmation, because this is the
     moment someone realises it was the wrong row. Finding it in a menu costs
     the seconds in which they still remember what they changed. */
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  /* The journal names the write it undid rather than the columns it restored.
     "Put back email on customer" only reads correctly for an update — undoing
     an insert *removes* a row — and the same sentence now has to cover all
     three. */
  await expect(toast(page)).toContainText('Undone: Updated customer');
  await expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW)).toBe(original);
  // And the field on the page agrees with the database again.
  await expect(page.getByLabel('email (TEXT)')).toHaveValue(original);
});

test('a record is edited from its page, and a boolean is a choice not a box', async ({ page }) => {
  /* Write mode is a property of the connection, not of the view — so the
     fields on a page edit exactly as the fields on a record do, through the
     same staging and the same confirmation. Nothing in the page had offered
     it, so the only way to change a value you were looking at was to leave
     the page you were looking at it on. */
  /* A row of its own: `2` belongs to the test above and `3` to the undo test
     in the mutations suite, and two tests writing one row is a pass that
     depends on the order they happen to run in. */
  const ROW_ON_PAGE = 5;
  const original = String(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW_ON_PAGE));

  await open(page, SCRATCH, 'customer');
  await enableWriteMode(page);
  await page.getByRole('combobox', { name: 'Query' }).fill(`customer id = ${ROW_ON_PAGE}`);
  await page.getByRole('button', { name: 'Run' }).click();
  await dataRows(page).first().click();
  await page.getByRole('button', { name: 'As a page' }).click();

  /* The button that opens the builder says "Layout": "Edit" on a page full
     of a record's values reads as a promise to edit the record, which is now
     what the fields themselves do. */
  await expect(page.getByRole('button', { name: /^(Layout|Copy layout)$/ })).toBeVisible();

  /* A boolean is a select of the values the column actually stores — this
     one is an integer flag, so the values written back are 1 and 0. */
  const active = page.getByLabel(/^active/);
  await expect(active).toHaveJSProperty('tagName', 'SELECT');
  await expect(active.locator('option')).toHaveText(['yes', 'no']);

  const email = page.getByLabel('email (TEXT)');
  await email.fill(EDITED);
  await expect(page.locator('.pending')).toContainText('1 unsaved change');
  expect(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW_ON_PAGE)).toBe(original);

  await page.getByRole('button', { name: 'Review & apply' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('UPDATE "customer"');
  await confirm.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW_ON_PAGE)).toBe(EDITED);

  // Put back, so the suite can run twice against the same file.
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', ROW_ON_PAGE)).toBe(original);
});

test('a read-only connection refuses the write, in the words of the config', async ({ page }) => {
  const original = String(scalar(DEMO_DB, 'SELECT email FROM customer WHERE id = 1'));

  await open(page, DEMO, 'customer');
  await enableWriteMode(page);
  await dataRows(page).filter({ hasText: original }).click();

  await page.getByLabel('email (TEXT)').fill('should-not-land@example.com');
  await page.getByRole('button', { name: 'Review & apply' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();

  /* Named, and actionable. "Forbidden" would leave the reader guessing which
     of the three connections refused and what to do about it; this says both,
     and it comes from the server rather than from a check in the page. */
  await expect(toast(page)).toContainText('"demo" is read-only.');
  await expect(toast(page)).toContainText('Add "writable": true to its entry in your tablewalk.json');

  // The negative, and then the proof that nothing happened anyway.
  expect(scalar(DEMO_DB, 'SELECT email FROM customer WHERE id = 1')).toBe(original);
  // The edit is not thrown away either: it stays staged to be corrected.
  await expect(page.locator('.pending')).toContainText('1 unsaved change');
});

test('an open SQL editor follows the connection it is switched to', async ({ page }) => {
  /* The panel is built entirely from state — the database it names, the
     dialect, whether a write is offered, which draft is in the box — and for a
     long time it was built once. Left open across a switch it kept the head it
     started with: it named the previous database while the statement it ran
     went to the new one, and it went on offering "Run as write…" on a
     connection the server would refuse. */
  await open(page, SCRATCH, 'customer');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('button', { name: 'Run as write…' })).toBeVisible();

  /* Followed inside the app rather than loaded fresh: the panel surviving the
     switch is the whole point, and a reload would throw it away before the
     assertion could ask. */
  await follow(page, `/${DEMO}/customer`);
  await expect(page.locator('#db-label')).toContainText(DEMO);

  await expect(page.locator('.sql-target')).toContainText(DEMO);
  await expect(page.getByRole('button', { name: 'Run as write…' })).toHaveCount(0);
});

test('the editor follows a switch made from the picker, not only from a link', async ({ page }) => {
  /* The two ways to change database do not share a code path, and the picker
     is the one people actually use. */
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('.sql-target')).toContainText(DEMO);
  await expect(page.getByRole('button', { name: 'Run as write…' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Database connection' }).click();
  await page.getByRole('option', { name: SCRATCH }).click();
  await expect(page.locator('#db-label')).toContainText(SCRATCH);

  await expect(page.locator('.sql-target')).toContainText(SCRATCH);
  await expect(page.getByRole('button', { name: 'Run as write…' })).toBeVisible();
  // And it is still an editor: the panel was replaced, not closed.
  await expect(page.getByRole('dialog', { name: 'SQL' })).toBeVisible();
});

test('the SQL editor offers a write button only where a write is allowed', async ({ page }) => {
  /* "A button that exists to be refused is a button that lies." */
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('dialog', { name: 'SQL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run as write…' })).toHaveCount(0);

  /* Closed and reopened, which is the other half of the pair: the test above
     covers an editor that stays open across the switch, this one covers one
     built fresh on the new connection. */
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'SQL' })).toHaveCount(0);

  await page.goto(`/${SCRATCH}/customer`);
  await expect(page.locator('#db-label')).toContainText(SCRATCH);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await expect(dataRows(page).first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('button', { name: 'Run as write…' })).toBeVisible();
});

test('a new row is a form the schema wrote, and lands on its record', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await page.getByRole('button', { name: 'Database connection' }).click();
  await page.getByRole('option', { name: new RegExp(SCRATCH) }).click();
  await expect(page.locator('#db-label')).toContainText(SCRATCH);
  await enableWriteMode(page);
  /* By boundary, not exactly: the sidebar row carries the approximate row
     count in its name, and this suite changes that count by inserting. */
  await page
    .locator('#table-list')
    .getByRole('button', { name: /^customer\b/ })
    .click();

  await page.getByRole('button', { name: '+ New row' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('New customer');
  /* The catalog wrote this form: the key says who assigns it, NOT NULL with
     no default is marked, everything else is the database's to fill. */
  await expect(dialog.getByLabel('id (INTEGER)')).toHaveAttribute('placeholder', 'assigned by the database');
  await expect(dialog.locator('.insert-field', { hasText: 'name' }).first()).toContainText('required');

  await dialog.getByLabel('name (TEXT)').fill('E2E Insert Co');
  await dialog.getByRole('button', { name: 'Add row' }).click();

  await expect(toast(page)).toContainText('Added customer · E2E Insert Co');
  /* Landed on the record the database stored: defaults filled — active
     defaulted on, shown in its editable field because write mode is on. */
  await expect(page.locator('.record-heading')).toContainText('E2E Insert Co');
  await expect(page.getByLabel('active (INTEGER)')).toHaveValue('1');
  expect(scalar(SCRATCH_DB, "SELECT active FROM customer WHERE name = 'E2E Insert Co'")).toBe(1);
});

test("the database's refusal reaches the form in its own words", async ({ page }) => {
  await open(page, DEMO, 'country');
  await page.getByRole('button', { name: 'Database connection' }).click();
  await page.getByRole('option', { name: new RegExp(SCRATCH) }).click();
  await expect(page.locator('#db-label')).toContainText(SCRATCH);
  await enableWriteMode(page);
  await page
    .locator('#table-list')
    .getByRole('button', { name: /^country\b/ })
    .click();

  await page.getByRole('button', { name: '+ New row' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('code (TEXT)').fill('AU');
  await dialog.getByLabel('name (TEXT)').fill('Again');
  await dialog.getByRole('button', { name: 'Add row' }).click();

  /* The dialog stays open with the constraint named — the engine's message,
     because it says which constraint better than a paraphrase would. */
  await expect(dialog).toContainText('UNIQUE constraint failed: country.code');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard record' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
