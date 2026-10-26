/**
 * Pages, and the builder that makes them.
 *
 * A page is the one view in tablewalk that is assembled rather than derived:
 * a record's own fields, plus counts and lists of everything that points at
 * it, in an order somebody chose. Everything about it is composition — which
 * root, which sections, which columns — and every part of that composition
 * has been wrong at some point in a way only the screen could show: a filter
 * chip that went on saying `2` after the name arrived, two identical `id`
 * boxes in the filter row, a metric that counted the wrong table, a section
 * filter that parsed and was never applied.
 *
 * So this suite walks the feature the way a reader does: open a page with no
 * root, choose one, read what came back, then edit the page and watch the
 * edit take.
 */
import { DEMO, DEMO_DB, expect, type Page, test, WIDE } from './support/ownServers';
import { count } from './support/db';
import { dataRows, open, runQuery, toast } from './support/app';
import { parsePagesConfig, type PageDef } from '../packages/engine/src/shared/page.js';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/* Saved pages now persist server-side — the point of the feature, and the
   end of test isolation by fresh browser context alone. Each test starts
   from no saved pages, the way each already starts from no localStorage. */
test.beforeEach(async ({ request }) => {
  for (const conn of [DEMO, WIDE]) {
    const res = await request.get(`/api/pages/saved?conn=${encodeURIComponent(conn)}`);
    const { pages } = await res.json();
    for (const id of Object.keys(pages ?? {})) {
      await request.post('/api/pages/save', { data: { id, page: null, conn } });
    }
  }
});

/** The page's own body — sections, not the grid a section may contain. */
const sections = (page: Page) => page.locator('.page-body > .page-section, .page-body .page-metric-row > .page-section');

/** Get to `customer`'s page the way the table view offers it. */
async function customerPage(page: Page): Promise<void> {
  await open(page, DEMO, 'customer');
  await page.getByRole('button', { name: 'Page →' }).click();
  await expect(page.locator('.page-title')).toBeVisible();
}

/**
 * Choose a root from the embedded chooser: the *real list* now, not a
 * bespoke picker — narrow it with one of the named filter boxes, then
 * click the row.
 */
async function choose(page: Page, column: string, text: string, hit: string): Promise<void> {
  const box = page.getByLabel(`Filter by ${column}`);
  await box.fill(text);
  await box.press('Enter');
  await page.locator('.page-root-list tbody tr', { hasText: hit }).first().click();
}

/** A page rooted by link — the deterministic way in when the record is known. */
async function openRooted(page: Page, connection: string, table: string, key: string): Promise<void> {
  await open(page, connection, table);
  await page.goto(`/${connection}/${table}/@${table.replace(/_/g, '-')}~${key}`);
  await expect(page.locator('.page-title')).toBeVisible();
}

test('page contract: every section survives editing, export, save and reload', async ({ page, request }, testInfo) => {
  const definition: PageDef = {
    id: 'saved:contract',
    name: 'Contract page',
    base: 'customer',
    source: 'saved',
    connection: DEMO,
    listTabs: false,
    sections: [
      {
        kind: 'fields',
        title: 'Identity',
        paths: ['name', 'email'],
        names: false,
        columns: 2,
        width: 'half',
        offsetLeft: 'quarter',
        offsetRight: 'quarter',
        when: 'id > 0',
      },
      {
        kind: 'metric',
        title: 'Revenue',
        from: 'invoice',
        path: 'customer_id',
        fn: 'sum',
        column: 'total',
        filter: 'total > 0',
        width: 'third',
        offsetRight: 'two-thirds',
        when: 'id > 0',
      },
      {
        kind: 'list',
        title: 'Invoices',
        from: 'invoice',
        path: 'customer_id',
        columns: ['id', 'total'],
        limit: 7,
        orderBy: [
          { column: 'total', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        filter: 'total > 0',
        width: 'half',
      },
      {
        kind: 'breakdown',
        title: 'By status',
        from: 'invoice',
        path: 'customer_id',
        by: 'status',
        limit: 4,
        filter: 'total > 0',
        hidden: true,
        width: 'half',
        offsetLeft: 'half',
        when: 'id > 0',
      },
      {
        kind: 'timeline',
        title: 'Activity',
        limit: 12,
        width: 'half',
        offsetLeft: 'half',
        when: 'id > 0',
        streams: [{ from: 'invoice', path: 'customer_id', at: 'invoice_date', show: 'id', detail: 'status', filter: 'total > 0' }],
      },
    ],
  };
  const response = await request.post('/api/pages/save', { data: { id: definition.id, page: definition, conn: DEMO } });
  expect(response.ok()).toBe(true);
  await open(page, DEMO);
  await page.goto(`/${DEMO}/customer/@contract-page~4`);
  await expect(page.locator('.page-title')).toHaveText('Contract page');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  const timeline = builder.locator('.pb-timeline');
  await expect(timeline).toContainText('1 stream');
  await expect(timeline.locator('.pb-fields-btn')).toHaveCount(0);
  await timeline.getByRole('textbox', { name: 'Section title' }).fill('Recent activity');
  await timeline.getByRole('button', { name: 'Move up', exact: true }).click();
  const expected = structuredClone(definition);
  const [moved] = expected.sections.splice(4, 1);
  moved.title = 'Recent activity';
  expected.sections.splice(3, 0, moved);
  expect(
    await builder
      .getByRole('textbox', { name: 'Section title' })
      .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
  ).toEqual(['Identity', 'Revenue', 'Invoices', 'Recent activity', 'By status']);
  await page.screenshot({ path: testInfo.outputPath('timeline-editor.png') });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard unavailable');
    };
  });
  await builder.getByRole('button', { name: 'Copy as JSON' }).click();
  const json = page.getByRole('textbox', { name: 'Page', exact: true });
  const exported = JSON.parse(await json.inputValue());
  const [restored] = parsePagesConfig(exported, 'exported');
  expect(JSON.parse(JSON.stringify(restored.sections))).toEqual(expected.sections);
  expect(restored.listTabs).toBe(false);
  expect(restored.connection).toBe(DEMO);
  await json.press('Escape');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder).toHaveCount(0);
  const saved = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
  expect((await saved.json()).pages[definition.id]).toEqual(expected);
  await page.reload();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await expect(timeline.getByRole('textbox', { name: 'Section title' })).toHaveValue('Recent activity');
  await expect(builder.getByRole('checkbox', { name: 'Lists as tabs' })).not.toBeChecked();
  await builder.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('page contract: invalid drafts remain editable instead of being saved or exported', async ({ page }) => {
  await customerPage(page);
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  let writes = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/pages/save')) writes += 1;
  });
  const name = builder.getByRole('textbox', { name: 'Page name' });
  await name.fill('   ');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder.getByRole('alert')).toContainText('Invalid caption at Page editor: page 1.label');
  await builder.getByRole('button', { name: 'Copy as JSON' }).click();
  await expect(builder.getByRole('alert')).toBeFocused();
  expect(writes).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Page', exact: true })).toHaveCount(0);
  await name.fill('Corrected page');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText('Corrected page');
  expect(writes).toBe(1);
});

