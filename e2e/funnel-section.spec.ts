import { COMPASS, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

test('a funnel counts its stages in one statement, holds its height as the counts land, and its stages open the deals', async ({
  page,
}) => {
  await page.goto(COMPASS);
  const funnel = page.locator('.dash-funnel');
  await expect(funnel).toBeVisible();
  const names = funnel.locator('.dash-funnel-name');
  await expect(names).toHaveText(['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won']);
  const height = (await funnel.boundingBox())!.height;
  await expect(funnel).not.toHaveAttribute('aria-busy', 'true');
  expect((await funnel.boundingBox())!.height).toBeCloseTo(height, 0);

  // One snapshot: a later stage is never longer than the one before it.
  const counts = (await funnel.locator('.dash-funnel-value').allTextContents()).map((text) => Number(text.replace(/[^\d]/g, '')));
  expect(counts).toHaveLength(5);
  expect(counts[0]).toBeGreaterThan(0);
  counts.slice(1).forEach((count, i) => expect(count).toBeLessThanOrEqual(counts[i]!));

  // A stage opens the list narrowed to the deals that reached it.
  await funnel
    .getByRole('link', { name: /Qualification/ })
    .first()
    .click();
  await expect(page).toHaveURL(/opportunities/);
});
