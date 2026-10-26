/**
 * Whether the grid is honest about what it offers.
 *
 * Two of these are the same bug in two directions. A row that keeps its
 * pointer cursor and its click handler after a projection has dropped the key
 * advertises an action it cannot perform — click it and you land on "That row
 * is no longer there", having done nothing wrong. A sort button offered on an
 * unindexed column advertises a free action that is a full table scan.
 *
 * Neither is visible to a unit test: both are about what the page *looks* like
 * it will do.
 */
import { DEMO, DEMO_DB, EDGE, EDGE_LONG_LEN, expect, test, WIDE } from './support/ownServers';
import { count } from './support/db';
import { cursorOf, dataRows, grid, open, queryBar, runQuery } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test('a row that can be opened says so, and opens', async ({ page }) => {
  await open(page, DEMO, 'invoice');

  const row = dataRows(page).first();
  await expect(row).toHaveClass(/clickable/);
  expect(await cursorOf(row)).toBe('pointer');

  await row.click();
  await expect(page.getByRole('heading', { name: /invoice · / })).toBeVisible();
});

test('a projection without the key has no pointer and no click', async ({ page }) => {
  /* `invoice show total` returns rows that genuinely cannot identify
     themselves. The grid used to keep the handler and the cursor and simply do
     nothing, which is the worst of both. */
  await open(page, DEMO, 'invoice show total');
  await expect(dataRows(page)).toHaveCount(count(DEMO_DB, 'SELECT COUNT(*) FROM invoice'));

  const row = dataRows(page).first();
  await expect(row).not.toHaveClass(/clickable/);
  expect(await cursorOf(row)).toBe('default');
  /* Nor an expander: what points at a row is asked by its key, and these rows
     have none to ask with. The triangle used to be drawn anyway and opened
     an empty detail. */
  await expect(page.locator('.expander')).toHaveCount(0);

  const before = page.url();
  await row.click();
  // Still the table. A record heading appearing here would mean the click
  // navigated somewhere the row could not have named.
  await expect(page.getByRole('heading', { name: 'invoice', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /invoice · / })).toHaveCount(0);
  expect(page.url()).toBe(before);
});

test('an unindexed column on a small table can still be sorted from the header', async ({ page }) => {
  await open(page, DEMO, 'invoice');

  /* `customer_id` is not indexed in this fixture, and the header used to
     refuse it: a click there would scan the whole table to show twenty rows,
     and a one-click action with no visible cost should not quietly be a scan.

     That was right on a table of millions and far too careful on this one,
     which has seven rows — so there was no way to sort by an unindexed column
     from the interface at all, on tables where the scan is not measurable.
     Below `SORT_SCAN_BELOW` the offer is made whatever the index says; the
     large-table half of the rule is pinned in test/run.ts, because no fixture
     here has fifty thousand rows in it. */
  const indexed = page.getByRole('button', { name: /^id key/ });
  const unindexed = page.getByRole('button', { name: /^customer_id/ });

  await expect(indexed).toBeEnabled();
  await expect(unindexed).toBeEnabled();

  await unindexed.click();
  await expect(page.locator('#query')).toHaveValue('invoice sort customer_id');
});

test('and both directions are in the column menu whatever the index says', async ({ page }) => {
  /* The menu is where someone looks for what they can do to a column, and
     sorting was reachable only by clicking the header. */
  await open(page, DEMO, 'invoice');
  await page.locator('th', { hasText: 'customer_id' }).locator('.th-filter').click();

  const menu = page.locator('.th-menu');
  await expect(menu.getByRole('menuitem', { name: /Sort ascending/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Sort descending/ })).toBeVisible();

  await menu.getByRole('menuitem', { name: /Sort descending/ }).click();
  await expect(page.locator('#query')).toHaveValue('invoice sort customer_id desc');
});

test('a null renders as null rather than as an empty cell', async ({ page }) => {
  /* invoice 1006 has no salesperson. An empty cell reads as "nothing to say";
     `null` reads as "the database has no value here", and the two are
     different facts. The styling that makes it visibly not-a-value is what the
     class is for. */
  await open(page, DEMO, 'invoice');
  const row = dataRows(page).filter({ hasText: '1006' });
  await expect(row.locator('td.null')).toHaveText('null');
});

