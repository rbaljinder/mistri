/**
 * App mode, end to end.
 *
 * An app is a directory of config that curates the UI: same server, same
 * database, and a purpose-built tool on screen instead of a schema browser.
 * Everything an app changes is presentation — which words go over which
 * columns, which filters are one click, which room a drill lands in — and
 * every piece of that has to be seen to be believed: a tab that stays lit
 * after "All", a chip that repeats what the tab already says, a drill that
 * dumps the reader back into explorer chrome. So this suite walks the
 * fieldops example the way its user would.
 *
 * It runs against its worker's own Field Ops server — `--demo --app
 * test/fixtures/apps/fieldops` on its own port (support/ownServers.ts) —
 * because `--app` is a property of the server process, not of a connection.
 */
import { APP_DEMO_DB, configHome, expect, FIELDOPS, type Page, test } from './support/ownServers';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { count } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['fieldops'] });

const APP = FIELDOPS;

/* The very database the app server built for itself, named once in
   `support/ownServers.ts` and read from there by both the fixture that starts
   the server and this spec. Counts come from the database rather than from a
   number once read off a screen. */
const DB = APP_DEMO_DB;

const sidebar = (page: Page) => page.locator('nav.sidebar');

/** Open a view on the app server, and wait until the app is dressing it. */
async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`${APP}/${query ? encodeURIComponent(query) : ''}`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
}

/** Into the Work orders list the way the app offers it: its own menu. Wide
    enough that its five tabs, its search and its three filters share one row;
    at 1280 the filters give way to one "+ Filter" (the test below). */
async function openWorkOrders(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1680, height: 900 });
  await open(page);
  await sidebar(page).getByRole('button', { name: 'Work orders' }).click();
  await expect(page.locator('.applist-title')).toHaveText('Work orders');
}

/** A filter's "+" and its picker: tick one value, and Show applies it. */
async function pickValue(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('button', { name: `Filter by ${label}`, exact: true }).click();
  const picker = page.getByRole('dialog', { name: `Filter by ${label}` });
  await picker.locator(`input[data-value="${value}"]`).check();
  await picker.getByRole('button', { name: /^Show/ }).click();
}

/* Saved filter tabs persist server-side — that is their point, and the end
   of isolation by fresh browser context alone. Each test starts from none. */
test.beforeEach(async ({ request }) => {
  await request.post(`${APP}/api/filters/save`, { data: { app: 'fieldops', table: 'work_order', filters: null } });
});

test('the app dresses the shell: its name, its menu, and a way to everything', async ({ page }) => {
  await open(page);

  /* The brand answers to the app, not to the tool: the reader was handed a
     field-ops tool, and "tablewalk" would be the plumbing introducing itself. */
  await expect(page.locator('.brand-name')).toHaveText('Field Ops');

  /* The sidebar is the app's menu: its entries, its words, its grouping —
     with the group headings drawn once per run, not once per entry. */
  await expect(sidebar(page).locator('.nav-group')).toHaveText(['Operations', 'Directory']);
  for (const label of ['Work orders', 'Shipments', 'Invoices', 'Customers', 'Engineers', 'Products']) {
    await expect(sidebar(page).getByRole('button', { name: label })).toBeVisible();
  }

  await expect(sidebar(page)).toHaveAttribute('aria-label', 'App menu');
  // App menus omit their search box unless the author explicitly enables it.
  await expect(page.getByRole('searchbox', { name: 'Filter menu' })).toBeHidden();
  await expect(page.locator('#db-label')).toBeHidden();
  await expect(page.locator('#conn-picker')).toBeHidden();
  // An App has no way into the Workbench: the standalone browser is that tool.
  await expect(sidebar(page).getByText('Workbench')).toHaveCount(0);
});

