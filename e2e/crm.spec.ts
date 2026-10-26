/**
 * The CRM example, end to end: the app that uses every knob, over a
 * writable connection. What the fieldops spec covers once, this covers in
 * the dress a Retool-shopper sees first — the dashboard's deltas and pills,
 * the record page's title and labels, the list's relative dates, the New
 * form's controls and its required check, the record's own actions, and a
 * section that appears only when the record says so.
 */
import { CRM, expect, type Page, test } from './support/ownServers';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

async function open(page: Page, path = ''): Promise<void> {
  await page.goto(`${CRM}${path || '/'}`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
}

test('the dashboard: coloured deltas, a whole vocabulary in pills, a chart with a scale, and the board lit in the nav', async ({
  page,
}) => {
  await open(page);
  // The landing is the first dashboard, and its nav entry knows it: the
  // entry sits in the Sales menu, so the group lights and the item is current.
  await expect(page.locator('#topnav .tn-group.active')).toContainText('Sales');
  expect(await page.locator('#topnav [data-dash][aria-current="true"]').count()).toBeGreaterThan(0);
  // `better: "up"` on a metric that fell: the delta wears bad.
  const bad = page.locator('.dash-delta.bad').first();
  await expect(bad).toBeVisible();
  await expect(bad).toContainText('↓');
  // "*": neutral pills for the stage values the author had nothing to say about.
  await expect(page.locator('.tone-neutral:visible').first()).toBeVisible();
  // Three labelled gridlines, and every month labelled.
  const svg = page.locator('.chart-line').first();
  /* The chart is the last section to answer — a breakdown over the whole
     table — and on a loaded runner with three servers up it can take longer
     than the default expectation. Wait for it by name before counting. */
  await expect(svg).toBeVisible({ timeout: 20_000 });
  await expect(svg.locator('.chart-grid')).toHaveCount(3);
  expect(await svg.locator('.chart-tick').count()).toBeGreaterThan(6);
  // A window pick is shareable without turning the landing into another page.
  // Compass shows its windows as one date-range button: the menu holds the choices.
  await page.getByRole('button', { name: /^Time window:/ }).click();
  await page.getByRole('menuitem', { name: 'Last 30 days' }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname + url.search;
    })
    .toBe('/?period=last-30-days');
  await expect(page.locator('.applist-title')).toHaveText('Sales dashboard');
  await expect(page.locator('.crumbs-host')).toHaveCount(0);
});

test('a record page is titled by its record, labelled by what a field is, and says — where there is nothing', async ({ page }) => {
  await open(page, '/@lead~127');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Margot Fontaine');
  await expect(page.locator('.page-head.has-record .page-title')).toHaveText('Lead');
  const labels = page.locator('.page-field dt');
  await expect(labels.filter({ hasText: /^Owner$/ })).toHaveCount(1);
  await expect(labels.filter({ hasText: /Owner ID/i })).toHaveCount(0);
  await expect(page.locator('.page-field .null').first()).toHaveText('—');
  // The `when` section: not converted, so "Converted to" is not on the page.
  await expect(page.locator('.page-section-head', { hasText: 'Converted to' })).toHaveCount(0);
  await expect(page.getByText('null', { exact: true })).toHaveCount(0);
});

test("a pasted record link opens as the app's page, and a bare table link lands on the first tab", async ({ page }) => {
  await open(page, '/lead/~127');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Margot Fontaine');
  // Said as the record's own address, under the view that lists leads.
  await expect.poll(() => new URL(page.url()).pathname).toBe('/leads/127');
  await open(page, '/task');
  await expect(page.getByRole('tab', { name: /Overdue/ })).toHaveAttribute('aria-selected', 'true');
  // Relative dates on the due column, and no explorer expander in an app list
  // (its leading cells hold the selection an editable list offers, not ▸).
  // A due date is said from today only within two weeks (79a20de65); past that
  // the date is the text and the relative phrase its title. The fixture's dates
  // are fixed while today moves, so either side may carry the phrase.
  const due = page.locator('td .relative').first();
  await expect.poll(async () => `${await due.textContent()} | ${await due.getAttribute('title')}`).toMatch(/ago|today|tomorrow|in \d/);
  await expect(page.locator('.expander')).toHaveCount(0);
});