test('runtime UX: the builder protects changed drafts on every dismissal path', async ({ page }) => {
  await customerPage(page);
  const launch = page.getByRole('button', { name: 'Copy layout' });
  await launch.click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  const name = builder.getByRole('textbox', { name: 'Page name' });
  await name.fill('Unsaved customer desk');
  const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });

  await name.press('Escape');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(name).toHaveValue('Unsaved customer desk');
  await builder.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(builder).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await builder.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Discard changes' }).click();
  await expect(builder).toHaveCount(0);
  await expect(launch).toBeFocused();

  await launch.click();
  await expect(name).not.toHaveValue('Unsaved customer desk');
  await builder.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(builder).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
});

test('page persistence: a failed save retains the draft and retries after acknowledgement', async ({ page, request }, testInfo) => {
  await customerPage(page);
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  const name = builder.getByRole('textbox', { name: 'Page name' });
  await name.fill('Retryable page');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route('**/api/pages/save', async (route) => {
    attempts += 1;
    if (attempts > 1) return route.continue();
    await gate;
    await route.fulfill({ status: 500, json: { error: 'The pages file could not be written: disk full.' } });
  });
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  try {
    await expect(builder).toHaveAttribute('aria-busy', 'true');
    await expect(builder.getByRole('status')).toHaveText('Saving…');
    await expect(builder.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(builder.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 4);
    await expect(builder).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('save-pending.png') });
  } finally {
    release();
  }
  const error = builder.getByRole('alert');
  await expect(error).toContainText('disk full');
  await expect(error).toBeFocused();
  await expect(name).toHaveValue('Retryable page');
  await expect(builder).toHaveAttribute('aria-busy', 'false');
  const before = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
  expect((await before.json()).pages).toEqual({});
  expect(await page.evaluate((conn) => JSON.parse(localStorage.getItem(`mistri.pages.saved.${conn}`) ?? '{}'), DEMO)).toEqual({});
  await page.screenshot({ path: testInfo.outputPath('save-failed.png') });
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText('Retryable page');
  expect(attempts).toBe(2);
  const after = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
  expect(Object.values((await after.json()).pages).map((p: { name: string }) => p.name)).toEqual(['Retryable page']);
});

test('page persistence: failed deletion keeps the saved page and allows retry', async ({ page, request }) => {
  await customerPage(page);
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Keep until deleted');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.page-title')).toHaveText('Keep until deleted');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/pages/save', async (route) => {
    attempts += 1;
    if (attempts > 1) return route.continue();
    await route.fulfill({ status: 500, json: { error: 'Permission denied.' } });
  });
  await builder.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('textbox', { name: 'Type the page name to confirm' });
  await confirmation.fill('Keep until deleted');
  await confirmation.press('Enter');
  await expect(builder.getByRole('alert')).toContainText('Page deletion was not confirmed. Permission denied.');
  await expect(builder.getByRole('alert')).toBeFocused();
  const before = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
  expect(Object.values((await before.json()).pages).map((p: { name: string }) => p.name)).toEqual(['Keep until deleted']);
  await builder.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmation.fill('Keep until deleted');
  await confirmation.press('Enter');
  await expect(builder).toHaveCount(0);
  const after = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
  expect((await after.json()).pages).toEqual({});
});

test('page persistence: browser cache failure does not lose a server-saved page', async ({ page, browser }) => {
  await customerPage(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('mistri.pages.saved.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      set.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Server owns this page');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText('Server owns this page');
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(page.url());
    await expect(other.locator('.page-title')).toHaveText('Server owns this page');
  } finally {
    await fresh.close();
  }
});