test('a nav entry opens its list page: the app’s words over the real table view', async ({ page }) => {
  await openWorkOrders(page);

  /* The tabs are the manifest's, in the manifest's order, and each carries a
     live count. The first tab's badge is filled from the grid's own total —
     the grid is showing that very query — so a number here is the whole
     pipeline agreeing with itself. */
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveText([/^Open/, /^In progress/, /^On hold/, /^Done/, /^All/]);
  await expect(tabs.first().locator('.tab-count')).toHaveText(/\d/);

  /* The filters are controls, not a form — the manifest chose status,
     priority and is_urgent: a "+" for each that opens its picker (a flag's
     is one gesture), and no empty box or Filter button waiting to be pressed. */
  await expect(page.locator('.applist-filterbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter by Status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter by Priority' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Only Is urgent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);
});

test('a row too narrow for every filter keeps one line: the filters give way to one "+ Filter"', async ({ page }) => {
  await openWorkOrders(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const more = page.getByRole('button', { name: /^More filters: / });
  await expect(more).toBeVisible();
  // The row does not run past the window; what gave way is named, from the end.
  const row = page.locator('.applist-controls');
  expect(await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(more).toHaveAttribute('aria-label', /Is urgent$/);
  // It opens every picker, in the sheet.
  await more.click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Room again, and they come back.
  await page.setViewportSize({ width: 1680, height: 900 });
  await expect(page.getByRole('button', { name: 'Filter by Status' })).toBeVisible();
  await expect(more).toHaveCount(0);
});

test('tabs swap the grid, and All clears the outgoing tab’s condition', async ({ page }) => {
  const inProgress = count(DB, "SELECT COUNT(*) FROM work_order WHERE status = 'in_progress'");
  const everything = count(DB, 'SELECT COUNT(*) FROM work_order');

  await openWorkOrders(page);

  await page.getByRole('tab', { name: /^In progress/ }).click();
  await expect(page.getByRole('tab', { name: /^In progress/ })).toHaveAttribute('aria-selected', 'true');
  /* The count beside the title is what the tab and filters match; matching it
     against the database's own count is what proves the tab changed the rows
     and not just its own colour. */
  await expect(page.locator('.applist-count')).toHaveText(inProgress.toLocaleString());

  /* The regression this pins: while a tab is lit, the status box only echoes
     it, and carrying that echo into the next tab's query rebuilt the same
     question — which made "All" a click that changed nothing. The outgoing
     tab's condition must leave with the tab. */
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^In progress/ })).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.applist-count')).toHaveText(everything.toLocaleString());
});

test('a filter box narrows the list and says so as a chip, whose × undoes it', async ({ page }) => {
  const open_ = count(DB, "SELECT COUNT(*) FROM work_order WHERE status = 'open'");
  const narrowed = count(DB, "SELECT COUNT(*) FROM work_order WHERE status = 'open' AND priority = 2");

  await openWorkOrders(page);
  await expect(page.locator('.applist-count')).toHaveText(open_.toLocaleString());

  /* Priority rather than status, because status is the lit tab's own
     dimension — its condition belongs to the tab, and a chip repeating the
     tab would be the page saying one thing twice. */
  await pickValue(page, 'Priority', '2');

  const chip = page.locator('.applist-chip', { hasText: 'Priority is 2' });
  await expect(chip).toBeVisible();
  await expect(page.locator('.applist-count')).toHaveText(narrowed.toLocaleString());
  /* And the tab survives the refinement: narrowing Open is still Open. */
  await expect(page.getByRole('tab', { name: /^Open/ })).toHaveAttribute('aria-selected', 'true');

  await chip.getByRole('button', { name: 'Remove Priority is 2' }).click();
  await expect(page.locator('.applist-chip')).toHaveCount(0);
  await expect(page.locator('.applist-count')).toHaveText(open_.toLocaleString());
});

test('the raw query waits behind Advanced instead of talking over the chips', async ({ page }) => {
  await openWorkOrders(page);

  /* Hidden by default: the chips under the heading already say everything
     the text would, so the bar opening uninvited was repetition. */
  const bar = page.locator('.applist-advanced');
  await expect(bar).toBeHidden();

  const toggle = page.getByRole('button', { name: 'Advanced' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  /* And what it shows is the truth under the page: the first tab's query in
     the language — its segment's name, a word the language reads — minus the
     table name the heading already speaks. */
  await expect(bar.locator('.applist-filter')).toHaveValue('open sort due_on');

  await toggle.click();
  await expect(bar).toBeHidden();
});

test('Save view… keeps a refinement as a saved view, and its × removes it', async ({ page }) => {
  await openWorkOrders(page);

  /* A refinement no manifest tab covers — Open narrowed by priority — is
     exactly the state worth keeping; the Save button only exists then. */
  await pickValue(page, 'Priority', '2');
  await expect(page.locator('.applist-chip', { hasText: 'Priority is 2' })).toBeVisible();

  await page.getByRole('button', { name: 'Save view…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Save this view');
  await dialog.getByLabel('Name').fill('Open twos');
  await dialog.getByRole('button', { name: 'Save' }).click();

  /* The saved tab arrives after the manifest's, marked as yours, already lit
     — it *is* the query on screen. */
  const saved = page.getByRole('tab', { name: /^Open twos/ });
  await expect(saved).toHaveClass(/tab-yours/);
  await expect(saved).toHaveAttribute('aria-selected', 'true');

  /* And it landed in the server-side store the harness pointed into the
     suite's temp directory — not in this browser, and not in the home
     directory of whoever ran the tests. */
  expect(existsSync(join(configHome('fieldops'), 'mistri', 'filters.json'))).toBe(true);

  await page.getByRole('button', { name: 'Remove the view "Open twos"' }).click();
  await expect(page.locator('.tab-yours')).toHaveCount(0);
});

test('a table outside the nav still wears the app’s dress', async ({ page }) => {
  /* Every drill from a page can land on one — a breakdown row, a junction
     table — and each landing used to swap the room's dress for raw explorer
     chrome. The dress is a property of the mode, not of being listed. */
  await open(page, 'work_order_note');

  /* A synthesized list page: the humanized name as the heading, no tabs
     (the app never wrote any), and none of the explorer's own tab strip —
     Definition and Diagram belong to the workbench. */
  await expect(page.locator('.applist-title')).toHaveText('Work order note');
  await expect(page.locator('.applist-filterbar')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Definition' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Diagram' })).toHaveCount(0);
});

test('an App has no Workbench: no row for it, and w is only a letter', async ({ page }) => {
  await open(page);
  /* App mode hides the query bar — filtering happens through the boxes. */
  await expect(page.getByRole('combobox', { name: 'Query' })).toBeHidden();
  await page.keyboard.press('w');
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.getByRole('combobox', { name: 'Query' })).toBeHidden();
  await expect(sidebar(page)).toHaveAttribute('aria-label', 'App menu');
  await expect(page.locator('#db-label')).toBeHidden();
});

