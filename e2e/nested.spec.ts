/**
 * A row's children, opened in place.
 *
 * The point of the feature is the thing it refuses to do: it must not multiply
 * the row. A LEFT JOIN onto a has-many turns one customer with three invoices
 * into three customers, and every other number on the row becomes a lie. So
 * the children go in a sibling row underneath, and the assertion that matters
 * is that the grid still has exactly as many data rows as the table has.
 *
 * The counts come from the database, because a detail panel that says "3" when
 * the answer is 4 is the only failure mode worth catching here, and a number
 * pasted from a screenshot cannot catch it.
 */
import { DEMO, DEMO_DB, expect, test } from './support/ownServers';
import { count, scalar } from './support/db';
import { dataRows, open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/** The customer with the most invoices, so "some children" is not a fluke. */
const busiest = Number(scalar(DEMO_DB, 'SELECT customer_id FROM invoice GROUP BY customer_id ORDER BY COUNT(*) DESC, customer_id LIMIT 1'));
const name = String(scalar(DEMO_DB, 'SELECT name FROM customer WHERE id = ?', busiest));
const invoices = count(DEMO_DB, 'SELECT COUNT(*) FROM invoice WHERE customer_id = ?', busiest);
const customers = count(DEMO_DB, 'SELECT COUNT(*) FROM customer');

test('expanding a row shows its children, counted as the database counts them', async ({ page }) => {
  await open(page, DEMO, 'customer');
  await expect(dataRows(page)).toHaveCount(customers);

  const row = dataRows(page).filter({ hasText: name });
  await row.getByRole('button', { name: 'Show what points at this row' }).click();

  const detail = page.locator('tr.detail-row');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'invoice' })).toBeVisible();
  await expect(detail.locator('.detail-count')).toHaveText(String(invoices));
  // The rows themselves, not just the count: a section can be right about how
  // many there are and show somebody else's.
  await expect(detail.getByRole('row')).toHaveCount(invoices + 1);

  /* And the parent is still one row. This is the whole reason the children
     live in a sibling `<tr>` rather than in a join. */
  await expect(dataRows(page)).toHaveCount(customers);
});

test('collapsing takes the children away again', async ({ page }) => {
  await open(page, DEMO, 'customer');
  const row = dataRows(page).filter({ hasText: name });
  const expander = row.getByRole('button', { name: 'Show what points at this row' });

  await expander.click();
  await expect(page.locator('tr.detail-row')).toBeVisible();
  await expect(expander).toHaveAttribute('aria-expanded', 'true');

  await expander.click();
  await expect(page.locator('tr.detail-row')).toHaveCount(0);
  /* The state left behind matters as much as the row: a stale `aria-expanded`
     tells a screen reader the panel is still open after it has gone. */
  await expect(expander).toHaveAttribute('aria-expanded', 'false');
});

test('expanding a row does not also walk away from the table', async ({ page }) => {
  /* The row navigates and the triangle expands, and they sit inside each
     other. Without stopPropagation, opening the detail also opens the record —
     so the panel you asked for is drawn on a page you are already leaving. */
  await open(page, DEMO, 'customer');
  const url = page.url();

  await dataRows(page).filter({ hasText: name }).getByRole('button', { name: 'Show what points at this row' }).click();

  await expect(page.locator('tr.detail-row')).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.getByRole('heading', { name: /customer · / })).toHaveCount(0);
});