test('runtime UX: Escape closes each builder picker before the draft', async ({ page }) => {
  await customerPage(page);
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  const fields = builder.locator('.pb-fields-btn').first();
  await fields.click();
  await expect(fields).toHaveAttribute('aria-expanded', 'true');
  const width = builder.getByRole('button', { name: 'Width', exact: true }).first();
  await width.click();
  await expect(width).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(width).toHaveAttribute('aria-expanded', 'false');
  await expect(width).toBeFocused();
  await expect(fields).toHaveAttribute('aria-expanded', 'true');
  const addFields = builder.getByRole('button', { name: '+ Fields', exact: true });
  await addFields.click();
  await expect(builder.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(builder.getByRole('menu')).toHaveCount(0);
  await expect(addFields).toBeFocused();
  await expect(fields).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(fields).toHaveAttribute('aria-expanded', 'false');
  await expect(fields).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(builder).toHaveCount(0);
});

test('runtime UX: delete and clipboard prompts close before their builder', async ({ page, request }) => {
  await customerPage(page);
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Prompt test page');
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.page-title')).toHaveText('Prompt test page');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const remove = builder.getByRole('button', { name: 'Delete', exact: true });
  await remove.click();
  const confirmation = page.getByRole('textbox', { name: 'Type the page name to confirm' });
  await expect(confirmation).toBeFocused();
  await confirmation.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(builder).toBeVisible();

  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard unavailable');
    };
  });
  const copy = builder.getByRole('button', { name: 'Copy as JSON' });
  await copy.click();
  const json = page.getByRole('textbox', { name: 'Page', exact: true });
  await expect(json).toBeFocused();
  expect(await json.evaluate((node) => node.tagName)).toBe('TEXTAREA');
  expect(await json.inputValue()).toContain('\n');
  expect(JSON.parse(await json.inputValue()).pages[0].label).toBe('Prompt test page');
  await json.press('Escape');
  await expect(json).toHaveCount(0);
  await expect(copy).toBeFocused();
  await expect(builder).toBeVisible();

  await remove.click();
  await confirmation.fill('Prompt test page');
  await confirmation.press('Enter');
  await expect(builder).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Prompt test page', exact: true })).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await request.get(`/api/pages/saved?conn=${encodeURIComponent(DEMO)}`);
      const { pages } = await response.json();
      return Object.values(pages as Record<string, { name: string }>).some((saved) => saved.name === 'Prompt test page');
    })
    .toBe(false);
});

test('a page with no record chosen says so instead of drawing empty sections', async ({ page }) => {
  /* The state that has no data in it at all. A page is about one record, and
     until one is chosen there is nothing to count — so the honest answer is a
     sentence, not five cards reading zero. */
  await customerPage(page);

  await expect(page.locator('.page-empty')).toContainText('Pick a customer below');
  await expect(sections(page)).toHaveCount(0);
  /* The chooser is the real list — rows to pick from and named boxes to
     narrow them, not a bespoke picker of its own. */
  await expect(page.locator('.page-root-list tbody tr').first()).toBeVisible();
  await expect(page.locator('.applist-filterbar')).toBeVisible();
});

test('choosing a record from the filter row draws the page about it', async ({ page }) => {
  const invoices = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice WHERE customer_id = 4');

  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');

  /* The fields section is the record itself, so a value only this customer
     has is what proves the right root was used. The number arrives grouped
     and the flag as words because a page renders values through the same
     module the record view does — asserting the formatted forms is what
     pins the two views to one renderer. */
  await expect(page.locator('.page-field-grid')).toContainText('Dry Creek Vineyards');
  await expect(page.locator('.page-field-grid')).toContainText('9,000');
  await expect(page.locator('.page-field-grid')).toContainText('✓ yes');

  /* And the list below it is the rows that point at this record — not the
     table's first ten, which is what a section filter that never got applied
     would have shown. */
  const list = page.locator('.page-list');
  await expect(list.getByRole('row')).toHaveCount(invoices + 1);
  await expect(list).toContainText('1004');
  await expect(list).not.toContainText('1003');
});

test('the chip names the record, not its key', async ({ page }) => {
  /* Arriving by filter there is a label in hand; arriving by link there is
     only a key, and the name is not known until the fields come back. The
     chip was updated faithfully both times — on a header that a second boot
     render had already detached, while the one on screen went on saying `4`. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await expect(page.locator('.root-current')).toContainText('Dry Creek Vineyards');

  // The link that state produced, opened cold.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url);
  await expect(page.locator('.root-current')).toContainText('Dry Creek Vineyards');
  await expect(page.locator('.root-current')).not.toHaveText('4');
});

test('the record pill is a name, not a control', async ({ page }) => {
  /* It wore a ⌄ and navigated to the list on click — a control dressed as
     a dropdown doing neither's job. The crumb owns the way back. */
  await customerPage(page);
  await choose(page, 'name', 'Kereru', 'Kereru Coffee');
  await expect(page.locator('.root-current')).toContainText('Kereru Coffee');
  await expect(page.locator('button.root-current')).toHaveCount(0);

  await page.locator('.crumbs button', { hasText: 'customer' }).first().click();
  await expect(page.locator('.result-head')).toBeVisible();
  await expect(page.locator('.page-title')).toHaveCount(0);
});

test('the chooser offers each filter box once', async ({ page }) => {
  /* The old picker could open with two boxes both labelled `id`. The named
     boxes derive from distinct columns, and this pins that they stay so. */
  await customerPage(page);
  /* The chooser's filters are its search box and a "+" per filter, each in its column's place. */
  const controls = page.locator('.applist-fields [data-column]');
  await expect(controls.first()).toBeVisible();
  const columns = await controls.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-column')));
  expect(new Set(columns).size).toBe(columns.length);
});

test('a record opens as a page with itself already chosen', async ({ page }) => {
  /* The shortest path into the feature: you are already looking at the
     customer, and one click adds everything around it. */
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Harbour Freight' }).click();
  await page.getByRole('button', { name: 'As a page →' }).click();

  await expect(page.locator('.root-current')).toContainText('Harbour Freight');
  await expect(page.locator('.page-field-grid')).toContainText('ops@harbourfreight.example');
});

