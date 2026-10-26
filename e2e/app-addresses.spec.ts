import { CRM, CRM_DB, expect, type Page, test } from './support/ownServers';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * An App's addresses are canonical, one per thing it shows. A list as it
 * opens is its view's key, a tab and what the reader narrowed to are
 * parameters, the sort is `sort=`, and only a question those cannot say is
 * `q=` its text. A record is its id under the view that shows its table, so
 * following a reference opens the target's own address while Back and the
 * crumbs retrace the walk (history state). The New form, a record's tab and a
 * dashboard's window have words of their own; a natural key and a public
 * slug are opt-in. Each address reads back into the same room — the tab lit,
 * the rows the database says — and one written the older way still opens
 * and is rewritten.
 */
const address = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const lit = (page: Page) => page.locator('.tabs [role="tab"][aria-selected="true"]');
const count = (page: Page) => page.locator('.applist-count');
const many = (n: unknown) => Number(n).toLocaleString();

test.describe('Thread addresses', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('a view as it opens is its key; a tab, a filter and a question the boxes cannot say read back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Issues/ })
      .click();
    await expect(lit(page)).toHaveText(/^Active/);
    await expect.poll(() => address(page)).toBe('/issues');

    await page.getByRole('tab', { name: /^Backlog/ }).click();
    await expect.poll(() => address(page)).toBe('/issues?tab=backlog_issues');
    const backlog = scalar(sample.db, "SELECT count(*) FROM issue WHERE status = 'backlog'");
    await expect(count(page)).toHaveText(many(backlog));
    await page.reload();
    await expect(lit(page)).toHaveText(/^Backlog/);
    await expect(count(page)).toHaveText(many(backlog));

    // A tab and a box, typed by hand: the tab lit, the rows both say, and the address as it came.
    await page.goto(`${sample.origin}/issues?tab=done_issues&priority=high`);
    await expect(lit(page)).toHaveText(/^Done/);
    await expect(count(page)).toHaveText(many(scalar(sample.db, "SELECT count(*) FROM issue WHERE status = 'done' AND priority = 'high'")));
    expect(address(page)).toBe('/issues?tab=done_issues&priority=high');

    // An `or` across two columns is no box's to say: the question whole, and read back whole.
    const question = 'status = done or priority = urgent';
    await page.goto(`${sample.origin}/issues?${new URLSearchParams({ q: question })}`);
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, "SELECT count(*) FROM issue WHERE status = 'done' OR priority = 'urgent'")),
    );
    expect(new URL(page.url()).searchParams.get('q')).toBe(question);
  });

  test('a filter opened by its parameter draws its chip, and one set in the bar is said as one', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/issues?priority=high`);
    await expect(lit(page)).toHaveText(/^Active/);
    const chip = page.locator('.applist-chip', { hasText: 'Priority is High' });
    await expect(chip).toBeVisible();
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, "SELECT count(*) FROM issue WHERE status NOT IN ('done', 'canceled') AND priority = 'high'")),
    );
    // Its picker reads the parameter back ticked; a second tick is said as one of several.
    await chip.locator('.applist-chip-open').click();
    const picker = page.getByRole('dialog', { name: 'Filter by Priority' });
    await expect(picker.locator('input[data-value="high"]')).toBeChecked();
    await picker.locator('input[data-value="low"]').check();
    await picker.getByRole('button', { name: /^Show/ }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('priority')).toBe('high,low');
    await page.reload();
    const both = page.locator('.applist-chip', { hasText: 'Priority is High or Low' });
    await expect(both).toBeVisible();
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, "SELECT count(*) FROM issue WHERE status NOT IN ('done', 'canceled') AND priority IN ('high', 'low')")),
    );
    await both.getByRole('button', { name: /^Remove/ }).click();
    await expect.poll(() => address(page)).toBe('/issues');
  });

  test('a label is its name: a natural key opens, a primary key is rewritten to it, and an unknown one is not found', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    const [first, second] = ['SELECT name FROM label WHERE id = 1', 'SELECT name FROM label WHERE id = 2'].map((sql) =>
      String(scalar(sample.db, sql)),
    );
    await page.goto(`${sample.origin}/label/${encodeURIComponent(first)}`);
    await expect(page.locator('.crumbs')).toContainText(first);
    expect(address(page)).toBe(`/label/${encodeURIComponent(first)}`);
    // Its primary key, named, opens the same kind of record and is said by its name once read.
    await page.goto(`${sample.origin}/label/id=2`);
    await expect.poll(() => address(page)).toBe(`/label/${encodeURIComponent(second)}`);
    await expect(page.locator('.crumbs')).toContainText(second);
    await page.goto(`${sample.origin}/label/no-such-label`);
    await expect(page.getByText('No label is addressed "no-such-label".')).toBeVisible();
  });

  test('an address written the old way opens and reads as its key, and Back and Forward walk the words', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    // As the walk wrote a list before: the view's key, then its question — the Board's own, which names its segment.
    const old = 'board:issue%20current_cycle';
    await page.goto(`${sample.origin}/${old}`);
    await expect(page.getByRole('group', { name: 'Board', exact: true }).locator('section.triage-lane').first()).toBeVisible();
    await expect.poll(() => address(page)).toBe('/board');

    await page.goto(`${sample.origin}/inbox`);
    await expect(page.locator('.applist-title')).toHaveText('Inbox');
    // The list reads newest first, so its newest issue is on the first page.
    const id = Number(scalar(sample.db, 'SELECT max(id) FROM issue'));
    const name = String(scalar(sample.db, 'SELECT name FROM issue WHERE id = ?', id));
    await page.locator('.queue-pick').filter({ hasText: name }).first().click();
    await expect.poll(() => address(page)).toBe(`/inbox/${id}`);
    await page.goBack();
    await expect.poll(() => address(page)).toBe('/inbox');
    await expect(page.getByRole('complementary', { name: 'Inbox details' })).toHaveCount(0);
    await page.goForward();
    await expect.poll(() => address(page)).toBe(`/inbox/${id}`);
    await expect(page.getByRole('complementary', { name: 'Inbox details' })).toContainText(name);
  });
});

test("Compass: the tab a view opens on is its key, another tab its word, and the reader's own sort is said", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 924 });
  const byStatus = (status: string) => scalar(CRM_DB, 'SELECT count(*) FROM lead WHERE status = ?', status);
  await page.goto(`${CRM}/leads`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(lit(page)).toHaveText(/^New/);
  await expect(count(page)).toHaveText(many(byStatus('new')));
  expect(address(page)).toBe('/leads');

  // Every Compass tab sorts; its own sort goes unsaid.
  await page.getByRole('tab', { name: /^Working/ }).click();
  await expect.poll(() => address(page)).toBe('/leads?tab=working');
  await expect(count(page)).toHaveText(many(byStatus('working')));
  await page.reload();
  await expect(lit(page)).toHaveText(/^Working/);

  /* The All tab's rows in the reader's own order. The tab strip lights a tab
     only for its whole question, its sort included, so none is lit here — as
     when the Sort menu picks another order — while the address names both. */
  await page.goto(`${CRM}/leads?tab=all&sort=name`);
  await expect(count(page)).toHaveText(many(scalar(CRM_DB, 'SELECT count(*) FROM lead')));
  expect(address(page)).toBe('/leads?tab=all&sort=name');
});

test.describe('Compass: one address per record', () => {
  const lead = { id: Number(scalar(CRM_DB, 'SELECT id FROM lead WHERE owner_id IS NOT NULL ORDER BY id DESC LIMIT 1')) };
  const owner = Number(scalar(CRM_DB, 'SELECT owner_id FROM lead WHERE id = ?', lead.id));
  const name = String(scalar(CRM_DB, 'SELECT name FROM lead WHERE id = ?', lead.id));
  const crumbs = (page: Page) => page.locator('.crumbs');

  test('a reference opens its own address, and Back and the crumbs retrace the walk', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${CRM}/leads/${lead.id}`);
    await expect(crumbs(page)).toContainText(name);
    await expect(crumbs(page)).toContainText('Leads');
    // The owner is a sales rep, addressed under the view that lists them — not a path that grows.
    await page.locator('main .ref-jump').first().click();
    await expect.poll(() => address(page)).toBe(`/sales-team/${owner}`);
    await expect(crumbs(page)).toContainText(name);
    // The walk is history state: a reload keeps the crumbs, a shared link is the rep alone.
    await page.reload();
    await expect(crumbs(page)).toContainText(name);
    await page.goBack();
    await expect.poll(() => address(page)).toBe(`/leads/${lead.id}`);
    await expect(crumbs(page)).toContainText(name);
  });

  test('the trail an older link wrote in its path opens, and is said as the last record alone', async ({ page }) => {
    await page.goto(`${CRM}/leads/@lead~${lead.id}/@sales_rep~${owner}`);
    await expect.poll(() => address(page)).toBe(`/sales-team/${owner}`);
    await expect(crumbs(page)).toContainText('Leads');
    await page.goto(`${CRM}/@lead~${lead.id}`);
    await expect.poll(() => address(page)).toBe(`/leads/${lead.id}`);
  });

  test('the New form, a record tab and the search have addresses of their own', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${CRM}/leads/new`);
    await expect(page.getByRole('dialog', { name: 'New lead' })).toBeVisible();
    await page.getByRole('dialog', { name: 'New lead' }).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => address(page)).toBe('/leads');
    await page.getByRole('button', { name: '+ New lead' }).click();
    await expect.poll(() => address(page)).toBe('/leads/new');
    await page.getByRole('dialog', { name: 'New lead' }).getByRole('button', { name: 'Cancel' }).click();

    const account = Number(
      scalar(CRM_DB, 'SELECT account_id FROM opportunity GROUP BY account_id ORDER BY count(*) DESC, account_id LIMIT 1'),
    );
    await page.goto(`${CRM}/accounts/${account}`);
    await page.getByRole('tab', { name: /^Opportunities/ }).click();
    await expect.poll(() => address(page)).toBe(`/accounts/${account}/opportunities`);
    await page.reload();
    await expect(page.getByRole('tab', { name: /^Opportunities/ })).toHaveAttribute('aria-selected', 'true');

    const fragment = name.split(' ')[0];
    await page.goto(`${CRM}/leads?tab=all&search=${encodeURIComponent(fragment)}`);
    await expect(count(page)).toHaveText(many(scalar(CRM_DB, "SELECT count(*) FROM lead WHERE name LIKE '%' || ? || '%'", fragment)));
    expect(address(page)).toBe(`/leads?tab=all&search=${encodeURIComponent(fragment)}`);
  });

  test("a dashboard is its key and its window a parameter; a drill is the target list's own words", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${CRM}/@dash-sales-dashboard~last-30-days`);
    await expect.poll(() => address(page)).toBe('/sales-dashboard?period=last-30-days');
    await page.goto(`${CRM}/sales-dashboard`);
    // Compass shows its windows as one date-range button: the menu holds the choices.
    await page.getByRole('button', { name: /^Time window:/ }).click();
    await page.getByRole('menuitem', { name: 'Last 30 days' }).click();
    await expect.poll(() => address(page)).toBe('/sales-dashboard?period=last-30-days');
    // Leads by source: the drill is the leads list's own filters, no query text.
    await page.locator('main .chart-legend-drill').first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/leads');
    const drilled = new URL(page.url()).searchParams;
    expect(drilled.get('created_on')).toBe('last 30 days');
    expect(drilled.get('source')).toBeTruthy();
    expect(drilled.has('q')).toBe(false);
    await page.goBack();
    await expect.poll(() => address(page)).toBe('/sales-dashboard?period=last-30-days');
  });
});