test('field presentation: CRM keeps configured labels and formatting on record and reference previews', async ({ page }, testInfo) => {
  await open(page, '/opportunity/~1');
  await expect(page.locator('.page-field dt[title="probability"]')).toHaveText('Prob. %');
  // The record's name is said once, by the head, not again as a field.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.page-field dt[title="name"]')).toHaveCount(0);
  await expect(
    page
      .locator('.page-field')
      .filter({ has: page.locator('dt[title="amount"]') })
      .locator('.num-value'),
  ).toContainText('$');
  const account = page
    .locator('.page-field')
    .filter({ has: page.locator('dt[title="account_id"]') })
    .locator('.ref-jump');
  /* The deal's fields are the aside's rail, below the fold: the scroll that
     brings them in closes any card (Peek.tsx), so it ends before the hover. */
  await account.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await account.hover();
  const card = page.getByRole('tooltip');
  await expect(card).toBeVisible();
  await expect(
    card
      .locator('.peek-line')
      .filter({ has: page.locator('.peek-name[title="rating"]') })
      .locator('.tone'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('crm-reference-formatting.png'), fullPage: true });
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
  await open(page, '/activity');
  await page.getByRole('button', { name: '+ New activity' }).click();
  const form = page.locator('.newpanel');
  await expect(form.getByRole('combobox', { name: 'Rep', exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
});

test("the New form: human labels, the page's own controls, a record picker, and required means required", async ({ page }) => {
  await open(page, '/lead');
  await page.getByRole('button', { name: '+ New lead' }).click();
  /* A drawer over the list, not a modal: the list stays visible and the
     address is the list's `/new`, so a reload keeps the form open. */
  const dialog = page.locator('.newpanel');
  await expect(dialog.getByRole('heading')).toHaveText('New lead');
  await expect(page.locator('.applist-title')).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/leads/new');
  // No schema chatter: the curated seven, no status (defaulted), no id.
  await expect(dialog.locator('.insert-field label')).toHaveCount(7);
  await expect(dialog.getByText(/integer|text required/)).toHaveCount(0);
  await expect(dialog.locator('select')).toHaveCount(0);
  await expect(dialog.locator('.dd-button')).toHaveCount(1); // source
  await expect(dialog.locator('.picker')).toHaveCount(1); // owner
  // Submitting empty names every required field, and nothing went to the wire.
  await dialog.getByRole('button', { name: 'Add' }).click();
  /* Each missing field says so where it is; there is no summary alert to
     read twice, and the first missing field takes focus. */
  // Created starts today (`defaults: { created_on: today }`), so five are missing.
  await expect(dialog.locator('.insert-field.missing')).toHaveCount(5);
  await expect(dialog.locator('.insert-field.missing .insert-missing').first()).toHaveText('Fill in Name.');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await expect(dialog.locator('.insert-problem')).toBeHidden();
  // The picker searches by name and keeps the id.
  const picker = dialog.locator('.picker-input');
  await picker.fill('Arjun');
  await expect(dialog.locator('.picker-option').first()).toContainText('Arjun');
  await dialog.locator('.picker-option').first().click();
  await expect(picker).toHaveValue(/Arjun/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard record' }).click();
  await expect(page.locator('.newpanel')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/leads');
  // And the address reopens it.
  await page.goto(`${CRM}/leads/new`);
  await expect(page.locator('.newpanel').getByRole('heading')).toHaveText('New lead');
});

test('the New form draws its rows side by side at a desk, boxes level whatever is said under them, and one column on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/lead');
  await page.getByRole('button', { name: '+ New lead' }).click();
  const dialog = page.locator('.newpanel');
  /* `fields: ['name', ['email', 'phone']]` and `['company', ['source', 'owner_id'], 'created_on']`
     (test/fixtures/apps/crm/resources.ts): each pair one row, each box the same top and height as its neighbor's. */
  /* The box a person sees: a text box, the listbox's button, the record picker's frame (its input sits inside it). */
  const control = (name: string) =>
    name === 'Owner'
      ? dialog.locator('.picker', { has: page.getByRole('combobox', { name: 'Owner', exact: true }) })
      : dialog.getByRole(name === 'Source' ? 'button' : 'textbox', { name, exact: true });
  const box = async (name: string) => (await control(name).boundingBox())!;
  const level = async (left: string, right: string) => {
    const [a, b] = [await box(left), await box(right)];
    expect(b.x, `${right} stands beside ${left}`).toBeGreaterThan(a.x + a.width);
    expect(Math.abs(a.y - b.y), `${left} and ${right} start level`).toBeLessThan(1);
    expect(Math.abs(a.height - b.height), `${left} and ${right} are one height`).toBeLessThan(1);
  };
  await expect(dialog.locator('.form-columns')).toHaveCount(2);
  await level('Email', 'Phone');
  await level('Source', 'Owner');
  // An error under one half (Email is required) and help under the other (Phone's) leave the boxes level.
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.locator('.insert-field.missing')).toHaveCount(5);
  await level('Email', 'Phone');
  await level('Source', 'Owner');
  // A phone's drawer is too narrow for two: the row is one column, Phone under Email.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await box('Phone')).y > (await box('Email')).y + (await box('Email')).height).toBe(true);
  expect(Math.abs((await box('Phone')).x - (await box('Email')).x)).toBeLessThan(1);
});

test('form defaults: authored order, cleared presets and explicit null survive a real create', async ({ page }, testInfo) => {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    /* The New form is the resource's, served on it. */
    const entry = (payload.app.resources.lead ??= {});
    entry.form = {
      show: ['phone', 'company', 'name'],
      defaults: {
        name: 'Default lead',
        company: 'Default company',
        phone: null,
        converted_contact_id: null,
        source: 'event',
        owner_id: 1,
        email: 'form-defaults@example.test',
        created_on: '2026-09-04',
        status: 'new',
      },
    };
    await route.fulfill({ response, json: payload });
  });
  const submitted: Array<{ values: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/insert') submitted.push(request.postDataJSON());
  });
  let key: Record<string, unknown> | undefined;
  try {
    await open(page, '/lead');
    await page.getByRole('button', { name: '+ New lead' }).click();
    const form = page.locator('.newpanel');
    // The authored order; the needed fields are simply asked, and the one that may be left empty says so beside its label.
    await expect(form.locator('.insert-field label')).toHaveText(['Phone', 'Company', 'Name']);
    await expect(form.locator('.insert-field .form-field-optional-word')).toHaveCount(1);
    await expect(form.locator('.insert-field').first().locator('.form-field-optional-word')).toHaveText('(optional)');
    await expect(form.getByRole('textbox', { name: 'Phone', exact: true })).toHaveAttribute('placeholder', 'No value');
    await form.getByRole('textbox', { name: 'Company', exact: true }).clear();
    await form.getByRole('textbox', { name: 'Name', exact: true }).clear();
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.locator('.insert-field.missing .insert-missing')).toHaveText(['Fill in Company.', 'Fill in Name.']);
    await expect(form.getByRole('textbox', { name: 'Company', exact: true })).toBeFocused();
    expect(submitted).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('form-defaults-validation.png'), fullPage: true });
    await form.getByRole('textbox', { name: 'Company', exact: true }).fill('Form contract company');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Form contract lead');
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const result = await (await response).json();
    key = result.key;
    expect(result.errors).toBeUndefined();
    expect(key?.id).toBeDefined();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].values).toMatchObject({
      name: 'Form contract lead',
      company: 'Form contract company',
      phone: null,
      converted_contact_id: null,
      owner_id: 1,
    });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Form contract lead');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Form contract lead');
    const read = await page.request.post(`${CRM}/api/run`, { data: { app: 'compass', q: `lead id = ${key!.id}` } });
    expect((await read.json()).rows[0]).toMatchObject({
      name: 'Form contract lead',
      company: 'Form contract company',
      phone: null,
      converted_contact_id: null,
      status: 'new',
    });
  } finally {
    if (key) {
      const removed = await page.request.post(`${CRM}/api/delete`, { data: { app: 'compass', table: 'lead', key, confirm: true } });
      expect((await removed.json()).deleted).toBe(true);
    }
  }
});

test("an action is the app's own verb on the record, shown while its when holds", async ({ page }) => {
  await open(page, '/@lead~127');
  // App editing defaults on; the quiet shell has no Workbench editing toggle.
  // status = new: "Start working" shows, "Mark qualified" does not yet.
  const start = page.getByRole('button', { name: 'Start working' });
  await expect(start).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark qualified' })).toBeHidden();
  await start.click();
  await expect(page.getByRole('button', { name: 'Mark qualified' })).toBeVisible();
  await expect(start).toBeHidden();
  // And back, through the same door, so the fixture is left as it was.
  await page.getByRole('button', { name: 'Mark qualified' }).click();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toBeVisible();
  await page.request.post(`${CRM}/api/update`, { data: { app: 'compass', table: 'lead', key: { id: 127 }, values: { status: 'new' } } });
});

test('the write scope: Accounts has no New, Leads does', async ({ page }) => {
  await open(page, '/account');
  await expect(page.locator('.applist-new')).toHaveCount(0);
  await open(page, '/lead');
  await expect(page.locator('.applist-new')).toHaveText('+ New lead');
});