test('a metric opens the rows it counted', async ({ page }) => {
  /* A number you cannot get behind is a number you have to take on trust.
     The wide fixture, because a metric is what a page shows for the
     relationships past the first two — and the small one has no table with
     three things pointing at it. */
  await openRooted(page, WIDE, 'employee', '1');

  const metric = page.locator('.page-metric-value').first();
  await expect(metric).toBeVisible();
  const shown = Number((await metric.locator('.metric-number').innerText()).replace(/,/g, ''));
  expect(shown).toBeGreaterThan(0);

  await metric.click();
  /* The grid it opens is the same number of rows, narrowed the same way —
     which is the assertion that the count and the click agree. Two-hop
     metrics used to count through the wrong constraint entirely and still
     produce a plausible number. */
  await expect(dataRows(page)).toHaveCount(shown);
});

test('a run of metrics that wraps starts each line flush, with no divider before it', async ({ page }) => {
  /* A divider belongs between two figures on one line. It was a left border on
     every figure after the first, so the figure that wrapped to a new line
     brought its hairline and its padding with it: a stray rule and an indent
     at the start of the line. The hairline now sits in the gap and the row
     clips what falls past its own left edge. */
  await page.setViewportSize({ width: 390, height: 900 });
  await openRooted(page, WIDE, 'employee', '1');
  const row = page.locator('.page-metric-row').first();
  await expect(row.locator('.page-metric-value').first()).toBeVisible();
  const lines = await row.evaluate((el) => {
    const left = el.getBoundingClientRect().left;
    const metrics = [...el.querySelectorAll(':scope > .page-metric')] as HTMLElement[];
    let top = -Infinity;
    return metrics.map((metric, index) => {
      const box = metric.getBoundingClientRect();
      const starts = box.top > top + 1;
      top = Math.max(top, box.top);
      const style = getComputedStyle(metric);
      const rule = getComputedStyle(metric, '::before');
      return {
        index,
        starts,
        indent: Math.round(box.left - left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)),
        border: style.borderLeftStyle,
        /* Where the hairline is drawn, against the row's own left edge. */
        rule: rule.content === 'none' ? null : Math.round(box.left + parseFloat(rule.left) - left),
      };
    });
  });
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.filter((line) => line.starts).length, 'the run wraps at a phone width').toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.border).toBe('none');
    if (line.starts) {
      expect(line.indent, `figure ${line.index} starts its line flush`).toBe(0);
      if (line.rule !== null) expect(line.rule, `figure ${line.index}'s hairline is clipped`).toBeLessThan(-4);
    }
  }
});

test('a page for a table this connection does not have says which is missing', async ({ page }) => {
  /* Two failures shared one message: a table that is not here was reported as
     a table with no primary key, which sends the reader looking for a key on
     something that does not exist. */
  await open(page, DEMO, 'customer');
  await page.evaluate(() => {
    window.history.pushState(null, '', '/demo/customer');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const answer = await page.evaluate(async () => (await fetch('/api/pages/suggested?table=work_order&conn=demo')).json());
  expect((answer as { error: string }).error).toBe('Unknown table "work_order"');
});

test('the builder adds a section and the page redraws with it', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');

  /* "Copy layout", because a suggested page belongs to the schema and is not
     this browser's to change — said on the button rather than discovered on
     save. And "layout", because "Edit" on a screen full of a record's values
     promises to edit the record, which write mode does instead. */
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await expect(builder).toBeVisible();

  await builder.getByRole('textbox', { name: 'Page name' }).fill('Customer overview');
  /* The picker is a menu (Base UI): a button that opens it, items inside. */
  await builder.getByRole('button', { name: '+ Count' }).click();
  await builder
    .getByRole('menuitem', { name: /^invoice / })
    .first()
    .click();
  await builder.getByRole('button', { name: 'Save' }).click();

  await expect(toast(page)).toContainText('Saved "Customer overview"');
  await expect(page.locator('.page-title')).toHaveText('Customer overview');
  /* The root survived the save: an edit that dropped you back to "choose a
     customer" would be an edit you had to undo by hand. */
  await expect(page.locator('.root-current')).toContainText('Dry Creek Vineyards');
  await expect(page.locator('.page-metric-value')).toHaveCount(1);
});

test('a saved page is offered by name, and edits itself rather than a copy', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Kereru', 'Kereru Coffee');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Kept page');
  await builder.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.page-title')).toHaveText('Kept page');

  // Its own page now, so the button says so and a Delete is offered.
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit page' }).getByRole('button', { name: 'Delete' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Edit page' }).getByRole('button', { name: 'Cancel' }).click();

  /* And it is in the command palette, which is where someone looks for "the
     customer page" — a database with one page does not deserve a permanent
     tab and one with nine cannot fit them. */
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('Kept page');
  await expect(page.getByRole('option', { name: 'Kept page' })).toBeVisible();
});

/* ---------- arranging a page ---------- */

