// e2e-client: source — imports /prefs.js; and it exists to catch an unbuilt client that throws (npm run smoke)
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
 * An App's rooms, as mistri serves them; e2e/smoke-tablewalk.spec.ts walks the database browser's. One walk per
 * binary, so each package's suite carries its own (scripts/test-owners.mjs).
 */
import { test, expect, type Page } from './support/harness';

const APP = `http://127.0.0.1:${process.env.TABLEWALK_E2E_APP_PORT}`;

/** The content pane holds something visible — a view painted, any view. */
async function painted(page: Page): Promise<void> {
  await expect.poll(async () => ((await page.locator('#content').textContent()) ?? '').trim().length).toBeGreaterThan(0);
}

test('the app’s rooms all render', async ({ page }) => {
  /* The App's connection is read-only, so nothing it asks may be refused:
     Undo's history was, with a 403 on every page, for a question whose
     answer ("nothing to undo") the browser already had. */
  const refused: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path.startsWith('/api/')) refused.push(`${response.status()} ${path}`);
  });
  await page.goto(APP);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(APP);
  await painted(page);

  // Home: the app's first dashboard when it has one, the menu card otherwise.
  await expect(page.locator('.dash-body, .landing-pages').first()).toBeVisible();

  // A nav entry's list page: tabs, boxes, grid.
  await page.locator('#table-list button[data-table]').first().click();
  await expect(page.locator('.applist-title')).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  /* One content edge per room (docs/design.md, --room-inset): the crumbs'
     first word, the list's controls and its rows start together. */
  const edge = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => Math.round(node.getBoundingClientRect().left));
  const crumb = await edge('.crumbs > :first-child');
  expect(await edge('.applist-controls > :first-child')).toBe(crumb);
  expect(await edge('.result-table')).toBe(crumb);

  // A record through the app's page, on the same edge.
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.page-body .page-section').first()).toBeVisible();
  expect(await edge('.page-head')).toBe(await edge('.crumbs > :first-child'));

  // Preferences: the dialog and its dropdowns construct.
  await page.evaluate(async () => {
    const m = await import('/prefs.js');
    m.openPrefs();
  });
  await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(refused, 'a read-only App asks nothing it is refused').toEqual([]);
});
