// e2e-client: source — it exists to catch an unbuilt client that throws (npm run smoke)
/**
 * Every room renders. Nothing more — and nothing less.
 *
 * The blank-pane class of failure: a constructor-time throw in one shared
 * module (a dropdown, a grid helper) empties every view that touches it,
 * while the static checks and the unit suite — which never execute client
 * code in a browser — stay green. These walks assert only that each
 * surface paints something and, through the harness tripwire, that no
 * uncaught error fired on the way. Feature behaviour belongs to the
 * feature specs; this one exists to make "the app is blank" a test
 * failure instead of a screenshot from someone's browser.
 *
 * Fast on purpose (one pass, no data assertions), so it is cheap to run
 * after any client edit: `npm run smoke`.
 *
 * The database browser's rooms; e2e/smoke-mistri.spec.ts walks an App's. One walk per binary, so each package's
 * suite carries its own (scripts/test-owners.mjs).
 */
import { test, expect, type Page } from './support/harness';
import { open, runQuery } from './support/app';
import { DEMO } from './support/fixtures';

/** The content pane holds something visible — a view painted, any view. */
async function painted(page: Page): Promise<void> {
  await expect.poll(async () => ((await page.locator('#content').textContent()) ?? '').trim().length).toBeGreaterThan(0);
}

test('the explorer’s rooms all render', async ({ page }) => {
  // Landing: schema summary and diagram.
  await open(page, DEMO, '');
  await painted(page);

  // Table view, with the filter section and a real grid.
  await runQuery(page, 'invoice sort total desc');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // The header ⌄ menu — the dropdown/menu constructors run here.
  await page.locator('thead .th-filter').first().click();
  await expect(page.locator('.th-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // Record view, related rail included.
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.record, .layout').first()).toBeVisible();

  // Page view (the suggested page exists for every table).
  await page.getByRole('button', { name: 'As a page' }).click();
  await expect(page.locator('.page-body .page-section').first()).toBeVisible();

  // Breakdown view.
  await runQuery(page, 'invoice count by status');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // The SQL editor opens and closes — Escape from inside it, where it listens.
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const sql = page.getByRole('combobox', { name: 'SQL statement' });
  await expect(sql).toBeVisible();
  // Two-step by design: the first Escape leaves the field, the second
  // closes the panel.
  await sql.press('Escape');
  await page.keyboard.press('Escape');
  await expect(sql).toBeHidden();

  // The palette opens and closes.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The pager's dropdown constructs — back on a table, where the pager lives.
  await runQuery(page, 'invoice');
  await page.locator('.pager .dd-button').first().click();
  await page.keyboard.press('Escape');
});