test('a referenced record can be pulled in as its own group of fields', async ({ page }) => {
  /* The record view has always been able to show a to-one reference inline —
     the site a work order is at, under the work order's own fields — and a
     page could express it, because a field path may follow a reference. What
     was missing was the way to ask: `+ Fields` added the base table's columns
     and nothing else. */
  await openRooted(page, WIDE, 'employee', '1');

  await page.getByRole('button', { name: /^(Layout|Copy layout)$/ }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: '+ Fields' }).click();
  await builder.getByRole('menuitem', { name: /^site via/ }).click();

  /* The new group counts against the *site's* columns, not the employee's —
     it read "4 of 9" against the wrong table before. */
  const added = builder.locator('.pb-section').last();
  await expect(added.locator('.pb-fields-btn')).toHaveText('4 of 5');

  await builder.getByRole('button', { name: 'Save' }).click();

  const group = page.locator('.page-fold', { hasText: 'SITE' });
  await expect(group).toBeVisible();
  /* Labelled `code`, not `site_id.code`: the heading says which record this
     is, and repeating the hop on every line is the same characters twelve
     times. */
  await expect(group.locator('dt').first()).toHaveText('code');
  await expect(group.locator('dt').first()).toHaveAttribute('title', 'site_id.code');
});

test('the first group of fields does not fold and the ones after it do', async ({ page }) => {
  /* Whatever is at the top of a form is what the form is about, and a page
     that opens with everything shut is a page that opens empty. */
  await openRooted(page, WIDE, 'employee', '1');
  await page.getByRole('button', { name: /^(Layout|Copy layout)$/ }).click();

  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: '+ Fields' }).click();
  await builder.getByRole('menuitem', { name: /^site via/ }).click();
  await builder.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.page-fold')).toHaveCount(1);
  const fold = page.locator('.page-fold');
  await expect(fold).toHaveAttribute('open', '');
  // And it announces as the control it looks like, which a bare summary does not.
  await expect(fold.locator('summary')).toHaveAttribute('aria-expanded', 'true');
  await fold.locator('summary').click();
  await expect(fold.locator('summary')).toHaveAttribute('aria-expanded', 'false');
});

test('a section is dragged into position, not clicked up one row at a time', async ({ page }) => {
  /* The order of the rows in the builder is the order of the page, so
     dragging one is the direct way to say where a section goes — the arrows
     are two clicks and four rows of travel to move something to the top. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });

  const rows = builder.locator('.pb-section');
  /* Settled, not merely "more than one": the dialog builds its rows as the
     page's relations arrive, and reading the order while it is still filling
     compares two different lists. */
  await expect(rows).toHaveCount(2);
  const kinds = () => rows.evaluateAll((all) => all.map((row) => row.querySelector('.pb-kind')?.textContent ?? ''));
  const before = await kinds();

  /* The grip, not the row: the row is mostly inputs, and a draggable row
     swallows the click that puts a caret in the title. */
  const last = rows.last();
  const box = (await last.boundingBox())!;
  /* Aimed at the lower half on purpose: the drop lands above or below
     depending on which half of the row the pointer is in, and the centre of
     the row directly below is the one position that means "stay". */
  await rows
    .first()
    .locator('.pb-section-grip')
    .dragTo(last, { targetPosition: { x: box.width / 2, y: box.height - 4 } });
  const after = await kinds();
  assertMoved(before, after);

  /* And the title box still takes a caret, which is what the grip bought. */
  await builder.locator('.pb-title-input').first().click();
  await expect(builder.locator('.pb-title-input').first()).toBeFocused();
});

/** The first row went somewhere else, and nothing was lost on the way. */
function assertMoved(before: string[], after: string[]): void {
  expect(after).toHaveLength(before.length);
  expect([...after].sort()).toEqual([...before].sort());
  expect(after).not.toEqual(before);
}

test('related lists sitting together become tabs, and only the open one is fetched', async ({ page }) => {
  /* Six things pointing at a record is six tables down a page, the sixth a
     scroll away from the record it is about — and all six fetched whether or
     not anyone looks. Tabs are the default for that reason, and the page
     that has only one list is left alone: a single tab is a heading with a
     border around it. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await expect(page.locator('.page-list')).toBeVisible();
  await expect(page.locator('.page-tabstrip')).toHaveCount(0);

  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: '+ List' }).click();
  await builder
    .getByRole('menuitem', { name: /^invoice / })
    .first()
    .click();
  await builder.getByRole('button', { name: 'Save' }).click();

  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  /* The tab nobody opened has not been fetched. That is the whole reason
     tabs are cheaper than a stack, so it is worth asserting rather than
     assuming. */
  const panels = page.locator('.page-tabpanel');
  await expect(panels.first().locator('table')).toBeVisible();
  await expect(panels.nth(1)).toBeHidden();
  await expect(panels.nth(1).locator('table')).toHaveCount(0);

  await tabs.nth(1).click();
  await expect(panels.nth(1).locator('table')).toBeVisible();
  await expect(panels.first()).toBeHidden();

  /* Arrow keys move within the strip — one Tab stop for the group, which is
     what a tablist is supposed to be. */
  await tabs.nth(1).press('ArrowRight');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.first()).toBeFocused();

  /* And the tab you are looking at is in the link, because "look at the
     parts tab" is a thing people send each other. */
  await tabs.nth(1).click();
  const shared = page.url();
  expect(decodeURIComponent(shared)).toContain('!invoice');
  await page.goto('about:blank');
  await page.goto(shared);
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.page-tabpanel').nth(1)).toBeVisible();
});

test('page view is sticky: a child opens as a page, and so does a reference', async ({ page }) => {
  /* A page is a way of reading a record, not a place. Someone who chose the
     page view for a customer wants the invoice they clicked to open the same
     way — dropping them into the plain record view and making them press "As
     a page" again is the walk changing shape underneath them. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');

  await page.locator('.page-list tbody tr').first().click();
  await expect(page.locator('.page-body')).toBeVisible();
  await expect(page.locator('.record')).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText('invoice');

  /* And a reference followed from a page lands on a page too. */
  await page.locator('.page-field button.ref-jump').first().click();
  await expect(page.locator('.page-body')).toBeVisible();
  await expect(page.locator('.record')).toHaveCount(0);

  /* The walk out of a table is unchanged: nothing was in page view there, so
     a row is still a record. */
  await runQuery(page, 'invoice limit 3');
  await dataRows(page).first().click();
  await expect(page.locator('.record')).toBeVisible();
});