test('a document-length cell is capped in the grid but whole on the record', async ({ page }) => {
  await open(page, EDGE, 'document');

  /* A TEXT column can hold a whole document, and the grid shows one clipped
     line. Rendering the raw value into every cell put megabytes in the DOM
     that nobody could read, and a native tooltip that spanned the screen. */
  const longCell = dataRows(page).filter({ hasText: 'long' }).locator('td').last();
  const shown = await longCell.textContent();
  expect(shown!.length).toBeLessThan(400);
  expect(shown!.endsWith('…')).toBe(true);
  /* The count is the useful fact: not "there is more" but how much. */
  await expect(longCell).toHaveAttribute('title', /more characters/);

  /* And the whole thing is on the record, which is where a long value is read. */
  await dataRows(page).filter({ hasText: 'long' }).click();
  const full = page.locator('.long-value').filter({ hasText: 'xxxxx' });
  await expect(full).toBeVisible();
  expect((await full.textContent())!.length).toBe(EDGE_LONG_LEN);
});

test('a 64-bit id is shown with every digit, not rounded to a float', async ({ page }) => {
  await open(page, EDGE, 'bigid');

  /* The most dangerous shape of this bug: it looks right. The server sends
     the id as a string because it is past 2^53, and `Number(x).toLocaleString()`
     rendered it 9223372036854776000 — a different number, off by 193, that
     reads as perfectly valid. The digits have to be exact. */
  const cell = dataRows(page).filter({ hasText: 'int64 max' }).locator('td.num').first();
  await expect(cell).toHaveText('9,223,372,036,854,775,807');
  await expect(cell).toHaveAttribute('title', '9223372036854775807');

  /* And the record page, where a value is read most carefully. */
  await dataRows(page).filter({ hasText: 'int64 max' }).click();
  await expect(page.locator('.num-value').filter({ hasText: '9,223,372' }).first()).toHaveText('9,223,372,036,854,775,807');
});

test('every row that can name itself carries one host, across sort and page', async ({ page }) => {
  /* A row's leading cell is its host (components/RowHost.tsx): the one place
     a presentation can put something into a row without replacing the grid.
     The expander is the first thing drawn there, so every keyed row has
     exactly one host holding exactly one expander, and says which row it is
     as a string. A sort and a page each re-ask the room in place (core.js
     `refine`) and swap every row on screen; the decoration has to be on
     every new row each time, on the rows it belongs to. */
  await open(page, WIDE, 'invoice');
  await page.getByRole('button', { name: 'Rows per page' }).click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await expect(dataRows(page)).toHaveCount(10);

  const decorated = async (): Promise<string[]> => {
    const rows = dataRows(page);
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await expect(rows.locator('> td.row-host:first-child > button.expander')).toHaveCount(n);
    const keys = await rows.evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.rowKey ?? ''));
    expect(new Set(keys).size).toBe(n);
    for (const key of keys) expect(key).toMatch(/^\[\["id","\d+"\]\]$/);
    return keys;
  };
  const first = await decorated();

  /* This table's default order is newest first, so the explicit sort is the
     other way round and every row on screen changes. */
  await page.getByRole('button', { name: 'Filter on id', exact: true }).click();
  await page
    .locator('.th-menu')
    .getByRole('menuitem', { name: /Sort ascending/ })
    .click();
  await expect(page.locator('#query')).toHaveValue('invoice sort id');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '1']]));
  const sorted = await decorated();
  expect(sorted.filter((key) => first.includes(key))).toEqual([]);

  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.page-input')).toHaveValue('2');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '11']]));
  const next = await decorated();
  expect(next.filter((key) => sorted.includes(key))).toEqual([]);
});

test('a 64-bit key stays a string on its row, whichever way the rows are sorted', async ({ page }) => {
  /* The row's key is what a decoration is found by. Run through Number() it
     would be 9223372036854775808 — a key for a row that does not exist, and
     a decoration that silently lands nowhere. */
  const big = JSON.stringify([['id', '9223372036854775807']]);
  await open(page, EDGE, 'bigid sort id desc');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', big);
  await runQuery(page, 'bigid sort id');
  await expect(dataRows(page).filter({ hasText: 'int64 max' })).toHaveAttribute('data-row-key', big);
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '1']]));
});

