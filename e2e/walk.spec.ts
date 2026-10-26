/**
 * The walk: the one thing tablewalk does that a table browser does not.
 *
 * Open a table, click a row, and the page should tell you what points at that
 * row — with counts that match the database, rows you can click through to,
 * and a trail behind you that goes back the way you came. Every step of that
 * is rendering, and every step of it has been broken at some point: a row that
 * did not open, a Related panel stuck on "Counting…", a crumb that lost its
 * name the moment the row's label arrived.
 */
import { DEMO, DEMO_DB, expect, test, WIDE, WIDE_DB } from './support/ownServers';
import { count, scalar } from './support/db';
import { dataRows, open, trail, trailText } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test('a row opens the record it names', async ({ page }) => {
  await open(page, DEMO, 'customer');

  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();

  /* The heading is the table and the row's *label*, not its key. A record that
     says "customer · 4" is one where labelColumn has drifted — which it has,
     between the server's copy and the browser's, more than once. */
  await expect(page.getByRole('heading', { name: /customer · Dry Creek Vineyards/ })).toBeVisible();
});

test('the Related panel counts what points at the row', async ({ page }) => {
  const invoices = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice WHERE customer_id = 4');

  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();

  /* The count is in the tab's own name, so this asserts what a reader sees
     rather than an attribute nobody looks at. `via customer_id` matters too:
     a table can point at this one through more than one column, and a panel
     that collapsed them would still show a plausible number. */
  await expect(page.getByRole('tab', { name: `${invoices} invoice via customer_id` })).toBeVisible();

  // And the rows themselves are on the page, not behind another click.
  await expect(page.locator('.child-panel').getByRole('row')).toHaveCount(invoices + 1);
});

test('choosing a related table shows that table below', async ({ page }) => {
  /* On the sixty-six-table fixture, because it is the only one where a record
     has several non-empty relationships — which is the only case where
     choosing one is a choice at all. */
  const ticket = Number(
    scalar(
      WIDE_DB,
      `SELECT ticket_id FROM ticket_part GROUP BY ticket_id
        HAVING COUNT(*) BETWEEN 2 AND 9 ORDER BY ticket_id LIMIT 1`,
    ),
  );
  const parts = count(WIDE_DB, 'SELECT COUNT(*) FROM ticket_part WHERE ticket_id = ?', ticket);

  /* Straight to the record by link: a hash naming another database switches
     the connection first and parses the trail second, which is the only order
     that can work — a trail into another database names tables this one has
     never heard of. */
  await page.goto(`/${WIDE}/ticket/~${ticket}`);
  await expect(page.locator('#db-label')).toContainText(WIDE);

  await page.getByRole('tab', { name: `${parts} ticket_part via ticket_id` }).click();

  const panel = page.locator('.child-panel');
  await expect(panel.getByRole('heading', { name: 'ticket_part' })).toBeVisible();
  await expect(panel.getByRole('row')).toHaveCount(parts + 1);

  /* And the choice is in the link. "Look at its parts" is as worth sending
     on a record as it is on a page, and a link that always lands on whatever
     sorts first loses the point of sending it. */
  const shared = page.url();
  expect(decodeURIComponent(shared)).toMatch(/~\d+!/);
  await page.goto('about:blank');
  await page.goto(shared);
  await expect(page.locator('.child-panel').getByRole('heading', { name: 'ticket_part' })).toBeVisible();
});

test('a reference chip walks to the parent row', async ({ page }) => {
  await open(page, DEMO, 'invoice');
  await dataRows(page).filter({ hasText: '1004' }).click();

  const customer = Number(scalar(DEMO_DB, 'SELECT customer_id FROM invoice WHERE id = 1004'));
  const name = String(scalar(DEMO_DB, 'SELECT name FROM customer WHERE id = ?', customer));

  /* The chip shows the key and the table it points at. Clicking it is the
     forward walk — the direction the Related panel does not cover — and it
     used to be the one place a null-but-present reference produced a link to
     a row that was not there. */
  await page.getByRole('button', { name: `${customer} customer`, exact: true }).click();

  await expect(page.getByRole('heading', { name: `customer · ${name}` })).toBeVisible();
});

test('the trail grows with the walk, and every crumb goes back', async ({ page }) => {
  await open(page, DEMO, 'customer');
  /* The walk's steps, not the whole nav: the trail also carries a "Schema"
     crumb home, which is chrome rather than a step. */
  await expect.poll(() => trailText(page)).toEqual(['customer']);

  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();
  await expect(page.getByRole('heading', { name: /Dry Creek Vineyards/ })).toBeVisible();

  // Into a child row, which is a step onto a different table.
  await page.locator('.child-panel').getByRole('row').filter({ hasText: '1004' }).click();
  await expect(page.getByRole('heading', { name: /invoice · 1004/ })).toBeVisible();

  const steps = await trailText(page);
  expect(steps).toHaveLength(3);
  expect(steps[0]).toBe('customer');
  expect(steps[1]).toContain('Dry Creek Vineyards');
  /* The last crumb names the table as well as the row, because the walk
     changed table here. Without that the trail reads `customer › Dry Creek
     Vineyards › 1004` and nothing says 1004 is an invoice. */
  expect(steps[2]).toContain('invoice');
  expect(steps[2]).toContain('1004');

  // The middle crumb goes back to the record it names, and the trail shortens
  // rather than growing another step.
  await trail(page)
    .getByRole('button', { name: /Dry Creek Vineyards/ })
    .click();
  await expect(page.getByRole('heading', { name: /customer · Dry Creek Vineyards/ })).toBeVisible();
  expect(await trailText(page)).toHaveLength(2);

  // And the first crumb goes back to the table, filter and all.
  await trail(page).getByRole('button', { name: 'customer', exact: true }).click();
  await expect(dataRows(page)).toHaveCount(count(DEMO_DB, 'SELECT COUNT(*) FROM customer'));
  await expect.poll(() => trailText(page)).toEqual(['customer']);
});