test('a page keeps the trail, and its lists keep their shape when empty', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');

  /* The one view you can now walk several steps deep in was the one with
     nothing saying where you were: renderPage replaced the content the trail
     had just been put into. */
  await expect(page.locator('.crumbs')).toBeVisible();
  await expect(page.locator('.crumbs')).toContainText('Dry Creek Vineyards');

  /* And a list with nothing in it still says which columns had nothing in
     them — the same argument the empty query result has always made. */
  await open(page, WIDE, 'employee');
  await runQuery(page, 'employee id = 1');
  /* Wait for the filter to land before clicking. `runQuery` presses Enter and
     returns; the rows on screen until the answer arrives are the unfiltered
     ones, so "the first row" was occasionally employee 30 and the failure
     read as the heading naming the wrong person. `id = 1` matches one row,
     which makes the count the signal. */
  await expect(dataRows(page)).toHaveCount(1);
  await dataRows(page).first().click();
  await page.getByRole('button', { name: 'As a page' }).click();
  await page.getByRole('button', { name: /^(Layout|Copy layout)$/ }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: '+ List' }).click();
  await builder.getByRole('menuitem', { name: 'warehouse via site_id of its site' }).click();
  await builder.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('tab', { name: /of its site/ }).click();
  const panel = page.locator('.page-tabpanel:not([hidden])');
  await expect(panel.locator('th').first()).toBeVisible();
});

test('the home screen offers the pages you pinned and the record you left', async ({ page }) => {
  /* A page is the most expensive thing anyone builds here, and the only way
     back to one was to remember its name. The home screen remembers instead —
     the pages you pinned, the record you were on, and a filterable list of
     everything else. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');

  /* Saved first, so the list of "all pages" has something in it — a
     suggested page belongs to the schema and is not one of this
     connection's pages, though it can still be pinned. */
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Customer desk');
  await builder.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.page-title')).toHaveText('Customer desk');

  await page.getByRole('button', { name: /^Pin / }).click();

  /* Home is the wordmark, which is where someone would click. */
  await page.getByRole('button', { name: 'tablewalk' }).click();
  const pages = page.locator('.landing-pages');
  await expect(pages).toBeVisible();

  /* Pinned by name; where-you-were by *record*, since being sent back to
     "choose a customer" is not being sent back to where you were. */
  await expect(pages.getByText('Pinned')).toBeVisible();
  await expect(pages.locator('.landing-link-name').first()).toHaveText('Customer desk');
  await expect(pages.getByText('Where you were')).toBeVisible();
  /* Two positions, because the suggested page and the saved one are two
     pages about the same record — which is the point of "where you were"
     rather than "which pages exist". */
  await expect(pages.getByRole('button', { name: 'Dry Creek Vineyards Customer desk' })).toBeVisible();
  /* Links on a line, not cards in a grid: four groups of two-line boxes made
     a wall of rectangles in four different widths. */
  await expect(pages.locator('.landing-chip')).toHaveCount(0);

  /* And everything else, filterable rather than capped. */
  await pages.getByRole('searchbox', { name: 'Filter pages' }).fill('zzz');
  await expect(pages.getByText('No page of that name.')).toBeVisible();
  await pages.getByRole('searchbox', { name: 'Filter pages' }).fill('desk');
  await expect(pages.locator('.landing-page')).toHaveCount(1);

  // The record you left, one click away — with the record still on it.
  await pages.getByRole('button', { name: 'Dry Creek Vineyards Customer desk' }).click();
  await expect(page.locator('.root-current')).toContainText('Dry Creek Vineyards');
});

test('the home screen starts you in this database, not in the syntax', async ({ page }) => {
  /* What stood here was three synthetic queries teaching the language to
     someone who does not yet know what is in the database. These are the
     tables the paragraph above names, with their sizes — and clicking one
     puts it in the query bar and runs it, which is the first lesson anyway. */
  await open(page, DEMO, 'customer');
  await page.getByRole('button', { name: 'tablewalk' }).click();

  const starts = page.locator('.landing-starts');
  await expect(starts).toBeVisible();
  await expect(starts.locator('.start-rows').first()).toContainText('rows');

  const first = starts.locator('.landing-chip').first();
  const name = await first.locator('.landing-chip-name').textContent();
  await first.click();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue(name!);
  await expect(dataRows(page).first()).toBeVisible();
});

test('a page can put its lists back in a stack', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: '+ List' }).click();
  await builder
    .getByRole('menuitem', { name: /^invoice / })
    .first()
    .click();
  /* The toggle is the way out of tabs, which are the default — so it is
     checked when the dialog opens, and unchecking it is the whole feature. */
  const toggle = builder.getByRole('checkbox', { name: 'Lists as tabs' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await builder.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.page-tabstrip')).toHaveCount(0);
  await expect(page.locator('.page-list')).toHaveCount(2);
});