test('app mode humanizes column headers without hiding the real names', async ({ page }) => {
  /* Engineers, because its nav entry chose no columns and no labels: every
     header the reader sees is derived, which is the surface that could
     silently regress to raw snake_case. */
  await open(page);
  await sidebar(page).getByRole('button', { name: 'Engineers' }).click();
  await expect(page.locator('.applist-title')).toHaveText('Engineers');

  const header = page.locator('th button.th-sort', { hasText: 'First name' });
  await expect(header).toBeVisible();
  /* The label is for reading; the tooltip keeps speaking the column's real
     name, so the humanized word never hides what the data is. */
  await expect(header).toHaveAttribute('title', /first_name/);
});

test('field presentation: DSL labels agree across lists, pages and drawers', async ({ page }, testInfo) => {
  await page.goto(`${APP}/work_order`);
  await expect(page.locator('th .th-sort', { hasText: /^Engineer/ })).toBeVisible();
  await page.locator('tbody tr').first().click();
  const assigned = page.locator('.page-field dt[title="assigned_to"]');
  await expect(assigned).toHaveText('Engineer');
  await expect(page.locator('.page-field dt[title="due_on"]')).toHaveText('Due');
  await expect(page.locator('.page-field dt[title="customer_id.country_code"]')).toHaveText('Country');
  await page.screenshot({ path: testInfo.outputPath('fieldops-field-labels.png'), fullPage: true });

  await page.locator('#table-list button', { hasText: 'Urgent orders' }).click();
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.peekpanel dt[title="assigned_to"]')).toHaveText('Engineer');
  await expect(page.locator('.peekpanel dt[title="due_on"]')).toHaveText('Due');
});

test('a reference box takes a name and writes the id underneath', async ({ page }) => {
  /* The review's "quietly zero rows" finding: columns show names while
     boxes demanded ids. A whole single-column reference whose target has
     a label column is a typeahead now — type a fragment, pick a person,
     the query says author_id = <id>. work_order_note is outside the nav,
     so this also proves derived boxes get it. */
  await page.goto(`${APP}/work_order_note`);
  // "+ Author" opens its picker: a typeahead over the people, not a box demanding an id.
  await page.getByRole('button', { name: 'Filter by Author', exact: true }).click();
  const box = page.getByRole('combobox', { name: 'Filter by Author' });
  await box.fill('a');
  const option = page.locator('.dd-list:not([hidden]) .dd-option').first();
  await expect(option).toBeVisible();
  const pickedName = await option.locator('.dd-label').textContent();
  await option.click();
  await expect(page).toHaveURL(/author_id(%20%3D%20| = )\d+/);
  // The chip says the person; the id stays in the question, because it is the truth.
  await expect(page.locator('.applist-chip', { hasText: `Author is ${pickedName ?? ''}` })).toBeVisible();
});

test('a page whose record is gone says so instead of rendering zeros', async ({ page }) => {
  await page.goto(`${APP}/@suggested:work_order~999999`);
  await expect(page.locator('#content .empty-note').first()).toContainText('no longer exists');
  // No metric cards pretending: the sections never rendered.
  await expect(page.locator('.metric-number')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Back to the .* list/ })).toBeVisible();
});

