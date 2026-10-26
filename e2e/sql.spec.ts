/**
 * The SQL editor.
 *
 * `test/sql.test.ts` proves the server refuses a second statement and cannot
 * be made to write. What it cannot show is any of the editor: that ⌘⇧↵ opens
 * it, that the database's own error arrives where you can read it while fixing
 * the statement, that the completion list knows a table follows FROM — or the
 * decision that makes SQL not a dead end, which is that a result carrying a
 * primary key becomes rows you can walk into.
 *
 * The completion list is here for a second reason: it once opened off the
 * bottom of the window, because the editor sits low and the list only ever
 * opened downwards. A list of thirty items that renders two is not a bug any
 * assertion about its contents would have found.
 */
import { DEMO, DEMO_DB, expect, type Page, test } from './support/ownServers';
import { count } from './support/db';
import { open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

const editor = (page: Page) => page.getByRole('combobox', { name: 'SQL statement' });
const suggestions = (page: Page) => page.locator('.ac:not([hidden]) .ac-item');

async function openEditor(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('dialog', { name: 'SQL' })).toBeVisible();
  await expect(editor(page)).toBeFocused();
}

test('⌘⇧↵ opens the editor, and a statement runs and renders', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).fill('select id, name from customer order by id');
  await page.getByRole('button', { name: 'Run ⌘↵' }).click();

  const customers = count(DEMO_DB, 'SELECT COUNT(*) FROM customer');
  await expect(page.locator('.sql-stats')).toContainText(`${customers} rows`);
  await expect(page.locator('.sql-results').getByRole('row')).toHaveCount(customers + 1);
});

test("a bad statement shows the database's own words", async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).fill('select * from custmer');
  await editor(page).press('ControlOrMeta+Enter');

  /* SQLite's wording, kept verbatim. Any paraphrase says less: "no such table"
     plus the name is the whole diagnosis, and an editor that replaced it with
     "Query failed" would send the reader to a terminal to find out why. */
  await expect(page.locator('.sql-error')).toContainText('no such table: custmer');
  // And nothing that looks like a result is drawn beside it.
  await expect(page.locator('.sql-results table')).toHaveCount(0);
});

test('completion offers tables after FROM and columns after an alias', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).pressSequentially('select * from ');
  await expect(suggestions(page).filter({ hasText: 'customer' }).first()).toBeVisible();
  await expect(suggestions(page).filter({ hasText: 'invoice_line' })).toHaveCount(1);

  /* After `c.` there is a definite answer — nothing but a column of the table
     `c` names can follow — so nothing else is offered. */
  await editor(page).fill('select * from customer c where c');
  await editor(page).pressSequentially('.');
  await expect(suggestions(page).filter({ hasText: 'credit_limit' })).toHaveCount(1);
  await expect(suggestions(page).filter({ hasText: 'FROM' })).toHaveCount(0);
  // Columns of the aliased table only: invoice has none of these.
  await expect(suggestions(page).filter({ hasText: 'invoice_date' })).toHaveCount(0);
});

test('the completion list stays on the screen it is opened on', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);
  await editor(page).pressSequentially('select * from ');

  const list = page.locator('.ac:not([hidden])');
  const box = await list.boundingBox();
  const height = page.viewportSize()!.height;
  expect(box).not.toBeNull();
  /* The editor is docked to the bottom of the window, so a list that only ever
     opens downwards opens off the screen — and looks like a list with two
     items in it. */
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
});

test('a result that can identify a row becomes rows you can walk into', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).fill('select id, name, email from customer where id = 2');
  await editor(page).press('ControlOrMeta+Enter');

  await expect(page.getByText('Rows open as customer records.')).toBeVisible();
  await page.locator('.sql-results tbody tr').first().click();
  // The editor closes and the walk resumes on the record it found.
  await expect(page.getByRole('heading', { name: /customer · Kereru Coffee/ })).toBeVisible();
});

test('a result that cannot identify a row offers no click', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).fill('select count(*) as n from customer');
  await editor(page).press('ControlOrMeta+Enter');

  await expect(page.locator('.sql-results tbody tr')).toHaveCount(1);
  await expect(page.getByText('Rows open as')).toHaveCount(0);
  const row = page.locator('.sql-results tbody tr').first();
  await expect(row).not.toHaveClass(/clickable/);
  expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
});

test('an empty result still says what shape it was', async ({ page }) => {
  /* "No rows" and "something went wrong" are different answers, and the
     adapters go out of their way to report the columns of a result that has
     none. Throwing that away would leave the reader unable to tell which they
     are looking at. */
  await open(page, DEMO, 'customer');
  await openEditor(page);

  await editor(page).fill("select id, name from customer where name = 'nobody'");
  await editor(page).press('ControlOrMeta+Enter');

  await expect(page.getByText('No rows.')).toBeVisible();
  await expect(page.locator('.sql-empty')).toContainText('id, name');
});
