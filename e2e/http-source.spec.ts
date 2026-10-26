import { expect, test } from './support/harness';
import { DESK_TOKEN, startHttpSource } from './support/httpSourceServer';
import { BIG_ID } from '../test/support/fakeRest.js';

/* An API browsed like a database, asserted on both ends: what the page shows,
   and — the fake keeps every request — what tablewalk asked the API for. */
test.describe('an HTTP connection in the explorer', () => {
  let source: Awaited<ReturnType<typeof startHttpSource>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    source = await startHttpSource();
  });
  test.afterAll(async () => {
    await source?.stop();
  });
  test.beforeEach(async ({ page }) => {
    // Its own origin, so the tour the shared fixtures mark as seen would open here.
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
  });
  const last = () => source.api.seen.at(-1)!;

  test('a list pages without a total and offers only the filters the API documents', async ({ page }) => {
    await page.goto(`${source.origin}/desk/contacts`);
    await expect(page.getByText('20 rows shown')).toBeVisible();
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter by status' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Filter by tag' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter by created_at' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Only vip' })).toHaveCount(0);
    // A column header offers Filter on … only where the API documents a filter.
    await expect(page.getByRole('button', { name: 'Filter on status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter on name' })).toHaveCount(0);
    expect(last().headers.authorization).toBe(`Bearer ${DESK_TOKEN}`);
    expect(await page.content()).not.toContain(DESK_TOKEN);

    await page.getByRole('button', { name: 'Next page' }).click();
    // No total to say "of 25": the page says which rows it holds, and a short page is the last.
    await expect(page.getByText('rows 21–25 shown')).toBeVisible();
    expect(last().query.get('offset')).toBe('20');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  test('a box asks the API for a whole value, and a filter it cannot take says what it can', async ({ page }) => {
    await page.goto(`${source.origin}/desk/contacts`);
    await page.getByRole('textbox', { name: 'Filter by tag' }).fill('retail');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.getByText('13 rows shown')).toBeVisible();
    expect(last().query.get('tag')).toBe('retail');

    const asked = source.api.seen.length;
    await page.getByRole('combobox', { name: 'Query' }).fill('contacts name contains Con');
    await page.getByRole('combobox', { name: 'Query' }).press('Enter');
    await expect(page.getByText('It can filter by status =, tag =.')).toBeVisible();
    expect(source.api.seen.length, 'a refused filter never reaches the API').toBe(asked);
  });

  test('a record is read from its item path, and an id past 2^53 keeps every digit', async ({ page }) => {
    await page.goto(`${source.origin}/desk/contacts/~c-03`);
    // A field only the record draws: the list shows no emails, and a failed read shows none.
    await expect(page.getByText('contact3@example.test')).toBeVisible();
    await expect(page.getByText(/cannot run views/)).toHaveCount(0);
    expect(source.api.seen.some((request) => request.path === '/v1/contacts/c-03')).toBe(true);

    await page.goto(`${source.origin}/desk/tickets`);
    await expect(page.getByText('7 rows shown')).toBeVisible();
    // Grouped as a figure, as the grid draws a database's big ids, with no digit rounded away.
    await expect(page.getByRole('gridcell', { name: BigInt(BIG_ID).toLocaleString('en-US') })).toBeVisible();
  });

  test('the API tab sends a documented read and shows exactly what was sent', async ({ page }) => {
    await page.goto(`${source.origin}/desk/contacts!api`);
    const form = page.getByRole('form', { name: 'Try the contacts API' });
    await expect(form).toBeVisible();
    // The form is the description's: a vocabulary is a choice, anything else is typed.
    const status = form.getByLabel('status', { exact: true });
    if ((await status.evaluate((node) => node.tagName)) === 'SELECT') await status.selectOption('lead');
    else await status.fill('lead');
    await form.getByRole('button', { name: 'Send' }).click();
    const answer = page.getByRole('region', { name: "The API's answer" });
    await expect(answer.locator('.api-request code')).toContainText('GET /contacts?');
    await expect(answer.locator('.api-request code')).toContainText('status=lead');
    await expect(answer).toContainText('Contact 1');
    expect(last().query.get('status')).toBe('lead');
    expect(await page.content()).not.toContain(DESK_TOKEN);
    // The same question as a table: the list the API filters.
    await page.getByRole('button', { name: 'Open as table' }).click();
    await expect(page.getByText('9 rows shown')).toBeVisible();
  });
});
