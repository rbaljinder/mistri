// e2e-client: source — rewrites client modules by their source names on the way to the page; the build has none
/**
 * Proof that the tests above can fail.
 *
 * A browser test that asserts on a page it never really looked at passes
 * forever. The only way to know an assertion is load-bearing is to break the
 * thing it is about and watch it go red — so this file does exactly that, once
 * per behaviour, by rewriting a client module on its way to the browser —
 * a hand-written one as it is, a component as Vite serves it (JSX compiled,
 * names intact, so a patch names a statement rather than markup).
 *
 * Nothing on disk is touched. tablewalk's client is plain ES modules served as
 * files, which means a route interception can hand the page a version of
 * `pins.js` with the rounding backwards, or a `table.js` that marks every row
 * clickable, and then assert that the corresponding check *fails*.
 *
 * Two things this buys that a one-off manual check does not. It keeps proving
 * it: an assertion that quietly becomes vacuous — a locator that stops
 * matching, a class that gets renamed — shows up here as a mutation that no
 * longer breaks anything. And it says, in one place, what each test is
 * actually watching for.
 *
 * If a mutation stops applying, the source it patches has been edited. That is
 * a real signal and the failure says so: re-read the module and update the
 * patch, rather than deleting it.
 */
import { expect, test, type Page } from '@playwright/test';
import { DEMO, DEMO_DB, SCRATCH, SCRATCH_DB, SEEN_TOUR, WIDE } from './support/fixtures';
import { scalar } from './support/db';
import { childPanel, dataRows, enableWriteMode, open, queryBar, toast } from './support/app';

/**
 * Serve one client module with a patch applied.
 *
 * Must be installed before the page loads the module, so every caller does
 * this before its `goto`.
 */
async function breaking(page: Page, file: string, find: RegExp, replace: string): Promise<void> {
  /* The component modules are served with their source extension and,
     after an edit, a cache-busting query; the glob takes both. */
  await page.route(`**/${file}*`, async (route) => {
    /* Vite's middleware occasionally drops a connection while it is
       re-transforming a module (seen on the Windows runner as ECONNRESET);
       the fetch is repeated a few times before it counts as a failure. */
    let response = await route.fetch().catch(() => null);
    for (let attempt = 0; !response && attempt < 4; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      response = await route.fetch().catch(() => null);
    }
    if (!response) response = await route.fetch();
    const source = await response.text();
    if (!find.test(source)) {
      throw new Error(
        `The mutation for ${file} no longer applies: nothing matches ${find}. ` +
          'src/client has changed — re-read it and update the patch.',
      );
    }
    await route.fulfill({
      response,
      body: source.replace(find, replace),
      headers: { ...response.headers(), 'content-type': 'text/javascript; charset=utf-8' },
    });
  });
}

/** Run an assertion that is expected to fail, and say so if it does not. */
async function goesRed(what: string, assertion: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await assertion();
  } catch {
    failed = true;
  }
  expect(failed, `${what}: the assertion still passed with the code broken`).toBe(true);
}

const SHORT = { timeout: 2500 };

test('grid: a row that cannot be opened would be caught looking clickable', async ({ page }) => {
  // Every row navigable, including a projection that dropped the key.
  await breaking(page, 'components/Grid.tsx', /const navigable = Boolean\(onRowClick\)/, 'const navigable = true || Boolean(onRowClick)');
  await open(page, DEMO, 'invoice show total');

  await goesRed('grid.spec: the projection has no pointer', () => expect(dataRows(page).first()).not.toHaveClass(/clickable/, SHORT));
});

test('grid: a free-looking sort on an unindexed column would be caught', async ({ page }) => {
  /* `aria-disabled`, because the header is marked unavailable rather than
     disabled — a disabled button is not focusable, and the sentence saying
     *why* the column cannot be sorted is the most useful thing on it. */
  await breaking(page, 'components/Grid.tsx', /"aria-disabled": !language \|\| !sortable,/, '"aria-disabled": false,');
  await open(page, DEMO, 'invoice');

  await goesRed('grid.spec: the unindexed header is disabled', () =>
    expect(page.getByRole('button', { name: /^customer_id/ })).toBeDisabled(SHORT),
  );
});

