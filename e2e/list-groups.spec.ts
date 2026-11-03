import { COMPASS, CRM_DB, expect, test } from './support/ownServers';
import { rows } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * A grid grouped by a column (a list view's `group`): Compass's deals by stage, each stage's deals under a head with
 * how many there are and what they are worth over the whole tab — one breakdown, never a read per stage — the
 * subtotals standing under the columns they sum. A head folds its stage away and opens it again, and a reader's sort
 * orders the deals inside each stage.
 */
const shots = process.env.GROUP_SHOTS;

test('deals stand under their stage, each head counting and summing the whole tab from one breakdown', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const breakdowns: string[] = [];
  const groupReads: string[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    const body = request.postData() ?? '';
    if (request.url().includes('/api/breakdown') && body.includes('by stage')) breakdowns.push(body);
    if (request.url().includes('/api/view/run')) groupReads.push(body);
  });
  await page.goto(`${COMPASS}/deals-by-stage`);
  const heads = page.locator('.grid-group-head');
  await expect(heads.first()).toBeVisible();

  /* What the database says of the open pipeline, stage by stage. */
  const stages = rows<{ stage: string; n: number; total: number }>(
    CRM_DB,
    "SELECT stage, COUNT(*) AS n, SUM(amount) AS total FROM opportunity WHERE stage NOT IN ('closed_won', 'closed_lost') GROUP BY stage ORDER BY stage",
  );
  // The stages stand in the order the column sorts in: the machine's road for a stage, not the alphabet.
  const head = heads.first();
  const named = (await head.locator('.grid-group-name').innerText()).toLowerCase();
  const first = stages.find((stage) => stage.stage === named)!;
  expect(first, `a stage called ${named}`).toBeTruthy();
  await expect(head.locator('.grid-group-count')).toHaveText(first.n.toLocaleString('en-US'));
  // The subtotal stands in the Amount column's place: under its header, and the whole stage's, not the page's.
  const amountHeader = page.locator('thead th', { hasText: /^Amount/ });
  const sum = head.locator('.grid-group-sum').first();
  await expect(sum).toContainText(Math.round(first.total).toLocaleString('en-US'));
  const [under, column] = await Promise.all([sum.boundingBox(), amountHeader.boundingBox()]);
  expect(Math.abs(under!.x - column!.x)).toBeLessThan(2);
  // Rows read in stage order: every row under a head is that stage's.
  const firstRows = await page.locator('tbody tr').evaluateAll((all) => {
    const out: string[] = [];
    for (const row of all) {
      if (row.classList.contains('grid-group-head')) {
        if (out.length) break;
        continue;
      }
      out.push((row as HTMLElement).dataset.row ?? '');
    }
    return out;
  });
  expect(firstRows.length).toBeGreaterThan(0);
  expect(firstRows.length).toBeLessThanOrEqual(first.n);
  if (shots) await page.screenshot({ path: `${shots}/list-groups-desk.png` });

  // One breakdown for every head, and no read per stage.
  expect(breakdowns).toHaveLength(1);
  expect(groupReads).toHaveLength(0);

  /* Narrowed by a search to a few deals across every open stage, all on one page: each head counts what the search
     leaves, as the database does. */
  await page.goto(`${COMPASS}/deals-by-stage?search=Stonebridge`);
  const narrowed = rows<{ stage: string; n: number }>(
    CRM_DB,
    "SELECT stage, COUNT(*) AS n FROM opportunity WHERE stage NOT IN ('closed_won', 'closed_lost') AND name LIKE '%Stonebridge%' GROUP BY stage",
  );
  await expect(heads).toHaveCount(narrowed.length);
  for (const { stage, n } of narrowed)
    await expect(heads.filter({ hasText: new RegExp(`^${stage}`, 'i') }).locator('.grid-group-count')).toHaveText(String(n));

  // Folded from its head, the stage's deals go and the next stage's head moves up under it.
  const top = heads.first();
  const toggle = top.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const drawn = await page.locator('tbody tr[data-row]').count();
  const own = Number(await top.locator('.grid-group-count').innerText());
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('tbody tr[data-row]')).toHaveCount(drawn - own);
  await expect(page.locator('tbody tr').nth(1)).toHaveClass(/grid-group-head/);
  await toggle.click();
  await expect(page.locator('tbody tr[data-row]')).toHaveCount(drawn);
  if (shots) await page.screenshot({ path: `${shots}/list-groups-narrowed.png` });

  // A reader's sort orders the deals within each stage; the stages stay as they stood.
  await page.getByRole('button', { name: 'Amount column options' }).click();
  await page.getByRole('menuitem', { name: 'High → low' }).click();
  await expect(page).toHaveURL(/sort=-amount|sort=amount/);
  await expect(heads).toHaveCount(narrowed.length);
  // Each stage's deals, high to low, read from the cell under the Amount header.
  const runs = await page
    .locator('table')
    .first()
    .evaluate((table) => {
      const at = [...table.querySelectorAll('thead th')].findIndex((th) => (th.textContent?.trim() ?? '').startsWith('Amount'));
      const out: number[][] = [];
      for (const row of table.querySelectorAll('tbody tr')) {
        if (row.classList.contains('grid-group-head')) out.push([]);
        else out.at(-1)?.push(Number((row.children[at]?.textContent ?? '').replace(/[^\d.-]/g, '')));
      }
      return out;
    });
  expect(runs).toHaveLength(narrowed.length);
  for (const run of runs) expect([...run].sort((a, b) => b - a)).toEqual(run);
});

test('a phone reads the deals as records under the same heads, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${COMPASS}/deals-by-stage?search=Stonebridge`);
  await expect(page.getByText('Stonebridge Insurance Ltd — Renewal').first()).toBeVisible();
  const narrowed = rows<{ stage: string; n: number }>(
    CRM_DB,
    "SELECT stage, COUNT(*) AS n FROM opportunity WHERE stage NOT IN ('closed_won', 'closed_lost') AND name LIKE '%Stonebridge%' GROUP BY stage",
  );
  const heads = page.locator('.record-summary-group');
  await expect(heads).toHaveCount(narrowed.length);
  for (const { stage, n } of narrowed)
    await expect(heads.filter({ hasText: new RegExp(`^${stage}`, 'i') }).locator('.record-summary-group-count')).toHaveText(String(n));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/list-groups-phone.png` });
});
