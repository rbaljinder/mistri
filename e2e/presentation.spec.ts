import { CRM, CRM_DB, expect, test } from './support/ownServers';
import { rows } from './support/db';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

test('unconfigured lists use named defaults and retain composite keys for navigation', async ({ page }) => {
  await page.goto(`${CRM}/opportunity_line`);
  await expect(page.locator('.applist-title')).toHaveText('Opportunity line');
  // The named default rides the walk (history state); the address is the table's own.
  await expect.poll(async () => decodeURIComponent(String(await page.evaluate(() => history.state?.trail)))).toContain('product_sku.name');
  expect(new URL(page.url()).pathname).toBe('/opportunity_line');
  const table = page.locator('.result-table table');
  const first = table.locator('tbody tr').first();
  await expect(first).toBeVisible();
  const cells = await first.locator('td').allTextContents();
  expect(cells[2].trim()).not.toBe('');
  /* The key comes from the row, not its cells: a reference cell now draws the
     record's name ("Silverbirch Health plc — New business"), and the address
     says its id. */
  const key = (JSON.parse(String(await first.getAttribute('data-row-key'))) as Array<[string, string]>).map(([, value]) => value);
  expect(key).toHaveLength(2);
  await first.locator('td').first().click();
  // A key of two columns, one of them its parent: said under the parent's address.
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/opportunities/${key[0]}/opportunity_line/${key[1]}`);
});

test('joined boolean metadata agrees between mobile records and the grid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${CRM}/${encodeURIComponent('opportunity_line show opportunity_id, line_no, product_sku.name, product_sku.is_active limit 5')}`,
  );
  const summary = page.locator('.record-summary').first();
  await expect(summary.locator('.bool-value')).toHaveText(/^(✓ yes|✗ no)$/);
  const value = (await summary.locator('.bool-value').textContent())!.trim();
  /* These records say every column, so a phone offers no Table to switch to; the grid is read at a desk's width. */
  await expect(page.getByRole('group', { name: 'List presentation' })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator('.result-table tbody tr').first().locator('td.bool')).toHaveText(value.startsWith('✓') ? '✓' : '✗');
});

/* An App has no Undo, so `confirm: true` is asked there as in the Workbench: one click writes nothing until the
   dialog is accepted — a fixed action from a phone's More menu, and a machine's verb from the header. */
test('App verbs that confirm ask before they write, and write once on yes', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(insert|update|delete|command)(?:\?|$)/.test(request.url())) writes.push(request.url());
  });
  await page.route('**/api/update', (route) => route.fulfill({ json: { affected: 1, applied: route.request().postDataJSON().values } }));
  await page.goto(`${CRM}/@lead~127`);
  await page.setViewportSize({ width: 320, height: 844 });
  // A phone keeps the first action in the bar; Mark lost is folded into More actions.
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Mark lost', exact: true }).click();
  const fixed = page.getByRole('dialog', { name: 'Mark lost?' });
  await expect(fixed).toBeVisible();
  expect(writes).toHaveLength(0);
  await fixed.getByRole('button', { name: 'Mark lost', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);

  const [open] = rows<{ id: number }>(
    CRM_DB,
    "select id from opportunity where stage not in ('closed_won', 'closed_lost') order by id limit 1",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${CRM}/opportunities/${open.id}`);
  // A record's verbs stand at the end of the crumb bar at a desk (PageHead.tsx).
  const header = page.locator('.crumb-tools');
  await header
    .getByRole('button', { name: 'Mark lost', exact: true })
    .or(header.getByRole('button', { name: 'More actions' }))
    .first()
    .click();
  const lost = page.getByRole('menuitem', { name: 'Mark lost', exact: true });
  if (await lost.isVisible()) await lost.click();
  const verb = page.getByRole('dialog', { name: 'Mark lost?' });
  await expect(verb).toBeVisible();
  expect(writes).toHaveLength(1);
  await verb.getByRole('button', { name: 'Cancel' }).click();
  await expect(verb).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test('the browser tab names the record, also where its name is edited in place', async ({ page }) => {
  const [account] = rows<{ id: number; name: string }>(CRM_DB, 'select id, name from account order by id limit 1');
  await page.goto(`${CRM}/accounts/${account.id}`);
  await expect(page.getByRole('heading', { level: 1, name: account.name })).toBeVisible();
  await expect(page).toHaveTitle(`${account.name} · Compass`);
  // A contact's page edits its name in place: its heading is the editor's, named by the record all the same.
  const [contact] = rows<{ id: number; name: string }>(CRM_DB, 'select id, name from contact order by id limit 1');
  await page.goto(`${CRM}/contacts/${contact.id}`);
  await expect(page.getByRole('heading', { level: 1, name: contact.name })).toBeVisible();
  await expect(page).toHaveTitle(`${contact.name} · Compass`);
});

test('mobile summaries and tables agree when a numeric fact is null', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/run(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.table === 'opportunity' && payload.rows?.length) payload.rows[0].amount = null;
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/opportunity`);
  const fact = page
    .locator('.record-summary')
    .first()
    .locator('dl > div')
    .filter({ has: page.locator('dt', { hasText: /^Amount$/ }) });
  await expect(fact.locator('dd')).toHaveText('—');
  await page.getByRole('group', { name: 'List presentation' }).getByRole('button', { name: 'Table', exact: true }).click();
  /* A 390px table keeps the columns it can hold and folds the rest under the row's name (Grid.tsx), Amount among
     them, and a folded line leaves an empty fact out: the null is said by its absence there, never as a zero. */
  const row = page.locator('.result-table table tbody tr').first();
  const folded = (name: RegExp) => row.locator('.cell-more-item').filter({ has: page.locator('.cell-more-head', { hasText: name }) });
  await expect(folded(/^Prob/)).toHaveCount(1);
  await expect(folded(/^Amount$/)).toHaveCount(0);
  await expect(row).not.toContainText('Amount $0');
});