test('pins: a hairline between frozen columns would be caught', async ({ page }) => {
  /* The real bug, restored: rounding the offset *up* leaves a sub-pixel gap
     between consecutive frozen columns, through which the scrolling content
     shows as a flickering sliver. */
  await breaking(
    page,
    'components/usePins.ts',
    /next\.set\(drawn\[i\], Math\.floor\(offset\)\);/,
    /* Past the first column only: the first one's +2 would move both columns, and with a whole-pixel width
       before it (gridSizing.ts sizes columns in whole pixels) no gap would open between them. */
    'next.set(drawn[i], offset ? Math.ceil(offset) + 2 : 0);',
  );
  await page.goto(`/${WIDE}/ticket`);
  await expect(page.locator('#db-label')).toContainText(WIDE);
  const wrap = page.locator('.table-wrap').first();
  /* A wheel sent before the rows are drawn has nothing to scroll and is gone: ask again until the table moves. */
  await expect(wrap.locator('tbody tr').first()).toBeVisible();
  await expect(async () => {
    await wrap.hover();
    await page.mouse.wheel(700, 0);
    expect(await wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300);
  }).toPass({ timeout: 15_000 });

  const gap = async () => {
    const boxes = await page
      .locator('.table-wrap thead th.pinned')
      .evaluateAll((cells) => cells.map((c) => c.getBoundingClientRect()).map((r) => [r.left, r.right]));
    return boxes[1][0] - boxes[0][1];
  };
  await goesRed('pins.spec: no gap between frozen columns', async () => expect(await gap()).toBeLessThanOrEqual(0));
});

test('query: a sort that did not reach the query text would be caught', async ({ page }) => {
  // The header still re-sorts; it just stops writing the clause into the bar.
  await breaking(page, 'clauses.js', /parts\.sort = `sort \$\{column\}\$\{desc \? ' desc' : ''\}`;/, '');
  await open(page, DEMO, 'invoice');
  await page.getByRole('button', { name: /^id key/ }).click();

  await goesRed('query.spec: the sort is written into the query', () => expect(queryBar(page)).toHaveValue('invoice sort id', SHORT));
});

test('query: a clause chip that removed nothing would be caught', async ({ page }) => {
  await breaking(
    page,
    'clauses.js',
    /export function withoutClause\(text, clause\) \{/,
    'export function withoutClause(text, clause) { return text;',
  );
  await open(page, DEMO, 'invoice total > 500 sort total desc');
  await page.getByRole('button', { name: 'Remove sorted by total desc' }).click();

  await goesRed('query.spec: removing a chip rewrites the text', () => expect(queryBar(page)).toHaveValue('invoice total > 500', SHORT));
});

test('walk: a Related count off by one would be caught', async ({ page }) => {
  await breaking(
    page,
    'components/Record.tsx',
    /const total = countOf\.get\(rel\.fk\.name\) \?\? data\.rows\.length;/,
    'const total = (countOf.get(rel.fk.name) ?? data.rows.length) + 1;',
  );
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();

  await goesRed('walk.spec: the Related tab counts what points at the row', () =>
    expect(page.getByRole('tab', { name: '2 invoice via customer_id' })).toBeVisible(SHORT),
  );
});

test('nested: children counted wrongly would be caught', async ({ page }) => {
  await breaking(page, 'components/Nested.tsx', /total: total\?\.count,/, 'total: (total?.count ?? 0) + 7,');
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).getByRole('button', { name: 'Show what points at this row' }).click();

  await goesRed('nested.spec: the detail count matches the database', () =>
    expect(page.locator('tr.detail-row .detail-count')).toHaveText('2', SHORT),
  );
});

