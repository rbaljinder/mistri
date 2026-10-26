import { expect, test, type Page } from './support/harness';
import { DEPOT_ADMIN, startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * Row-driven flows (preview), in Depot: a purchase order drafted over
 * $5,000 starts the seeded Large order approval flow (po_flow and its
 * steps), which asks a manager, waits for the word, and sends the order.
 * The order's page shows the run waiting, the manager's Approve gives the
 * word, and the run sends the order and completes. Its own server with
 * `--jobs`, over a copy of the seed: the parallel lane.
 */
test.describe('Flows', () => {
  test.setTimeout(150_000);

  const signIn = async (page: Page, origin: string) => {
    const login = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: DEPOT_ADMIN });
    expect(login.ok()).toBe(true);
  };

  test('an order over $5,000 waits for approval on its page, and Approve sends it', async ({ page }) => {
    const sample = await startSample('depot', { jobs: true });
    try {
      await signIn(page, sample.origin);
      // A step row is judged as it is written: a kind the order does not offer, or a condition over a rollup, is refused.
      const steps = Number(scalar(sample.db, 'SELECT count(*) FROM po_flow_step'));
      for (const [values, said] of [
        [{ flow_id: 1, position: 4, kind: 'teleport' }, 'Choose one of the step kinds this App offers.'],
        [{ flow_id: 1, position: 5, kind: 'branch', condition: 'total > 5' }, 'Write a condition in the query language about this record'],
      ] as const) {
        const refused = await page.request.post(`${sample.origin}/api/insert`, {
          headers: { origin: sample.origin },
          data: { app: 'depot', table: 'po_flow_step', values },
        });
        const answer = await refused.json();
        expect(answer.outcome, JSON.stringify(answer)).toBe('rejected');
        expect(JSON.stringify(answer.errors)).toContain(said);
      }
      expect(Number(scalar(sample.db, 'SELECT count(*) FROM po_flow_step'))).toBe(steps);
      // An active product and its supplier: enough of it to pass the flow's condition (draft_value > 5000).
      const product = Number(scalar(sample.db, "SELECT id FROM product WHERE status = 'active' AND unit_cost > 0 ORDER BY id LIMIT 1"));
      const supplier = Number(scalar(sample.db, 'SELECT supplier_id FROM product WHERE id = ?', product));
      const cost = Number(scalar(sample.db, 'SELECT unit_cost FROM product WHERE id = ?', product));
      const quantity = Math.ceil(5_001 / cost) + 1;
      const drafted = await page.request.post(`${sample.origin}/api/commands/execute?app=depot`, {
        headers: { origin: sample.origin },
        data: {
          command: 'draftPurchaseOrder',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: `flows-e2e-draft-${Date.now()}`,
          input: { supplier: String(supplier), warehouse: '1', lines: [{ product: String(product), quantity }] },
        },
      });
      expect(drafted.ok(), await drafted.text()).toBe(true);
      const po = Number(scalar(sample.db, 'SELECT max(id) FROM purchase_order'));
      expect(Number(scalar(sample.db, 'SELECT draft_value FROM purchase_order WHERE id = ?', po))).toBeGreaterThan(5_000);

      // The flow's first step asked, through requestApproval, as the runner's principal.
      await expect
        .poll(() => scalar(sample.db, 'SELECT approval FROM purchase_order WHERE id = ?', po), { timeout: 30_000 })
        .toBe('requested');
      await page.goto(`${sample.origin}/purchase-orders/~${po}`);
      const flows = page
        .locator('section, div')
        .filter({ has: page.getByRole('heading', { name: 'Flows', exact: true }) })
        .last();
      await expect(flows.getByText('Large order approval').first()).toBeVisible();
      await expect(flows.getByText(/Waiting for po\.decided/).first()).toBeVisible();
      await expect(flows.getByText(/Ask a manager to approve/).first()).toBeVisible();

      // The manager's word: the action the order offers while it waits, which records po.decided.
      // Approve asks nothing, so it runs on one click with no dialog (df773272).
      await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
      await expect(page.getByRole('dialog', { name: 'Approve' })).toHaveCount(0);
      await expect.poll(() => scalar(sample.db, 'SELECT status FROM purchase_order WHERE id = ?', po), { timeout: 30_000 }).toBe('sent');
      expect(scalar(sample.db, 'SELECT approval FROM purchase_order WHERE id = ?', po)).toBe('approved');

      await page.reload();
      await expect(flows.getByText('Completed').first()).toBeVisible({ timeout: 15_000 });
      await expect(flows.getByText(/Send to the supplier/).first()).toBeVisible();
    } finally {
      await sample.stop();
    }
  });
});