test('a header sort re-asks in place: an open row stays open, and the focus stays where it was', async ({ page }) => {
  /* A sort used to repaint the room, so everything in it started over: the
     open row closed and the focus fell to the page. The room now re-asks its
     question in place (core.js `refine`), and the rows move by key. */
  await open(page, DEMO, 'invoice sort id');
  const key = JSON.stringify([['id', '1001']]);
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', key);
  const expander = page.locator(`tbody tr[data-row-key='${key}'] > td.row-host button.expander`);
  const detail = page.locator(`tbody tr[data-row-key='${key}'] + tr.detail-row`);
  await expander.click();
  await expect(expander).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  await expander.evaluate((el) => {
    (el as HTMLElement).dataset.probe = 'mounted-once';
  });

  /* A click that does not take the focus, the way a refresh or a shortcut
     would arrive, so the expander still holds it. Reversing the order moves
     this row from first to last: React moves its element rather than
     drawing a new one. */
  await page.locator('th .th-sort', { hasText: /^id/ }).evaluate((b) => (b as HTMLElement).click());
  await expect(queryBar(page)).toHaveValue('invoice sort id desc');
  await expect(dataRows(page).last()).toHaveAttribute('data-row-key', key);
  await expect(expander).toHaveAttribute('data-probe', 'mounted-once');
  await expect(expander).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  await expect(expander).toBeFocused();

  /* From the keyboard: the header that sorted keeps the focus, so a second
     Enter turns the order round again. */
  const sort = page.getByRole('button', { name: /^id key/ });
  await sort.focus();
  await page.keyboard.press('Enter');
  await expect(queryBar(page)).toHaveValue('invoice sort id');
  await expect(sort).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(queryBar(page)).toHaveValue('invoice sort id desc');
  await expect(sort).toBeFocused();
  await expect(expander).toHaveAttribute('data-probe', 'mounted-once');
  await expect(expander).toHaveAttribute('aria-expanded', 'true');
});

test('a page and back re-asks in place: the same grid, the same address', async ({ page }) => {
  await open(page, WIDE, 'invoice');
  await page.getByRole('button', { name: 'Rows per page' }).click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await expect(dataRows(page)).toHaveCount(10);
  const first = (await dataRows(page).first().getAttribute('data-row-key'))!;
  /* Set once, on the element the grid mounted. A room that started over
     would draw a new table without it. */
  const table = grid(page).locator('> table');
  await table.evaluate((t) => {
    (t as HTMLElement).dataset.probe = 'mounted-once';
  });
  const address = page.url();
  const entries = await page.evaluate(() => history.length);

  const next = page.getByRole('button', { name: 'Next page' });
  await next.click();
  await expect(page.locator('.page-input')).toHaveValue('2');
  await expect(dataRows(page).first()).not.toHaveAttribute('data-row-key', first);
  await expect(table).toHaveAttribute('data-probe', 'mounted-once');
  // The pager was not redrawn either: the button pressed still has the focus.
  await expect(next).toBeFocused();

  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.locator('.page-input')).toHaveValue('1');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', first);
  await expect(table).toHaveAttribute('data-probe', 'mounted-once');
  await expect(page.locator('.result-table[aria-busy]')).toHaveCount(0);
  /* A page is not a step and is not in the link: the address and the
     history are what they were. */
  expect(page.url()).toBe(address);
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test('Back and Forward still restore a sorted table, on the page a link restores', async ({ page }) => {
  /* The sort is part of the query and rides the link; the page number does
     not, and restoring an entry lands on its first page — as it did when
     every page was a repaint. Refining in place changed neither. */
  await open(page, WIDE, 'invoice');
  await page.getByRole('button', { name: 'Rows per page' }).click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await expect(dataRows(page)).toHaveCount(10);
  const entries = await page.evaluate(() => history.length);

  await page.getByRole('button', { name: /^id key/ }).click();
  await expect(queryBar(page)).toHaveValue('invoice sort id');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.page-input')).toHaveValue('2');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '11']]));
  const sorted = page.url();
  expect(decodeURIComponent(sorted)).toContain('invoice sort id');
  expect(await page.evaluate(() => history.length)).toBe(entries);

  await dataRows(page).first().click();
  await expect(page.getByRole('heading', { name: /invoice · / })).toBeVisible();
  const record = page.url();

  await page.goBack();
  await expect(queryBar(page)).toHaveValue('invoice sort id');
  expect(page.url()).toBe(sorted);
  await expect(page.locator('.page-input')).toHaveValue('1');
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '1']]));
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
  // The restored room is a live one: it pages in place again.
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(dataRows(page).first()).toHaveAttribute('data-row-key', JSON.stringify([['id', '11']]));

  await page.goForward();
  await expect(page.getByRole('heading', { name: /invoice · / })).toBeVisible();
  expect(page.url()).toBe(record);
});
