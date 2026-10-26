/**
 * The record layout builder: which fields a record shows, and in what order.
 *
 * The builder is a drawer beside the record it is editing, and that adjacency
 * is the feature — every change redraws the record, so a layout is judged on
 * the actual thing rather than on a diagram of it. So these tests read the
 * record, not the drawer: an arranger that reorders its own rows and leaves
 * the record alone has done nothing.
 *
 * Order is the newer half of the question. The builder chose fields with
 * checkboxes for months, which can say *which* and never *where* — while the
 * record has always drawn its fields in the order the layout lists them. The
 * arranger under it is now the page builder's (`src/client/arrange.js`), so
 * the two builders answer this the same way.
 */
import { expect, test, type Page } from './support/harness';
import { DEMO, WIDE } from './support/fixtures';
import { dataRows, follow, open, runQuery } from './support/app';

/* Layouts persist server-side, in a file under this suite's own XDG root, so
   a layout saved by one test would be the layout every later test sees. Each
   starts from none. */
test.beforeEach(async ({ request }) => {
  for (const table of ['customer', 'invoice']) {
    await request.post('/api/layouts', { data: { conn: DEMO, table, layout: null } });
  }
});

/** The drawer, open on a customer record. */
async function layoutOf(page: Page, name: string): Promise<void> {
  await open(page, DEMO, 'customer');
  await runQuery(page, `customer name contains ${name}`);
  await expect(dataRows(page).first()).toContainText(name);
  await dataRows(page).first().click();
  await expect(page.locator('.record-heading')).toContainText(name);
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await expect(page.locator('.tpl')).toBeVisible();
}

/** A block in the drawer, by the heading on its card. */
const block = (page: Page, heading: string) => page.locator('.tpl-section').filter({ has: page.getByText(heading, { exact: true }) });

/** The names of the fields the record is showing, in the order it shows them. */
const shownFields = (page: Page) => page.locator('.layout .field > :first-child');

/** The columns of the child table under the record, in the order shown. */
const childColumns = (page: Page) => page.locator('.layout thead th');

test('a field moved up the block moves up the record beside it', async ({ page }) => {
  await layoutOf(page, 'Dry Creek');

  const fields = block(page, 'Fields').locator('.pb-arrange-row');
  await expect(fields.first()).toContainText('id');
  const before = await shownFields(page).allInnerTexts();
  expect(before[1]).toContain('name');

  /* Alt+↑ rather than a drag, as in the page builder's own suite: the same
     move through the same code, and the path a keyboard takes. A drag
     synthesised from mouse events tests Playwright more than it tests the
     page — the gesture itself is a thing to check by doing it. */
  const signedUp = fields.filter({ hasText: 'signed_up' });
  await signedUp.click();
  await signedUp.press('Alt+ArrowUp');
  await signedUp.press('Alt+ArrowUp');
  await signedUp.press('Alt+ArrowUp');
  await signedUp.press('Alt+ArrowUp');
  await signedUp.press('Alt+ArrowUp');

  // The drawer says so...
  await expect(fields.nth(1)).toContainText('signed_up');
  // ...and so does the record, which is the assertion that matters.
  await expect.poll(async () => (await shownFields(page).allInnerTexts())[1]).toContain('signed_up');
});

test('a field taken off the block leaves the record, and can be put back', async ({ page }) => {
  await layoutOf(page, 'Dry Creek');

  const fields = block(page, 'Fields').locator('.pb-arrange-row');
  await fields.filter({ hasText: 'email' }).getByRole('button', { name: 'Remove email' }).click();

  await expect(shownFields(page).filter({ hasText: 'email' })).toHaveCount(0);
  // It is not gone, it is on offer: the pool below holds everything not shown.
  await block(page, 'Fields').getByRole('button', { name: 'Add email', exact: true }).click();
  await expect(shownFields(page).filter({ hasText: 'email' })).toHaveCount(1);
});

test('a list section orders the columns of the table under the record', async ({ page }) => {
  /* The half that was inert. A list section has always stored its columns as
     a list, and the record view filtered the *query's* columns by it — which
     kept the database's order, so an arrangement made here changed nothing.
     Nothing could see that while the builder had no way to arrange. */
  await layoutOf(page, 'Dry Creek');

  await expect(childColumns(page).first()).toContainText('id');

  const columns = block(page, 'invoice').locator('.pb-arrange-row');
  const total = columns.filter({ hasText: 'total' });
  await total.click();
  await total.press('Alt+ArrowUp');
  await total.press('Alt+ArrowUp');
  await total.press('Alt+ArrowUp');

  await expect(columns.first()).toContainText('total');
  await expect(childColumns(page).first()).toContainText('total');

  // And it survives being saved, which is where the layout stops being a draft.
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.locator('.tpl')).toHaveCount(0);
  await page.reload();
  await expect(childColumns(page).first()).toContainText('total');
});