test('a record page’s breakdown drills into the related list', async ({ page }) => {
  /* "This customer's work orders: completed · 2" is a doorway — the
     anchoring condition read off the compiled plan (so `about` sections
     drill too), the group closing the query. */
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(`${APP}/work_order/@work-order~352`);
  await expect(page.locator('.page-body .pbd-drill').first()).toBeVisible();
  await page.locator('.page-body .pbd-drill').first().click();
  await expect(page).toHaveURL(/customer_id/);
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('the palette finds records: type a name, land on the row', async ({ page }) => {
  /* App mode names the tables worth searching (the nav) and the words
     people search by (label columns); the palette answers with rows. */
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(`${APP}/`);
  await expect(page.locator('.dash-body, .landing-pages').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('Harbour');
  const hit = page.locator('.palette-item', { has: page.locator('.kind-record') }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator('.page-body .page-section, .record').first()).toBeVisible();
});

test('open: "drawer" makes a row a glance — drawer in, Escape out, page one click away', async ({ page }) => {
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(`${APP}/`);
  await page.locator('#table-list button', { hasText: 'Shipments' }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  const listUrl = page.url();
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.peekpanel')).toBeVisible();
  await expect(page.locator('.peekpanel .field').first()).toBeVisible();
  // A glance is not a step: the URL did not move.
  expect(page.url()).toBe(listUrl);
  await page.keyboard.press('Escape');
  await expect(page.locator('.peekpanel')).toHaveCount(0);
  // And the deliberate click still reaches the full page.
  await page.locator('tbody tr').first().click();
  await page.locator('.peekpanel-open').click();
  // The record's own address: its id under the list that shows it.
  await expect(page).toHaveURL(/\/[^/?]+\/\d+$/);
  await expect(page.locator('.page-body .page-section, .record').first()).toBeVisible();
});

test('a peek speaks names: references say who, and a module can open one', async ({ page }) => {
  /* Urgent orders is a module over work_order with `open: "drawer"` — same
     table as the page-opening Work orders entry, different door. Inside
     the drawer, customer_id wears the customer's name (the id keeps to
     the tooltip); a chip that showed `8` would make the glance a lookup. */
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(`${APP}/`);
  await page.locator('#table-list button', { hasText: 'Urgent orders' }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.peekpanel')).toBeVisible();
  const chips = page.locator('.peekpanel .ref-jump-value');
  await expect(chips.first()).toBeVisible();
  const said = await chips.allTextContents();
  expect(said.some((text) => /[A-Za-z]/.test(text))).toBe(true);
});

test('a nav module is a destination of its own, not a tab in disguise', async ({ page }) => {
  /* "Urgent orders" beside "Work orders": same table, standing
     conditions, its own label and dress — and the sidebar lights the
     module row alone, matched by the query the walk is actually on. */
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('mistri.tour.v1', 'done'));
  await page.goto(`${APP}/`);
  await page.locator('#table-list button', { hasText: 'Urgent orders' }).click();
  await expect(page.locator('.applist-title')).toHaveText('Urgent orders');
  // Its address is its key; its standing condition is the view's, rebuilt from it, never written.
  await expect(page).toHaveURL(/\/urgent-orders$/);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  const lit = page.locator('#table-list button.active');
  await expect(lit).toHaveCount(1);
  await expect(lit).toContainText('Urgent orders');

  // The plain list is untouched by the module's existence.
  await sidebar(page)
    .getByRole('button', { name: /^Work orders\b/ })
    .click();
  await expect(page.locator('.applist-title')).toHaveText('Work orders');
  await expect(page.locator('#table-list button.active')).toContainText('Work orders');
});

test('a dashboard is a screen of the app’s own: strip, breakdowns, lists', async ({ page }) => {
  /* Retool-class composition without leaving config: consecutive metrics
     read as one KPI strip, breakdowns and lists take the page grid. The
     fieldops example has no dashboard, so this drives one through the
     crm-style shape by URL against a dash id that does not exist — the
     honest refusal — and the real rendering is pinned by the unit tests
     plus this walk of the fieldops Ops board. */
  await page.goto(`${APP}/@dash-nonesuch`);
  await expect(page.locator('#content .note').first()).toContainText('No dashboard called');

  // And the real one: the Ops board renders its strip, bars and lists.
  await page.goto(`${APP}/@dash-ops-board`);
  await expect(page.locator('.home-card')).toHaveCount(2);
  await expect(page.locator('.home-card-value').first()).not.toHaveText('…');
  // The spark: the measure's shape inside the card, from spark: true.
  await expect(page.locator('.home-card .spark').first()).toBeVisible();
  await expect(page.locator('.pbd-row').first()).toBeVisible();
  /* The chart section: a real SVG line with its points, drawn from the
     same breakdown grammar the bars run on. */
  await expect(page.locator('.chart-line')).toBeVisible();
  expect(await page.locator('.chart-dot').count()).toBeGreaterThan(2);

  /* The matrix: two keys crossed, heat by weight, drillable rows. */
  await expect(page.locator('.matrix-cell').first()).toBeVisible();
  expect(await page.locator('.matrix-cell').count()).toBeGreaterThan(4);

  /* The board: lanes from the status vocabulary (all of them, empty
     included), cards with the record's own words, a "+N more" door. */
  await expect(page.locator('.board-lane').first()).toBeVisible();
  expect(await page.locator('.board-lane').count()).toBeGreaterThan(4);
  await expect(page.locator('.board-card-title').first()).not.toHaveText('');
  await expect(page.locator('.board-more').first()).toBeVisible();

  /* The time window: picking a phrase narrows every section that opted
     in with `over` — the count beside a windowed list changes, and the
     sections repaint without a crash (the tripwire watches). */
  /* Read the count once it is a count: the grid answers after the rest of
     the board, and an empty string here made the "changed" check below
     vacuous. */
  await expect(page.locator('.dash-count').first()).toHaveText(/in all|~/);
  const allTime = await page.locator('.dash-count').first().textContent();
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expect(page.locator('.dash-count').first()).not.toHaveText(allTime ?? '');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  /* The window is a place: it is the address's `period`, and a link with it
     restores the pressed pill. */
  await expect(page).toHaveURL(/\/ops-board\?period=last-30-days$/);
  await page.goto(`${APP}/@dash-ops-board~last-90-days`);
  await expect(page.locator('.dash-window[aria-pressed="true"]')).toHaveText('Last 90 days');
  await page.goto(`${APP}/@dash-ops-board`);
  await expect(page.locator('.dash-window[aria-pressed="true"]')).toHaveText('All time');

  /* Pick-filters: choosing a status narrows every reachable section —
     the windowed count changes — and Any brings it back. */
  await expect(page.locator('.dash-count').first()).toHaveText(/in all|~/);
  const before = await page.locator('.dash-count').first().textContent();
  await page.locator('.dash-pick .dd-button').first().click();
  await page.getByRole('option', { name: 'completed' }).click();
  await expect(page.locator('.dash-count').first()).not.toHaveText(before ?? '');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.locator('.dash-pick .dd-button').first().click();
  await page.getByRole('option', { name: /Any status/ }).click();
  await expect(page.locator('.dash-count').first()).toHaveText(before ?? '');

  /* A breakdown group is a doorway: clicking a row opens the list
     narrowed to it, on top of the section's own query, said in the list's
     own words — the first group is the Open tab, the view as it opens. */
  await page.locator('.pbd-drill').first().click();
  await expect(page).toHaveURL(/\/work-orders(\?|$)/);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.goBack();
  await expect(page.locator('.home-card').first()).toBeVisible();
  /* *Every* list, not the first: concurrent lists once cancelled each
     other through renderTable's shared stale-reply token, and the losers
     kept their skeletons forever. Two lists here keep that race live. */
  const lists = page.locator('.dash-list-head');
  await expect(lists).toHaveCount(2);
  for (const body of await page.locator('.dash-list-head + div').all()) {
    await expect(body.locator('tbody tr').first()).toBeVisible();
  }
  // The list wears the app's words, not the schema's spill of raw columns.
  await expect(page.locator('thead th', { hasText: 'Customer' }).first()).toBeVisible();

  /* The app's dress: a toned status pill, and invoice totals as money —
     display rules reaching an embedded grid through the core seam. */
  await expect(page.locator('tbody td .tone').first()).toBeVisible();
  await expect(page.locator('tbody td', { hasText: '$' }).first()).toBeVisible();
  /* The manifest turned Export off, and the count moved up beside the
     title where the grid's own stat row used to be. */
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  await expect(page.locator('.dash-count').first()).toContainText('in all');

  /* A list row is a way into the record, not furniture: clicking one opens
     it through the app's page even though the section projects its own
     columns — the key rides along unseen. */
  await page.locator('.dash-list tbody tr').first().click();
  await expect(page.locator('.page-body .page-section, .record').first()).toBeVisible();
  await page.goBack();

  // A metric clicks through to its list: the view that shows work orders, in its words.
  await page.locator('.home-card').first().click();
  await expect(page).toHaveURL(/\/work-orders(\?|$)/);
});