test('a section can be hidden without being taken apart', async ({ page }) => {
  /* Removing throws away the columns, the order and the filter that were
     chosen for a section; hiding keeps all of it and stops drawing it. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await expect(page.locator('.page-list')).toBeVisible();

  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('button', { name: 'Hide this section' }).last().click();
  await builder.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.page-list')).toHaveCount(0);
  // Still there, still configured: one click brings it back.
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Edit page' });
  await expect(again.getByRole('button', { name: 'Show this section' })).toHaveCount(1);
  await again.getByRole('button', { name: 'Show this section' }).click();
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.page-list')).toBeVisible();
});

test('fields are arranged by dragging, and the page lays them out that way', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });

  await builder.locator('.pb-fields-btn').first().click();
  const rows = builder.locator('.pb-arrange-row');
  await expect(rows.first()).toContainText('id');

  /* Alt+↓ rather than a synthesised drag: it is the same move through the
     same code, it is the path a keyboard takes, and a drag simulated with
     mouse events tests Playwright more than it tests the page. */
  await rows.first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(rows.nth(1)).toContainText('id');
  await expect(rows.first()).toContainText('name');

  // Two columns, so the arrangement has columns to be an arrangement of.
  await builder.getByRole('button', { name: 'Field columns' }).first().click();
  await page.getByRole('option', { name: '2 col' }).click();
  await builder.getByRole('button', { name: 'Save' }).click();

  const grid = page.locator('.page-field-grid');
  await expect(grid.locator('dt').first()).toHaveText('name');
  await expect(grid).toHaveCSS('grid-template-columns', /^[\d.]+px [\d.]+px$/);
});

test('an empty relationship can be folded out of the Related rail', async ({ page }) => {
  /* On a wide schema most of a record's relationships are empty — eighteen
     entries, seven of them zero — and the ones with rows are what somebody
     came to read. Folded away rather than dropped: "nothing points here
     through this" is a real answer, so the control says how many it is
     hiding. */
  await open(page, WIDE, 'employee');
  await dataRows(page).first().click();
  const rail = page.locator('.related-list');
  await expect(rail).toBeVisible();

  const empties = page.getByRole('button', { name: /empty$/ });
  await expect(empties).toBeVisible();
  const before = await rail.locator('.related-item:visible').count();

  await empties.click();
  await expect(rail).toHaveClass(/hide-empty/);
  const after = await rail.locator('.related-item:visible').count();
  expect(after).toBeLessThan(before);
  await expect(rail.locator('.related-item.empty:visible')).toHaveCount(0);

  // And back, saying how many are being put back.
  await expect(empties).toHaveText(/^show \d+ empty$/);
  await empties.click();
  await expect(rail.locator('.related-item:visible')).toHaveCount(before);
});

test('a table with no name of its own is named through its identity reference', async ({ page }) => {
  /* employee has no text column worth calling a name — the name lives one
     to-one hop away, on party. The heading and the crumb are where that walk
     has to pay off: a record page reading "employee · 1" when the tool knows
     the row is Ingrid Fraser is the tool failing its own idea. */
  await open(page, WIDE, 'employee');
  await runQuery(page, 'employee id = 1');
  await dataRows(page).first().click();

  await expect(page.locator('.record-heading')).toContainText('employee · Ingrid Fraser');
  await expect(page.getByRole('navigation', { name: 'Trail' })).toContainText('Ingrid Fraser');
});

test('a related list also names its rows through the walk, once opened', async ({ page }) => {
  /* The same rule from the other side: an invoice is not named after its
     customer — forty invoices share that name — so the ownership hop is
     refused and the key stays. */
  await open(page, DEMO, 'invoice');
  await runQuery(page, 'invoice id = 1004');
  await dataRows(page).first().click();
  await expect(page.locator('.record-heading')).toContainText('invoice · 1004');
});

test('a section about a record the root points at, filtered by that record', async ({ page }) => {
  /* The builder offers what points at each table the root points at — here,
     warehouses at the employee's *site*. Employee 1 sits at site 3, which has
     exactly one warehouse, WH-3; a filter that quietly used the root's own
     key instead of the site's would show nothing, and one that dropped the
     filter would show every warehouse. One row, the right row, is the test. */
  await open(page, WIDE, 'employee');
  await runQuery(page, 'employee id = 1');
  await dataRows(page).first().click();
  await page.getByRole('button', { name: 'As a page' }).click();

  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Employee and site');
  await builder.getByRole('button', { name: '+ List' }).click();
  await builder.getByRole('menuitem', { name: 'warehouse via site_id of its site' }).click();
  await builder.getByRole('button', { name: 'Save' }).click();

  /* The new list joins the ones already on the page, and related lists that
     sit together are tabs — so it is opened before it is read. The tab is
     named for the section, which is what keeps two lists of the same table
     through different references apart. */
  await page.getByRole('tab', { name: /of its site/ }).click();
  const section = page.locator('.page-tabpanel:not([hidden]) .page-list');
  await expect(section).toContainText('WH-3');
  await expect(section.getByRole('row')).toHaveCount(2); // header + the one warehouse
});

test('a field is sent to another group, which receives it as its own', async ({ page }) => {
  /* The \u2192 on a field row and a drag onto another section's row are the
     same move through receiveField; the keyboard spelling is the one worth
     driving, for the reason the arrange test gives. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });

  // A second group to send to: the country, pulled in as its own fields.
  await builder.getByRole('button', { name: '+ Fields' }).click();
  await builder.getByRole('menuitem', { name: /^country via country_code/ }).click();

  await builder.locator('.pb-fields-btn').first().click();
  await builder.locator('.pb-arrange-row', { hasText: 'email' }).getByRole('button', { name: 'Move email to another group' }).click();

  // Gone from the first group, present in the second — as customer.email,
  // qualified, because the group it landed in is about another table.
  await expect(builder.locator('.pb-arrange-row', { hasText: 'email' })).toHaveCount(0);
  /* `.last()`, because every list section carries the same column button and
     the new group was appended after them. */
  await builder.locator('.pb-fields-btn').last().click();
  await expect(builder.locator('.pb-arrange-row', { hasText: 'email' })).toBeVisible();
});

