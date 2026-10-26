/** A resident's charges are one list read as groups: a header for each lease, its charges under it. */
import { expect, fitsTheWidth, open, signIn, test } from './browser.ts';

test('a resident’s charges are grouped under the lease each belongs to', async ({ page, lintel }) => {
  const [household] = lintel.rows<{ id: number; leases: number }>(
    `SELECT l.resident_id AS id, COUNT(DISTINCT c.lease_id) AS leases FROM charge c JOIN lease l ON l.id = c.lease_id
      GROUP BY l.resident_id ORDER BY leases DESC, l.resident_id LIMIT 1`,
  );
  expect(household, 'the seed leaves a household with charges').toBeTruthy();
  await signIn(page, lintel, 'manager');
  await open(page, lintel, `/residents/${household.id}`);
  const charges = page.locator('[role="group"][aria-labelledby]').filter({ has: page.getByRole('heading', { level: 3 }) });
  await expect(charges.first()).toBeVisible();
  // One header for each lease, as many as the page of groups holds.
  expect(await charges.count()).toBe(Math.min(household.leases, 3));
  await fitsTheWidth(page);
});
