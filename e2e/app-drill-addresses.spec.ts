import { CRM, CRM_DB, CRM_TODAY, expect, type Page, test } from './support/ownServers';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'], viewport: { width: 1440, height: 924 } });

/**
 * A drill-in address keeps its view (a field report). A dashboard card's drill
 * walked in on its bare question drew every column of the table in key order,
 * and the address it wrote quoted a date column's window
 * (`created_on = 'last 30 days'`), which the column check refused, so the list
 * opened on an error and kept rewriting itself. Here a metric's drill, the
 * window typed as a parameter, and the same window asked as `q=` each open the
 * leads view: its columns, the rows the database says, and an address that
 * stays put once written.
 */
const WINDOW = 'last 30 days';
// `last 30 days` runs from thirty days before the server's day to the end of it (shared/queryDates.ts).
const inWindow = () =>
  Number(
    scalar(
      CRM_DB,
      "SELECT count(*) FROM lead WHERE created_on >= date(?, '-30 days') AND created_on < date(?, '+1 day')",
      CRM_TODAY,
      CRM_TODAY,
    ),
  );
// A column header's name is its options button's: `Company column options`.
const headers = (page: Page) =>
  page
    .locator('main button[aria-label$=" column options"]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')!.replace(/ column options$/, '')));
// The leads view's `show`, in its order (views.ts): a list drawn from the bare question had Email and Phone too.
const SHOWN = ['Name', 'Company', 'Status', 'Source', 'Owner', 'Created'];
const writes = (page: Page) => page.evaluate(() => (window as unknown as { addressWrites: number }).addressWrites);

test.beforeEach(async ({ context }) => {
  // Every address a page writes, counted: a list that keeps re-laying itself out keeps writing one.
  await context.addInitScript(() => {
    const counted = window as unknown as { addressWrites: number };
    counted.addressWrites = 0;
    for (const name of ['pushState', 'replaceState'] as const) {
      const write = history[name].bind(history);
      history[name] = (...args: Parameters<History['pushState']>) => {
        counted.addressWrites += 1;
        return write(...args);
      };
    }
  });
});

/** The leads view as it should stand: its columns, the window's rows, no error, and nothing moving after. */
async function standsAsTheView(page: Page) {
  const main = page.locator('main');
  await expect(page.locator('.applist-count')).toHaveText(inWindow().toLocaleString());
  await expect(main.getByText('Fix the query above to see results.')).toHaveCount(0);
  await expect.poll(() => headers(page)).toEqual(SHOWN);
  const before = { address: page.url(), headers: await headers(page), writes: await writes(page) };
  await page.waitForTimeout(1500);
  expect({ address: page.url(), headers: await headers(page), writes: await writes(page) }).toEqual(before);
  const search = new URL(page.url()).searchParams;
  expect(search.get('created_on')).toBe(WINDOW);
  expect(search.has('q')).toBe(false);
}

test("a metric's drill opens the view's list over its window", async ({ page }) => {
  await page.goto(`${CRM}/sales-dashboard`);
  await page.locator('main button.home-card', { hasText: 'New leads' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/leads');
  await standsAsTheView(page);
});

test('a date window typed as a parameter reads back as the window', async ({ page }) => {
  await page.goto(`${CRM}/leads?tab=all&${new URLSearchParams({ created_on: WINDOW })}`);
  await standsAsTheView(page);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('all');
});

test('the window asked as q= is said as the parameter and opens the same list', async ({ page }) => {
  await page.goto(`${CRM}/leads?tab=all&${new URLSearchParams({ q: `created_on = ${WINDOW}` })}`);
  await expect.poll(() => new URL(page.url()).searchParams.get('created_on')).toBe(WINDOW);
  await standsAsTheView(page);
  // The address it was rewritten to is one a reader can open: opened in another tab, as a shared link is (this tab
  // would restore its own walk rather than read the address), it reads back as the same list.
  const shared = await page.context().newPage();
  await shared.goto(page.url());
  await standsAsTheView(shared);
});