test('deeplinks: a link that dropped the trail would be caught', async ({ page, browser }) => {
  // Only the last step survives serialisation — the dead end the hash format
  // exists to avoid.
  await breaking(
    page,
    'deeplink.js',
    /stack\.forEach\(\(entry, index\) => \{/,
    'stack = stack.slice(-1); stack.forEach((entry, index) => {',
  );
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();
  await childPanel(page).getByRole('row').filter({ hasText: '1004' }).click();

  const fresh = await browser.newContext({ storageState: SEEN_TOUR });
  const pasted = await fresh.newPage();
  await pasted.goto(page.url());
  await goesRed('deeplinks.spec: the link carries the whole walk', () =>
    expect(pasted.getByRole('navigation', { name: 'Trail' })).toContainText('Dry Creek', SHORT),
  );
  await fresh.close();
});

test('deeplinks: a Back button that left the app would be caught', async ({ page }) => {
  /* The bug the push/replace distinction was introduced for: with every
     navigation a replace, one Back press leaves tablewalk entirely and takes
     the trail with it. */
  await breaking(page, 'url.js', /if \(state\.navMode === 'push'\) navPush\(shown\(next\), walk\);/, '');
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();
  await expect(page.getByRole('heading', { name: /Dry Creek Vineyards/ })).toBeVisible();

  await page.goBack();
  await goesRed('deeplinks.spec: Back steps up the trail', () => expect(dataRows(page).first()).toBeVisible(SHORT));
});

test('sql: completion that forgot tables follow FROM would be caught', async ({ page }) => {
  await breaking(page, 'sqlcomplete.js', /const EXPECTS_TABLE = [^;]+;/, 'const EXPECTS_TABLE = /a^/;');
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const editor = page.getByRole('combobox', { name: 'SQL statement' });
  await editor.pressSequentially('select * from ');

  await goesRed('sql.spec: tables are offered after FROM', () =>
    expect(page.locator('.ac:not([hidden]) .ac-item').filter({ hasText: 'invoice_line' })).toHaveCount(1, SHORT),
  );
});

test('sql: a swallowed database error would be caught', async ({ page }) => {
  await breaking(
    page,
    'components/SqlPane.tsx',
    /className: "sql-error",\s*role: "alert",\s*children: outcome\.message/,
    'className: "sql-error", children: "Query failed."',
  );
  await open(page, DEMO, 'customer');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await page.getByRole('combobox', { name: 'SQL statement' }).fill('select * from custmer');
  await page.getByRole('button', { name: 'Run ⌘↵' }).click();

  await goesRed("sql.spec: the database's own words are shown", () =>
    expect(page.locator('.sql-error')).toContainText('no such table: custmer', SHORT),
  );
});

test('write: an undo that did not restore the row would be caught', async ({ page }) => {
  const original = String(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = 3'));
  /* Undo asks the journal to *list* what could be undone instead of undoing
     it: the button still lights up, a toast still appears, and nothing is put
     back. Exactly the failure an assertion on the UI alone would miss, which
     is why the real test asks the database.

     The mutation moved with the code. Undo used to write the old values back
     from a stack the browser kept; the record is the server's journal now, and
     what the browser still owns is asking it to act rather than to report. */
  await breaking(page, 'undo.js', /confirm: true/, 'confirm: false');
  await open(page, SCRATCH, 'customer');
  await enableWriteMode(page);
  await dataRows(page).filter({ hasText: original }).click();

  await page.getByLabel('email (TEXT)').fill('mutation@example.com');
  await page.getByRole('button', { name: 'Review & apply' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await expect(toast(page)).toContainText('Updated 1 column');
  await toast(page).getByRole('button', { name: 'Undo' }).click();

  await goesRed('write.spec: undoing restores the row', () =>
    expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = 3'), SHORT).toBe(original),
  );

  // Put the fixture back by hand, since the app's own undo is broken here.
  await page.unrouteAll();
  await open(page, SCRATCH, 'customer');
  await enableWriteMode(page);
  await dataRows(page).filter({ hasText: 'mutation@example.com' }).click();
  await page.getByLabel('email (TEXT)').fill(original);
  await page.getByRole('button', { name: 'Review & apply' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = 3')).toBe(original);
});

test('write: a read-only refusal that was not shown would be caught', async ({ page }) => {
  const original = String(scalar(DEMO_DB, 'SELECT email FROM customer WHERE id = 1'));
  // The error is swallowed instead of surfaced — the failure mode where a
  // write appears to succeed and did not.
  await breaking(page, 'write.js', /toast\(result\.message, 'error'\);/, '');
  await open(page, DEMO, 'customer');
  await enableWriteMode(page);
  await dataRows(page).filter({ hasText: original }).click();

  await page.getByLabel('email (TEXT)').fill('silently-dropped@example.com');
  await page.getByRole('button', { name: 'Review & apply' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();

  await goesRed("write.spec: the refusal is shown, in the config's words", () => expect(toast(page)).toContainText('is read-only', SHORT));
  expect(scalar(DEMO_DB, 'SELECT email FROM customer WHERE id = 1')).toBe(original);
});

test('nested: a stale aria-expanded would be caught', async ({ page }) => {
  /* The header menu and the pickers hand their `aria-expanded` to Base UI
     now; the row expander is the one this client still sets by hand. */
  await breaking(page, 'components/Nested.tsx', /"aria-expanded": open,/, '"aria-expanded": true,');
  await open(page, DEMO, 'customer');
  const expander = page.getByRole('button', { name: 'Show what points at this row' }).first();
  await expander.click();
  await expect(page.locator('tr.detail-row')).toBeVisible();
  await expander.click();
  await expect(page.locator('tr.detail-row')).toHaveCount(0);

  await goesRed('nested.spec: no aria-expanded left behind', () => expect(expander).toHaveAttribute('aria-expanded', 'false', SHORT));
});