test('related lists name references without changing their keys or child navigation', async ({ page }) => {
  await page.goto(`${CRM}/@suggested%3Acontact~6`);
  // App records now resolve to the authored page even through an old suggested
  // link. Its conversation list names the owner reference, not the account.
  const [expected] = rows<{ id: number; rep: string }>(
    CRM_DB,
    'SELECT a.id, r.name AS rep FROM activity a JOIN sales_rep r ON r.id = a.owner_id WHERE a.contact_id = 6 AND a.subject = ?',
    'Intro call',
  );
  const list = page.locator('.page-list table').first();
  const row = list.locator('tbody tr').filter({ hasText: 'Intro call' });
  const repIndex = await list
    .getByRole('columnheader', { name: 'Rep', exact: true })
    .evaluate((node) => (node as HTMLTableCellElement).cellIndex);
  await expect(row.locator('td').nth(repIndex).getByText(expected.rep, { exact: true })).toBeVisible();
  await expect(list.locator('thead')).not.toContainText('__tw_reference');
  await expect(list.locator('tbody tr')).toHaveCount(3);
  await list.getByText('Intro call', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Intro call');
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/activities/${expected.id}`);
});

test('suggested record pages name relationships by default', async ({ page }) => {
  await page.goto(`${CRM}/@suggested%3Acontact~6`);
  /* The default page is the record anatomy (pageAnatomy.ts): the contact's
     account is a fact in its header, the parent card being its owner's. */
  const account = page
    .getByRole('list', { name: 'Key facts' })
    .getByRole('listitem')
    .filter({ hasText: /^Account:/ });
  await expect(account.locator('.ref-jump-value')).not.toHaveText('6');
  await expect(account.locator('.ref-jump-table')).toHaveCount(0);
  const name = await account.locator('.ref-jump-value').innerText();
  expect(name.trim()).not.toBe('');
  await expect(account.locator('.ref-jump')).toHaveAttribute('data-ref-value', '6');
  await account.locator('.ref-jump').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
});

test('an explicit raw-id choice shows the key', async ({ page }) => {
  const responses = /\/api\/pages\/(?:suggested|plan|compose)(?:\?|$)/;
  await page.route(responses, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    /* A header says a reference by its name and takes no `names`; the choice
       is a fields section's, so the page is given one that says the account. */
    payload.page.sections.push({ kind: 'fields', title: 'Keys', paths: ['account_id'], names: false });
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/@suggested%3Acontact~6`);
  const account = page.locator('.page-field').filter({ has: page.locator('dt', { hasText: /^Account$/ }) });
  await expect(account.locator('.ref-jump-value')).toHaveText('6');
  await expect(account.locator('.ref-jump-table')).toHaveText('account');
});
