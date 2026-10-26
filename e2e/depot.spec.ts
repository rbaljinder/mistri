import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './support/harness';
import { DEPOT_ADMIN, startSample } from './support/sampleServer';
import { count, rows, scalar } from './support/db';

/* Depot's journeys, each over its own fresh seed: receiving a purchase-order
   line moves the bin, the ledger, the line and the order together; a pick
   list the warehouse cannot fill is refused whole; an operator is not a
   buyer, on the page or at the server; and Low stock lists exactly the SKUs
   under their reorder point; Today's feed says a change made now, its chart
   picks its own period and its open orders select in place. Expected values
   are read from the fixture. */
test.describe('Depot inventory operations', () => {
  test.setTimeout(120_000);

  const signIn = async (page: Page, origin: string, account = DEPOT_ADMIN) => {
    const login = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: account });
    expect(login.ok()).toBe(true);
  };

  test('receiving a purchase-order line fills its bin, writes the ledger and advances the order', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      // A sent order to Reno with more than one open line: receiving one leaves it partly received.
      const line = Number(
        scalar(
          sample.db,
          `SELECT l.id FROM po_line l JOIN purchase_order o ON o.id = l.purchase_order_id
        WHERE o.status = 'sent' AND o.warehouse_id = 1 AND l.status = 'open'
          AND (SELECT count(*) FROM po_line x WHERE x.purchase_order_id = o.id AND x.status = 'open') > 1 ORDER BY l.id LIMIT 1`,
        ),
      );
      const po = Number(scalar(sample.db, 'SELECT purchase_order_id FROM po_line WHERE id = ?', line));
      const product = Number(scalar(sample.db, 'SELECT product_id FROM po_line WHERE id = ?', line));
      const open = Number(scalar(sample.db, 'SELECT open_qty FROM po_line WHERE id = ?', line));
      const bin = Number(scalar(sample.db, 'SELECT home_bin_id FROM product WHERE id = ?', product));
      const before = Number(
        scalar(sample.db, 'SELECT coalesce(sum(qty), 0) FROM stock_level WHERE product_id = ? AND bin_id = ?', product, bin),
      );
      const ledger = count(sample.db, 'SELECT count(*) FROM stock_movement');

      await page.goto(`${sample.origin}/receiving/~${line}`);
      await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Receive' });
      // Prepared from the line: everything still open, into the SKU's home bin (the command's `initial`).
      await expect(dialog.getByLabel('Quantity received')).toHaveValue(String(open));
      await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveAttribute('data-phase', 'success');

      expect(scalar(sample.db, 'SELECT qty FROM stock_level WHERE product_id = ? AND bin_id = ?', product, bin)).toBe(before + open);
      expect(count(sample.db, 'SELECT count(*) FROM stock_movement')).toBe(ledger + 1);
      expect(
        scalar(
          sample.db,
          `SELECT reference || ':' || kind || ':' || qty || ':' || bin_qty_after FROM stock_movement ORDER BY id DESC LIMIT 1`,
        ),
      ).toBe(`PO-${po}:receipt:${open}:${before + open}`);
      // The ledger's network balance agrees with the sum of the bins.
      expect(scalar(sample.db, 'SELECT on_hand_after FROM stock_movement ORDER BY id DESC LIMIT 1')).toBe(
        scalar(sample.db, 'SELECT sum(qty) FROM stock_level WHERE product_id = ?', product),
      );
      expect(scalar(sample.db, `SELECT status || ':' || open_qty || ':' || qty_received FROM po_line WHERE id = ?`, line)).toBe(
        `received:0:${open}`,
      );
      expect(scalar(sample.db, 'SELECT status FROM purchase_order WHERE id = ?', po)).toBe('partial');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();

      // The purchase order says so, and keeps the receipt in its history.
      await page.goto(`${sample.origin}/purchase-orders/~${po}`);
      await expect(page.getByRole('heading', { name: `PO-${po}`, exact: true })).toBeVisible();
      await expect(page.getByText('Partly received', { exact: true }).first()).toBeVisible();
    } finally {
      await sample.stop();
    }
  });

  test('a picker walks a list on a phone, line by line in bin order, and Pick moves the stock', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      await page.setViewportSize({ width: 390, height: 844 });
      const list = Number(
        scalar(
          sample.db,
          `SELECT p.id FROM pick_list p JOIN sales_order o ON o.id = p.sales_order_id
        WHERE p.status = 'to_pick' AND coalesce(o.notes, '') NOT LIKE 'Store reset%' ORDER BY p.id LIMIT 1`,
        ),
      );
      const reference = String(scalar(sample.db, 'SELECT reference FROM pick_list WHERE id = ?', list));
      const lines = rows(
        sample.db,
        `SELECT b.code AS code FROM order_line l LEFT JOIN bin b ON b.id = l.bin_id
        JOIN pick_list p ON p.sales_order_id = l.sales_order_id WHERE p.id = ? ORDER BY b.code, l.id`,
        list,
      ) as Array<{ code: string | null }>;
      await page.goto(`${sample.origin}/pick-walk`);
      await page.getByRole('button', { name: new RegExp(`^${reference}`) }).click();
      await expect(page).toHaveURL(new RegExp(`list=${list}`));
      for (const [i, line] of lines.entries()) {
        await expect(page.getByText(`Line ${i + 1} of ${lines.length}`)).toBeVisible();
        await expect(page.locator('.c-page-pick-walk-bin')).toHaveText(line.code ?? 'Any bin');
        await page.getByRole('button', { name: 'Picked ✓' }).click();
      }
      // A reload lands where the picker was: at the end of the walk.
      await page.reload();
      await expect(page.getByText(`All ${lines.length} lines picked`)).toBeVisible();
      await page.getByRole('button', { name: 'Pick', exact: true }).click();
      await expect(page.getByText(`${reference} is picked. It waits in To pack.`)).toBeVisible();
      expect(scalar(sample.db, 'SELECT status FROM pick_list WHERE id = ?', list)).toBe('picked');
      expect(count(sample.db, `SELECT count(*) FROM stock_movement WHERE pick_list_id = ${list} AND kind = 'pick'`)).toBeGreaterThan(0);
      await expect(page.locator('[data-section-error]')).toHaveCount(0);
      // The floor at a glance, and on hand beside its month.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${sample.origin}/warehouses/1`);
      const map = page.locator('[data-component="bin-map"]');
      await expect(map.getByRole('region', { name: 'Aisle A' }).getByRole('button')).toHaveCount(36);
      await page.goto(`${sample.origin}/products`);
      await expect(page.locator('[data-component="stock-sparkline"] svg').first()).toBeVisible();
      await expect(page.locator('[data-section-error]')).toHaveCount(0);
    } finally {
      await sample.stop();
    }
  });

  test('a pick list the warehouse cannot fill is refused whole, saying what is short', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const list = Number(
        scalar(
          sample.db,
          `SELECT p.id FROM pick_list p JOIN sales_order o ON o.id = p.sales_order_id
        WHERE p.status = 'to_pick' AND o.notes LIKE 'Store reset%'`,
        ),
      );
      const wanted = Number(
        scalar(
          sample.db,
          `SELECT l.qty FROM order_line l JOIN product p ON p.id = l.product_id
        WHERE l.sales_order_id = ? AND p.sku = 'LGT-B40-RED'`,
          list,
        ),
      );
      const have = Number(
        scalar(
          sample.db,
          `SELECT sum(s.qty) FROM stock_level s JOIN product p ON p.id = s.product_id
        WHERE p.sku = 'LGT-B40-RED' AND s.warehouse_id = 2`,
        ),
      );
      expect(have).toBeLessThan(wanted);
      const ledger = count(sample.db, 'SELECT count(*) FROM stock_movement');

      /* Pick asks nothing, so it runs on one click with no dialog (df773272): its refusal and its result are said in
         the notice, in the command's own words. */
      await page.goto(`${sample.origin}/pick-lists/~${list}`);
      await page.getByRole('button', { name: 'Pick', exact: true }).click();
      await expect(page.locator('#toast')).toContainText(`Only ${have} of LGT-B40-RED on hand in Columbus; this order needs ${wanted}.`);
      await expect(page.getByRole('dialog', { name: 'Pick' })).toHaveCount(0);
      // Nothing moved: not the short line, and not the bottle beside it that could have been picked.
      expect(count(sample.db, 'SELECT count(*) FROM stock_movement')).toBe(ledger);
      expect(scalar(sample.db, 'SELECT status FROM pick_list WHERE id = ?', list)).toBe('to_pick');

      // A list that can be filled is picked from its bins, in the ledger.
      const other = Number(scalar(sample.db, `SELECT id FROM pick_list WHERE status = 'to_pick' AND id != ? ORDER BY id LIMIT 1`, list));
      const units = Number(scalar(sample.db, 'SELECT sum(qty) FROM order_line WHERE sales_order_id = ?', other));
      await page.goto(`${sample.origin}/pick-lists/~${other}`);
      await page.getByRole('button', { name: 'Pick', exact: true }).click();
      await expect(page.locator('#toast')).toContainText(new RegExp(`Picked ${units} units? on `));
      expect(scalar(sample.db, 'SELECT status FROM pick_list WHERE id = ?', other)).toBe('picked');
      expect(scalar(sample.db, `SELECT -sum(qty) FROM stock_movement WHERE pick_list_id = ? AND kind = 'pick'`, other)).toBe(units);
    } finally {
      await sample.stop();
    }
  });

  test('an operator works the floor but cannot do a buyer’s work, on the page or at the server', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const operator = { email: 'operator@depot.example.test', password: 'disposable-depot-operator-password' };
      const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
        headers: { origin: sample.origin },
        data: { ...operator, name: 'Rosa Delgado', role: 'operator' },
      });
      expect(made.ok()).toBe(true);
      await page.context().clearCookies();
      await signIn(page, sample.origin, operator);

      const draft = Number(scalar(sample.db, `SELECT id FROM purchase_order WHERE status = 'draft' ORDER BY id LIMIT 1`));
      await page.goto(`${sample.origin}/purchase-orders/~${draft}`);
      await expect(page.getByRole('heading', { name: `PO-${draft}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send to supplier', exact: true })).toHaveCount(0);
      // The buyer's form is not in the operator's menu; the floor's are.
      await expect(page.getByRole('button', { name: 'New purchase order' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Start a count' }).first()).toBeVisible();

      // Asked directly, the server refuses it.
      const refused = await page.request.post(`${sample.origin}/api/commands/execute?app=depot`, {
        headers: { origin: sample.origin },
        data: {
          command: 'sendPurchaseOrder',
          commandVersion: 1,
          key: { id: draft },
          expectedVersion: 0,
          idempotencyKey: 'depot-operator-send-0001',
          input: {},
        },
      });
      expect(refused.status()).toBe(403);
      expect(scalar(sample.db, 'SELECT status FROM purchase_order WHERE id = ?', draft)).toBe('draft');

      // Nor may the operator change a reorder point, which is the catalog's.
      const product = await page.request.post(`${sample.origin}/api/update`, {
        headers: { origin: sample.origin },
        data: { app: 'depot', table: 'product', key: { id: 1 }, values: { reorder_point: 999 } },
      });
      expect(product.ok()).toBe(false);
      expect(scalar(sample.db, 'SELECT reorder_point FROM product WHERE id = 1')).not.toBe(999);
    } finally {
      await sample.stop();
    }
  });

  test('two commands in a row on an order’s page leave it showing the order as stored, while its refresh is slow', async ({ page }) => {
    /* A tenant's record page composes in seconds on PostgreSQL, so the refresh one command asks for
       is still out when the next is sent; each compose is held here for as long. One that read the order before
       the second command landed was kept, and the page went back to the first command's status, and stayed. */
    const sample = await startSample('depot');
    let composing = 0;
    try {
      await signIn(page, sample.origin);
      const draft = Number(scalar(sample.db, `SELECT id FROM purchase_order WHERE status = 'draft' ORDER BY id LIMIT 1`));
      await page.goto(`${sample.origin}/purchase-orders/~${draft}`);
      await expect(page.getByRole('heading', { name: `PO-${draft}`, exact: true })).toBeVisible();
      const order = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Order', exact: true }) });
      await expect(order).toContainText(/Status\s*Draft/);
      let out = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/')) out++;
      });
      for (const settled of ['requestfinished', 'requestfailed'] as const)
        page.on(settled, (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/')) out--;
        });
      await page.route('**/api/pages/compose*', async (route) => {
        composing++;
        try {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 2500));
          await route.fulfill({ response });
        } finally {
          composing--;
        }
      });

      // Send to supplier asks nothing: one click sends it (df773272), and its notice says so.
      await page.getByRole('button', { name: 'Send to supplier', exact: true }).first().click();
      await expect(page.locator('#toast')).toContainText(`PO-${draft} sent to`);
      expect(scalar(sample.db, 'SELECT status FROM purchase_order WHERE id = ?', draft)).toBe('sent');

      // At once, with the first refresh still out: the second command is prepared for the order as it now stands.
      await page.getByRole('button', { name: 'Cancel order', exact: true }).first().click();
      const cancel = page.getByRole('dialog', { name: 'Cancel order' });
      await cancel.getByLabel('Reason', { exact: false }).fill('Supplier closed');
      await cancel.getByRole('button', { name: 'Cancel order', exact: true }).click();
      await expect(cancel.getByRole('status')).toHaveAttribute('data-phase', 'success');
      await cancel.getByRole('button', { name: 'Done', exact: true }).click();
      expect(scalar(sample.db, "SELECT status || ':' || version FROM purchase_order WHERE id = ?", draft)).toBe('cancelled:2');

      // Once every compose has landed and every read is in, the page is the order as stored, and stays so.
      await expect.poll(() => composing + out, { timeout: 20_000 }).toBe(0);
      await expect(order).toContainText(/Status\s*Cancelled/);
      await expect(page.getByRole('main')).toContainText('Cancelled: Supplier closed');
      /* A kept compose redrew the old status a moment after the new one showed: look again once it would have. */
      await page.waitForTimeout(500);
      expect(await order.innerText()).toMatch(/Status\s*Cancelled/);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await sample.stop();
    }
  });

  test('a reader who may run none of a list’s row verbs gets no ⋯ and no column for it; one who may, does', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      // The buyer holds no stock command (Transfer and Adjust are the floor's and the manager's), so Stock is theirs to read only.
      await signIn(page, sample.origin);
      const purchaser = { email: 'buyer@depot.example.test', password: 'disposable-depot-buyer-password' };
      const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
        headers: { origin: sample.origin },
        data: { ...purchaser, name: 'Bea Alvarez', role: 'purchaser' },
      });
      expect(made.ok()).toBe(true);
      await page.context().clearCookies();
      await signIn(page, sample.origin, purchaser);
      await page.goto(`${sample.origin}/stock`);
      await expect(page.locator('.result-table tbody tr').first()).toBeVisible();
      await expect(page.locator('.row-actions-trigger')).toHaveCount(0);
      await expect(page.locator('.result-table th.row-trail')).toHaveCount(0);

      await page.context().clearCookies();
      await signIn(page, sample.origin);
      await page.goto(`${sample.origin}/stock`);
      await expect(page.locator('.row-actions-trigger').first()).toBeVisible();
      await expect(page.locator('.result-table th.row-trail')).toHaveCount(1);
    } finally {
      await sample.stop();
    }
  });

  test("Today greets its reader by the account's own name, which the reader can give", async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      // The administrator the server creates is named for its address until it gives a name of its own.
      await page.goto(`${sample.origin}/`);
      await expect(page.getByRole('heading', { level: 1, name: 'Hello, admin' })).toBeVisible();
      const named = await page.request.post(`${sample.origin}/api/auth/update-user`, {
        headers: { origin: sample.origin },
        data: { name: 'Dana Ortiz' },
      });
      expect(named.ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Hello, Dana Ortiz' })).toBeVisible();
    } finally {
      await sample.stop();
    }
  });

  test('a catalog imports from a CSV file: checked row by row, written as one, kept in history without App Undo', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const products = count(sample.db, 'SELECT count(*) FROM product');
      const supplier = String(scalar(sample.db, 'SELECT name FROM supplier ORDER BY id LIMIT 1'));
      // A category whose products have no specifications a definition requires (row-defined fields), so a row needs only these columns.
      const category = String(
        scalar(
          sample.db,
          'SELECT name FROM category WHERE id NOT IN (SELECT category_id FROM attribute WHERE required AND category_id IS NOT NULL) ORDER BY id LIMIT 1',
        ),
      );
      const bin = String(scalar(sample.db, 'SELECT code FROM bin ORDER BY id LIMIT 1'));
      const taken = String(scalar(sample.db, 'SELECT sku FROM product ORDER BY id LIMIT 1'));
      const csv = [
        'SKU,Product name,Category,Supplier,Unit cost,List price,Home bin',
        `IMP-001,Imported tent,${category},${supplier},"1,120.00","1,499.00",${bin}`,
        `IMP-002,Imported tarp,${category},${supplier},12,20,`,
        `IMP-003,Nobody's,${category},Nobody Supply Co,12,20,`,
        `IMP-004,Too cheap,${category},${supplier},20,12,`,
        `${taken},Taken SKU,${category},${supplier},1,2,`,
        `=HYPERLINK("http://example.test"),Formula,${category},${supplier},10,5,`,
      ].join('\n');

      await page.goto(`${sample.origin}/products`);
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Import products' });
      await dialog.locator('input[type=file]').setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      // Every column is suggested its field by the header: "Product name" is the product's name.
      await expect(dialog.getByRole('button', { name: 'Field for Product name' })).toContainText('Product');
      await dialog.getByRole('button', { name: 'Check 6 rows' }).click();
      await expect(dialog.getByRole('status')).toHaveText('2 rows are ready; 4 rows have a problem and will be left out.');
      await expect(dialog.getByText('No supplier is named "Nobody Supply Co".')).toBeVisible();
      await expect(dialog.getByText('A product sells for at least what it costs.').first()).toBeVisible();
      expect(count(sample.db, 'SELECT count(*) FROM product'), 'a check writes nothing').toBe(products);

      // The rows with problems download with each formula written as text.
      const [problems] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: 'Download the rows with problems' }).click(),
      ]);
      const said = readFileSync((await problems.path())!, 'utf8');
      expect(said).toContain(`"'=HYPERLINK(""http://example.test"")"`);
      expect(said).not.toMatch(/(^|,)=HYPERLINK/m);

      await dialog.getByRole('button', { name: 'Import the 2 ready rows' }).click();
      await expect(dialog.getByRole('status')).toHaveText('Imported 2 products.');
      expect(
        rows(
          sample.db,
          `SELECT p.sku, p.unit_cost, p.list_price, b.code AS bin FROM product p LEFT JOIN bin b ON b.id = p.home_bin_id
        WHERE p.sku LIKE 'IMP-%' ORDER BY p.sku`,
        ),
      ).toEqual([
        { sku: 'IMP-001', unit_cost: 1120, list_price: 1499, bin },
        { sku: 'IMP-002', unit_cost: 12, list_price: 20, bin: null },
      ]);
      // Each record's history says who imported it, in one write.
      expect(
        scalar(
          sample.db,
          `SELECT count(DISTINCT write_id) || ':' || count(*) || ':' || min(action) FROM __mistri_history_change
        WHERE resource = 'product' AND kind = 'insert'`,
        ),
      ).toBe('1:2:Import');

      await expect(dialog.getByRole('button', { name: 'Undo this import' })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(dialog).toHaveCount(0);
      expect(count(sample.db, `SELECT count(*) FROM product WHERE sku LIKE 'IMP-%'`)).toBe(2);
    } finally {
      await sample.stop();
    }
  });

  test('a paper count imports through Record count, never around it, and an operator cannot import the catalog', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const operator = { email: 'counter@depot.example.test', password: 'disposable-depot-counter-password' };
      const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
        headers: { origin: sample.origin },
        data: { ...operator, name: 'Ari Novak', role: 'operator' },
      });
      expect(made.ok()).toBe(true);
      await page.context().clearCookies();
      await signIn(page, sample.origin, operator);

      const open = rows<{ id: number; bin: string; sku: string }>(
        sample.db,
        `SELECT l.id, b.code AS bin, p.sku FROM cycle_count_line l
        JOIN cycle_count c ON c.id = l.cycle_count_id JOIN bin b ON b.id = l.bin_id JOIN product p ON p.id = l.product_id
        WHERE c.status = 'counting' AND l.counted_qty IS NULL ORDER BY b.code, p.sku LIMIT 2`,
      );
      expect(open.length).toBe(2);
      const closed = rows<{ bin: string; sku: string }>(
        sample.db,
        `SELECT b.code AS bin, p.sku FROM cycle_count_line l
        JOIN cycle_count c ON c.id = l.cycle_count_id JOIN bin b ON b.id = l.bin_id JOIN product p ON p.id = l.product_id
        WHERE c.status = 'completed' AND NOT EXISTS (SELECT 1 FROM cycle_count_line o JOIN cycle_count oc ON oc.id = o.cycle_count_id
          WHERE oc.status = 'counting' AND o.bin_id = l.bin_id AND o.product_id = l.product_id) LIMIT 1`,
      )[0];
      const receipts = count(sample.db, 'SELECT count(*) FROM __mistri_command_receipt');
      const csv = [
        'Bin,Product,Counted',
        `${open[0].bin},${open[0].sku},7`,
        `${open[1].bin},${open[1].sku},-1`,
        `${closed.bin},${closed.sku},3`,
      ].join('\n');

      await page.goto(`${sample.origin}/count-sheet`);
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Import count lines' });
      await dialog.locator('input[type=file]').setInputFiles({ name: 'aisle.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await dialog.getByRole('button', { name: 'Check 3 rows' }).click();
      await expect(dialog.getByRole('status')).toHaveText('1 row is ready; 2 rows have a problem and will be left out.');
      // A closed count's line is not on the sheet, so no row lands on it.
      await expect(dialog.getByText(`No record in this list has Bin ${closed.bin}, Product ${closed.sku}.`)).toBeVisible();
      await dialog.getByRole('button', { name: 'Import the 1 ready row' }).click();
      await expect(dialog.getByRole('status')).toHaveText('Imported 1 count line.');
      await expect(dialog.getByRole('button', { name: 'Undo this import' })).toHaveCount(0);
      expect(scalar(sample.db, 'SELECT counted_qty FROM cycle_count_line WHERE id = ?', open[0].id)).toBe(7);
      expect(scalar(sample.db, 'SELECT counted_qty FROM cycle_count_line WHERE id = ?', open[1].id)).toBe(null);
      // The command ran, with its receipt, exactly as the Count button would have run it.
      expect(count(sample.db, 'SELECT count(*) FROM __mistri_command_receipt')).toBe(receipts + 1);
      await dialog.getByRole('button', { name: 'Done' }).click();

      // The catalog is the buyers': no Import for the floor, and the server refuses it asked directly.
      await page.goto(`${sample.origin}/products`);
      await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
      const refused = await page.request.post(`${sample.origin}/api/import?app=depot`, {
        headers: { origin: sample.origin },
        data: { table: 'product', csv: 'SKU,Product\nX-1,X', mapping: ['sku', 'name'], mode: 'commit' },
      });
      expect(refused.status()).toBe(403);
    } finally {
      await sample.stop();
    }
  });

  test("Today says what changed, picks its chart's own period, and works the open orders in place", async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      // A change made now is at the head of the feed, by who made it, the record by its name.
      const order = scalar<number>(sample.db, `SELECT id FROM sales_order WHERE priority = 'normal' ORDER BY id DESC LIMIT 1`);
      const raised = await page.request.post(`${sample.origin}/api/update`, {
        headers: { origin: sample.origin },
        data: { app: 'depot', table: 'sales_order', key: { id: order }, values: { priority: 'rush' }, expected: { priority: 'normal' } },
      });
      expect(raised.ok()).toBe(true);
      await page.goto(`${sample.origin}/`);
      const feed = page.getByRole('complementary', { name: 'Dashboard context' }).locator('.activity');
      const first = feed.locator('.activity-entry').first();
      await expect(first).toContainText(`SO-${order}`);
      await expect(first).toContainText('Rush');
      // Who made it by the name the bootstrapped account was given (its address's first part, as words), never the address.
      await expect(first.locator('.activity-by')).toHaveText('Admin');
      await expect(feed).not.toContainText('@');
      await feed.getByRole('searchbox').fill(`SO-${order}`);
      // The search keeps only that order's changes: the seeded week may hold an earlier one of its own.
      await expect(feed.locator('.activity-entry').first()).toContainText('Rush');
      await expect(feed.locator('.activity-entry').filter({ hasNotText: `SO-${order}` })).toHaveCount(0);
      // The chart's period is its own, and the address says it.
      await page.getByLabel('Period of Lines moved by day').click();
      await page.getByRole('option', { name: 'Last 30 days' }).click();
      await expect(page).toHaveURL(/[?&]period\.lines-moved-by-day=last-30-days/);
      // The open orders select in place and offer the room's "Set field…".
      const orders = page.locator('.dash-list-works');
      await orders.getByRole('row').nth(1).getByRole('checkbox').check();
      await expect(orders.getByRole('button', { name: 'Set field…' })).toBeVisible();
    } finally {
      await sample.stop();
    }
  });

  test('Low stock lists exactly the active SKUs under their reorder point', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const low = rows<{ sku: string }>(
        sample.db,
        `SELECT p.sku FROM product p WHERE p.status = 'active'
        AND (SELECT coalesce(sum(qty), 0) FROM stock_level s WHERE s.product_id = p.id) < p.reorder_point ORDER BY p.sku`,
      );
      expect(low.length).toBeGreaterThan(3);
      await page.goto(`${sample.origin}/products?tab=low_stock`);
      await expect(page.getByRole('tab', { name: new RegExp(`^Low stock\\s*${low.length}$`) })).toBeVisible();
      // The first page of them, each one of the SKUs the fixture says are short, and none other.
      const grid = page.getByRole('grid').first();
      await expect(grid.getByRole('row')).toHaveCount(Math.min(low.length, 20) + 1);
      const shown = await grid.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.textContent ?? ''));
      const skus = new Set(low.map(({ sku }) => sku));
      for (const text of shown)
        expect(
          [...skus].some((sku) => text.includes(sku)),
          text,
        ).toBe(true);
    } finally {
      await sample.stop();
    }
  });
  test("the header's New menu lists what each role may make, opens it, and the palette finds the same", async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      await page.goto(`${sample.origin}/`);
      const newMenu = page.getByRole('button', { name: 'New', exact: true });
      await newMenu.click();
      // A list's New form leads a command's form, whatever order the App wrote them in (d8b22e9c7: make before run).
      await expect(page.getByRole('menuitem')).toHaveText(['Product', 'Supplier', 'Purchase order', 'Cycle count']);
      await page.getByRole('menuitem', { name: 'Purchase order', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'New purchase order', level: 1 })).toBeVisible();

      // A list's line opens its New form over the list.
      await newMenu.click();
      await page.getByRole('menuitem', { name: 'Supplier', exact: true }).click();
      await expect(page.locator('.newpanel')).toBeVisible();
      await expect(page).toHaveURL(/\/suppliers\/new$/);
      await page.keyboard.press('Escape');

      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox', { name: 'Search' }).fill('new cycle');
      await page.locator('.palette-item', { hasText: 'New cycle count' }).first().click();
      await expect(page.getByRole('heading', { name: 'Start a count', level: 1 })).toBeVisible();

      // An operator makes counts, not orders or the catalog: one line.
      const operator = { email: 'operator@depot.example.test', password: 'disposable-depot-operator-password' };
      const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
        headers: { origin: sample.origin },
        data: { ...operator, name: 'Rosa Delgado', role: 'operator' },
      });
      expect(made.ok()).toBe(true);
      await page.context().clearCookies();
      await signIn(page, sample.origin, operator);
      await page.goto(`${sample.origin}/`);
      await newMenu.click();
      await expect(page.getByRole('menuitem')).toHaveText(['Cycle count']);
    } finally {
      await sample.stop();
    }
  });
});
