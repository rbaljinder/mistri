/**
 * The query language, through the bar it is typed into.
 *
 * `test/language.test.ts` proves the parser is right. None of it proves that
 * what you type reaches the parser, that an error comes back where you can
 * read it, or that clicking a column header *writes the sort into the text* —
 * which is the design decision the whole interface rests on: the query bar is
 * the single source of truth, so anything the interface builds has to be
 * visible there, editable there, and shareable as a link.
 */
import { DEMO, DEMO_DB, expect, test } from './support/ownServers';
import { count, scalar } from './support/db';
import { dataRows, errors, open, queryBar, runQuery } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test('a value can be looked for without naming a table first', async ({ page }) => {
  /* The question you have when a string arrives from somewhere else — an id
     in a stack trace, a name in a ticket — and cannot yet name the table it
     belongs to, which is what every other search here starts by asking for.
     The sweep is the `find` tool the MCP server offers, run through the same
     endpoint an agent uses, so the two sides cannot disagree about what a
     match is or what was capped. */
  await open(page, DEMO, 'customer');

  /* Started from the cell under the cursor: the question nearly always
     arrives while looking at a value, and retyping what is on screen is the
     tax this tool exists to remove. The cursor is the grid's own — focusing
     the table puts it on a cell, and the arrows move it. */
  await page.locator('table[role=grid]').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.cell-cursor')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('find a value');
  await page.getByRole('option', { name: /Find a value/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Find a value' });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole('searchbox', { name: 'Value to look for' });
  await expect(box).not.toHaveValue('');
  await box.fill('Harbour');

  /* Grouped by table, because "which table mentions this" is the question. */
  await expect(dialog.locator('.find-group-head').first()).toContainText('customer');
  const hit = dialog.locator('.find-hit').first();
  await expect(hit).toContainText('Harbour');

  /* And a match is a place, not a report: clicking one opens the row. */
  await hit.click();
  await expect(page.locator('.record-heading')).toContainText('Harbour');
});

test('the shape can be checked from the browser, not only from CI', async ({ page }) => {
  /* `lint` answers this for an agent and `--lint` answers it for a build.
     The person who can actually add the index had no way to ask. */
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('check the shape');
  await page.getByRole('option', { name: /Check the shape/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Check the shape' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.shape-check-table').first()).toBeVisible();

  /* The cost is said once per rule, with the columns under it: the demo has
     several unindexed references and one sentence explaining them. */
  const why = dialog.locator('.shape-check-why', { hasText: 'Every walk back' });
  await expect(why.first()).toBeVisible();
  await expect(dialog.locator('.shape-check-item').first()).toContainText('→');

  /* And a finding is a place: the heading opens the table it is about. */
  const first = dialog.locator('.shape-check-table').first();
  const table = (await first.textContent())!.replace(/\d+$/, '').trim();
  await first.click();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue(table);
});

test('a filter narrows the rows to what the database holds', async ({ page }) => {
  const all = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice');
  const over500 = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice WHERE total > 500');
  expect(over500).toBeLessThan(all); // the fixture has to make this test possible

  await open(page, DEMO, 'invoice');
  await expect(dataRows(page)).toHaveCount(all);

  await runQuery(page, 'invoice total > 500');
  await expect(dataRows(page)).toHaveCount(over500);
  // The header restates the count, and the two must agree — a grid showing
  // three rows above the words "7 rows" is a page arguing with itself.
  await expect(page.locator('.result-head')).toContainText(`${over500} rows`);
});

test('a misspelt column is reported, with the column it probably meant', async ({ page }) => {
  await open(page, DEMO, 'invoice');
  await runQuery(page, 'invoice totl > 500');

  /* The suggestion is the whole point. "Unknown column" sends you to read the
     schema; naming the near miss ends the interruption in one line. */
  await expect(errors(page)).toBeVisible();
  await expect(errors(page)).toHaveText('"totl" is not a column on invoice. Did you mean "total"?');

  // And nothing is rendered as though it were an answer.
  await expect(page.getByText('Fix the query above to see results.')).toBeVisible();
});

test('clicking a column header writes the sort into the query', async ({ page }) => {
  await open(page, DEMO, 'invoice');
  const lowest = String(scalar(DEMO_DB, 'SELECT MIN(id) FROM invoice'));

  await page.getByRole('button', { name: /^id key/ }).click();

  /* Not "the grid re-sorted": the *text* changed. A sort held in UI state
     cannot be edited, saved as a view, or sent to anyone. */
  await expect(queryBar(page)).toHaveValue('invoice sort id');
  await expect(dataRows(page).first()).toContainText(lowest);
  await expect(page).toHaveURL(/invoice%20sort%20id$/);

  // A second click cycles to descending rather than re-sorting ascending.
  await page.getByRole('button', { name: /^id key/ }).click();
  await expect(queryBar(page)).toHaveValue('invoice sort id desc');
  await expect(dataRows(page).first()).toContainText(String(scalar(DEMO_DB, 'SELECT MAX(id) FROM invoice')));
});

test('clause chips take a clause off, and rewrite the text and the link', async ({ page }) => {
  await open(page, DEMO, 'invoice total > 500 sort total desc');
  const over500 = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice WHERE total > 500');

  // One chip per clause, each naming what it would remove.
  const sortChip = page.getByRole('button', { name: 'Remove sorted by total desc' });
  const filterChip = page.getByRole('button', { name: 'Remove where total > 500' });
  await expect(sortChip).toBeVisible();
  await expect(filterChip).toBeVisible();

  await sortChip.click();

  /* The text is rewritten, not annotated: this is the interface *un-writing*
     the language, which is the thing it could not do before chips existed. */
  await expect(queryBar(page)).toHaveValue('invoice total > 500');
  await expect(page).toHaveURL(/invoice%20total%20%3E%20500$/);
  await expect(dataRows(page)).toHaveCount(over500);
  await expect(sortChip).toBeHidden();

  // And the filter chip still removes only its own condition.
  await filterChip.click();
  await expect(queryBar(page)).toHaveValue('invoice');
  await expect(dataRows(page)).toHaveCount(count(DEMO_DB, 'SELECT COUNT(*) FROM invoice'));
});

test('a query-bar view without a count renders rows without inventing a total', async ({ page }) => {
  const all = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice');
  expect(all).toBeGreaterThan(0);
  let uncounted = 0;
  await page.route('**/api/run', async (route) => {
    const body = route.request().postDataJSON();
    if (!String(body.q).includes('customer_id.name')) return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    expect(result.view).toBeTruthy();
    // A provider without countView returns this same envelope. Keep the real
    // query's rows and metadata, omitting only the unsupported count evidence.
    delete result.total;
    delete result.exactTotal;
    uncounted++;
    await route.fulfill({ response, json: result });
  });
  await open(page, DEMO, 'invoice show id, customer_id.name');
  await expect(dataRows(page)).toHaveCount(all);
  await expect(page.locator('.result-head')).toContainText(`${all} rows shown`);
  await expect(page.locator('.result-head')).not.toContainText('undefined');
  await expect(page.getByRole('button', { name: 'Last page' })).toHaveCount(0);
  expect(uncounted).toBeGreaterThan(0);
});