test.describe('Forecourt: a public record carries its name', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  // The seed draws the studio photos before the server starts.
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('forecourt');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('any spelling of a car is answered with its own, a real title and a canonical link', async ({ page }) => {
    const title = String(scalar(sample.db, 'SELECT title FROM vehicle WHERE id = 1'));
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const canonical = `/vehicles/1-${slug}`;
    // The server: a 301 to the current spelling, then the page naming itself.
    for (const spelling of ['/vehicles/1', '/vehicles/1-an-old-name']) {
      const moved = await page.request.get(`${sample.origin}${spelling}`, { maxRedirects: 0 });
      expect(moved.status()).toBe(301);
      expect(new URL(moved.headers().location, sample.origin).pathname).toBe(canonical);
    }
    const shell = await (await page.request.get(`${sample.origin}${canonical}`, { maxRedirects: 0 })).text();
    expect(shell).toContain(`<title>${title} · Forecourt</title>`);
    expect(shell).toContain(`<link rel="canonical" href="${canonical}">`);
    // The browser: a card opens the same spelling, and says it as the canonical link.
    await page.goto(`${sample.origin}/vehicles/1-an-old-name`);
    await expect.poll(() => address(page)).toBe(canonical);
    await expect(page).toHaveTitle(`${title} · Forecourt`);
    await expect
      .poll(() =>
        page.evaluate(() => new URL(document.querySelector('link[rel="canonical"]')!.getAttribute('href')!, location.href).pathname),
      )
      .toBe(canonical);
  });
});