test('a section can be offset, and the page leaves the space', async ({ page }) => {
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });

  // Half width, pushed to the right half: width, then a half of empty space
  // on the left.
  const fieldsRow = builder.locator('.pb-section').first();
  await fieldsRow.getByRole('button', { name: 'Width' }).click();
  await page.getByRole('option', { name: 'half' }).click();
  await fieldsRow.getByText('Spacing', { exact: true }).click();
  await fieldsRow.getByRole('button', { name: 'Left offset' }).click();
  await page.getByRole('option', { name: '⇥ ½' }).click();
  await builder.getByRole('button', { name: 'Save' }).click();

  const section = page.locator('.page-section.page-fields');
  await expect(section).toHaveClass(/offset-l-half/);
  // The saved layout's class arrives before its hidden loading section has a
  // used margin. Measure the rendered fields, not that placeholder's calc().
  await expect(section).toBeVisible();
  await expect.poll(() => section.evaluate((el) => parseFloat(getComputedStyle(el).marginLeft))).toBeGreaterThan(100);
});

test('a saved page outlives this browser', async ({ page }) => {
  /* The pages file is the layouts file's twin: build a page, wipe every
     trace of it from the browser, and the server hands it back on load.
     Without the round trip this test sees only the suggested page. */
  /* Marked slow for the CI runners: choose → builder → save → reload →
     palette is five round trips that fit 20s locally and have twice
     missed it on a loaded runner — the only spec to, both times at the
     same fill. Triple budget, same assertions. */
  test.slow();
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await page.getByRole('button', { name: 'Copy layout' }).click();
  const builder = page.getByRole('dialog', { name: 'Edit page' });
  await builder.getByRole('textbox', { name: 'Page name' }).fill('Survives the browser');
  await builder.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.page-title')).toHaveText('Survives the browser');

  /* Wipe the browser — except the tour flag, which is not what this test
     is about: clearing it re-arms the first-run tour, whose scrim then
     races ⌘K for the palette and wins on a slow runner. The page itself
     lives on the server; the flag is furniture. */
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('mistri.tour.v1', 'done');
  });
  await page.reload();

  /* Boot first, then the shortcut: ⌘K pressed before the client's
     modules have attached their listeners lands in the void, and the
     test then waits forever for a palette nobody was told to open. The
     sidebar's first table row is the boot-complete signal every other
     restore in this suite already relies on. */
  await expect(page.locator('#table-list button[data-table]').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('Survives');
  await expect(page.getByRole('option', { name: 'Survives the browser' })).toBeVisible();
});

test('a reference offers exactly two gestures: peek and go', async ({ page }) => {
  /* The unfold-in-place caret is gone — the card pushed fields out of
     reading order and clipped against its column — so what a chip offers
     is the hover peek and the click-through, and *only* those.

     There was a `.nest-caret` count assertion here and it was worthless: the
     element was deleted in the same commit that added the guard, so it
     counted zero of something that had never existed and would have gone on
     passing whatever came back. A guard against a third gesture has to name
     what a gesture IS in today's markup, not a class name from the one that
     was removed. */
  await open(page, WIDE, 'employee');
  await runQuery(page, 'employee id = 1');
  await dataRows(page).first().click();
  await expect(page.locator('.record-heading')).toContainText('Ingrid Fraser');

  // The heading exists under the navigation hold. Hovering before the reveal
  // settles can scroll the chip into view *after* mouseover, cancelling peek.
  await expect(page.locator('#content')).not.toHaveClass(/\bnav-(holding|enter)\b/);
  const field = page.locator('.record .field-ref').first();
  const chip = field.locator('.ref-jump');
  await expect(field.locator('button, a, [role="button"], [role="link"], [tabindex]')).toHaveCount(1);
  // Enter from outside the record, independently of where the row click left
  // the pointer while the new page was being laid out.
  await page.getByRole('button', { name: 'tablewalk', exact: true }).hover();
  const address = page.url();
  await chip.hover();
  await expect(page.locator('.peek')).toBeVisible();
  await expect(page.locator('.peek')).toContainText('Ingrid Fraser');
  await expect(page).toHaveURL(address);
  await chip.click();
  await expect(page.locator('.record-heading')).toContainText('party · Ingrid Fraser');
  await expect(page).not.toHaveURL(address);
});

test('the landing brings a page you visited back beside the schema, at the same height', async ({ page }) => {
  /* Two assertions in one walk, because they are the same fact: a page you
     were on is work worth resuming, and the card offering it sits in the top
     row *as a column*, not as a band stacked under the schema.

     The height is geometric on purpose. The row stretches both cards to the
     taller one, and the work card kept a `margin-bottom` from when it was a
     full-width band — a rule that won on cascade order and gave 16px of the
     stretched box back, so the two cards ended on different lines. Nothing
     but the boxes the browser drew can catch that coming back. */
  await customerPage(page);
  await choose(page, 'name', 'Dry Creek', 'Dry Creek Vineyards');
  await expect(page.locator('.page-title')).toBeVisible();

  // The wordmark, which is the home link every web app has.
  await page.getByRole('button', { name: 'tablewalk' }).click();

  const cards = page.locator('.landing-top > .shape');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText('Where you were');
  await expect(cards.nth(1)).toContainText('Dry Creek Vineyards');

  const bottoms = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
  expect(Math.abs(bottoms[0] - bottoms[1])).toBeLessThanOrEqual(1);
});