test('a pending layout cannot be changed or dismissed; a failed save retains it for retry', async ({ page }, testInfo) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route('**/api/layouts', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    writes += 1;
    if (writes === 1) {
      await paused;
      await route.fulfill({ status: 500, json: { error: 'Layout file is read-only.' } });
    } else await route.continue();
  });
  try {
    await layoutOf(page, 'Dry Creek');
    const editor = page.locator('.tpl');
    await editor.getByRole('textbox', { name: 'Layout name' }).fill('Retry layout');
    await editor.getByRole('button', { name: 'Save layout' }).click();
    await expect(editor.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    await expect(editor.getByRole('textbox', { name: 'Layout name' })).toBeDisabled();
    await expect(editor.locator('.tpl-body')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    release();
    await expect(editor.getByRole('alert')).toContainText('not confirmed');
    await expect(editor.getByRole('textbox', { name: 'Layout name' })).toHaveValue('Retry layout');
    const before = await page.request.get(`/api/layouts?conn=${DEMO}`);
    expect((await before.json()).layouts.customer).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath('layout-save-failed.png'), fullPage: true });
    await editor.getByRole('button', { name: 'Save layout' }).click();
    await expect(editor).toHaveCount(0);
    expect(writes).toBe(2);
    await page.reload();
    await expect(page.locator('.record-layout')).toContainText('Retry layout');
  } finally {
    release();
  }
});

test('record-layout drafts survive reload and require an explicit restore or discard', async ({ page }, testInfo) => {
  await layoutOf(page, 'Dry Creek');
  await page.getByRole('textbox', { name: 'Layout name' }).fill('Recovered layout');
  await block(page, 'Fields').getByRole('button', { name: 'Remove email', exact: true }).click();
  await page.reload();
  await page.locator('.record-layout').click();
  const editor = page.locator('.tpl');
  await expect(editor.getByRole('button', { name: 'Restore draft' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save layout' })).toBeDisabled();
  await expect(shownFields(page).filter({ hasText: 'email' })).toHaveCount(1);
  await editor.getByRole('button', { name: 'Restore draft' }).click();
  await expect(editor.getByRole('textbox', { name: 'Layout name' })).toHaveValue('Recovered layout');
  await expect(shownFields(page).filter({ hasText: 'email' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  const box = await editor.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  expect(box!.width).toBeGreaterThanOrEqual(389);
  expect(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('layout-recovered-mobile.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Discard layout changes?');
  await page.getByRole('button', { name: 'Discard layout', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await page.locator('.record-layout').click();
  await expect(page.getByRole('button', { name: 'Restore draft' })).toHaveCount(0);
});

test('a late layout acknowledgement stays on its original database and leaves a new editor alone', async ({ page }) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/api/layouts', async (route) => {
    if (route.request().method() === 'POST') {
      requested();
      await paused;
    }
    await route.continue();
  });
  try {
    await layoutOf(page, 'Dry Creek');
    await page.getByRole('textbox', { name: 'Layout name' }).fill('Original database');
    await page.getByRole('button', { name: 'Save layout' }).click();
    await started;
    await follow(page, `/${WIDE}/ticket`);
    await expect(page.locator('#db-label')).toContainText(WIDE);
    await expect(page.locator('.tpl')).toHaveCount(0);
    await dataRows(page).first().click();
    await page.locator('.record-layout').click();
    await page.getByRole('textbox', { name: 'Layout name' }).fill('New database draft');
    const arrived = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/layouts',
    );
    release();
    await arrived;
    await expect(page.getByRole('textbox', { name: 'Layout name' })).toHaveValue('New database draft');
    await expect(page.locator('#db-label')).toContainText(WIDE);
    const saved = await page.request.get(`/api/layouts?conn=${DEMO}`);
    expect((await saved.json()).layouts.customer.name).toBe('Original database');
    const other = await page.request.get(`/api/layouts?conn=${WIDE}`);
    expect((await other.json()).layouts.customer).toBeUndefined();
  } finally {
    release();
  }
});

test('a field is sent from one block to another, and the record follows', async ({ page }) => {
  await layoutOf(page, 'Dry Creek');

  /* The reference block is off by default — a derived layout offers it rather
     than assuming it — so turning it on is the first step, and the second is
     that it becomes somewhere a field can be sent. */
  const country = block(page, 'country · via country_code');
  await country.getByRole('checkbox').check();
  await expect(country.locator('.pb-arrange-row')).toHaveCount(1);

  const fields = block(page, 'Fields').locator('.pb-arrange-row');
  await fields.filter({ hasText: 'email' }).getByRole('button', { name: 'Move email to another group' }).click();

  await expect(fields.filter({ hasText: 'email' })).toHaveCount(0);
  await expect(country.locator('.pb-arrange-row')).toHaveCount(2);
  // Last on the record, because it landed at the end of the block it moved to.
  await expect.poll(async () => (await shownFields(page).allInnerTexts()).at(-1)).toContain('email');
});
