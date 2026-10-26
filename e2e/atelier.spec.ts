import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from './support/harness';
import { ATELIER_ADMIN, startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* Atelier on its own server over its own seeded file: a staff account packs
   and ships a paid order from its fulfillment (told beside the field when the
   tracking number is missing), cancels an unpaid order once — its payment and
   parcel move with it — and refunds part of a payment, through the machines'
   buttons, and the two dashboards paint. */
type Sample = Awaited<ReturnType<typeof startSample>>;
const STAFF = { email: 'staff@atelier.example.test', password: 'disposable-atelier-staff-password' };

async function signIn(page: Page, sample: Sample, account: { email: string; password: string }) {
  const response = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
    headers: { origin: sample.origin },
    data: account,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function asStaff(page: Page, sample: Sample) {
  await signIn(page, sample, ATELIER_ADMIN);
  const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
    headers: { origin: sample.origin },
    data: { ...STAFF, name: 'Mara Quinn', role: 'staff' },
  });
  expect(made.ok(), await made.text()).toBe(true);
  await page.context().clearCookies();
  await signIn(page, sample, STAFF);
}

/** Runs a record's verb that asks something: its button, then its dialog's submit. */
async function verb(page: Page, name: string, fill?: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) {
  await page.getByRole('button', { name, exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog.getByRole('status')).toContainText('Ready to submit');
  if (fill) await fill(dialog);
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveAttribute('data-phase', 'success');
  return dialog;
}

test.describe('Atelier back office', () => {
  test.setTimeout(120_000);

  test('New order takes its products in the lines grid: named and pictured through the product, priced from the variant, a bad line refused at its cell', async ({
    page,
  }) => {
    const sample = await startSample('atelier');
    try {
      await asStaff(page, sample);
      const named = `p.title || ' · ' || v.color || ' / ' || v.size`;
      const forSale = `SELECT ${named} FROM variant v JOIN product p ON p.id = v.product_id
        JOIN inventory_level l ON l.variant_id = v.id JOIN location w ON w.id = l.location_id AND w.code = 'SEC'
        WHERE p.status = 'active' AND v.active = 1 AND l.on_hand >= 5 ORDER BY v.id`;
      const [a, b, c] = [0, 1, 2].map((n) => String(scalar(sample.db, `${forSale} LIMIT 1 OFFSET ${n}`)));
      const retired = String(
        scalar(sample.db, `SELECT ${named} FROM variant v JOIN product p ON p.id = v.product_id WHERE v.active = 0 ORDER BY v.id LIMIT 1`),
      );
      const orders = Number(scalar(sample.db, 'SELECT count(*) FROM sales_order'));

      await page.goto(`${sample.origin}/`);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Order' }).click();
      const form = page.getByRole('region', { name: 'New order' });
      await form.getByRole('combobox', { name: 'Customer' }).click();
      await page.getByRole('option').first().click();
      await form.getByRole('combobox', { name: 'Ships from' }).click();
      await page.getByRole('option', { name: /Secaucus/ }).click();
      await form.getByRole('button', { name: 'Continue' }).click();

      // The products are the lines grid: a variant picked says its product's name and picture, fills its price, and the line works out its amount.
      const items = form.getByRole('group', { name: 'Products' });
      const box = (line: number) => items.getByRole('combobox', { name: `Variant, ${line}` });
      const pick = async (line: number, name: string) => {
        await box(line).click();
        await box(line).fill('');
        await box(line).pressSequentially(name.split(' · ')[0]);
        await page
          .getByRole('option', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')) })
          .first()
          .click();
      };
      // Only what is for sale is offered.
      await box(1).click();
      await box(1).pressSequentially(retired.split(' · ')[0]);
      await expect(page.getByRole('option', { name: retired })).toHaveCount(0);
      await pick(1, a);
      await items.getByRole('textbox', { name: 'Quantity, 1' }).fill('21');
      for (const [line, name] of [
        [2, b],
        [3, c],
      ] as const) {
        await items.getByRole('button', { name: /Add line/ }).click();
        await pick(line, name);
        await items.getByRole('textbox', { name: `Quantity, ${line}` }).fill('1');
      }
      await expect(items.locator('.lines-ref.has-thumb').first()).toBeVisible();
      await expect(items.getByRole('row').nth(2)).toContainText(/\$\d+\.\d\d/);
      await expect(items.getByRole('definition')).toContainText(/\$[\d,]+\.\d\d/);
      await form.getByRole('button', { name: 'Continue' }).click();
      await form.getByRole('button', { name: 'Place order' }).click();

      // The handler refuses the line by its cell: said on this step, kept on the cell, and nothing is placed.
      await expect(form.getByRole('alert')).toContainText('Products, row 1, Quantity: A line takes a whole number from 1 to 20.');
      expect(Number(scalar(sample.db, 'SELECT count(*) FROM sales_order'))).toBe(orders);
      await form.getByRole('button', { name: 'Items' }).click();
      await expect(items.locator('td.is-invalid')).toHaveCount(1);
      await items.getByRole('textbox', { name: 'Quantity, 1' }).fill('2');
      await form.getByRole('button', { name: 'Continue' }).click();
      await form.getByRole('button', { name: 'Place order' }).click();
      await expect(page.getByRole('heading', { name: 'Order placed', level: 1 })).toBeVisible();

      // The order holds the three lines in their order, each priced from its variant by the handler.
      const order = Number(scalar(sample.db, 'SELECT max(id) FROM sales_order'));
      expect(Number(scalar(sample.db, 'SELECT count(*) FROM sales_order'))).toBe(orders + 1);
      expect(
        String(
          scalar(
            sample.db,
            `SELECT group_concat(description || ' x' || quantity, ', ') FROM (SELECT description, quantity FROM order_line WHERE sales_order_id = ${order} ORDER BY line_no)`,
          ),
        ),
      ).toBe(`${a} x2, ${b} x1, ${c} x1`);
    } finally {
      await sample.stop();
    }
  });

  // Today's strip mixes cards with a mark and without: a mark standing over its label set that card's figure 25-50px
  // below its neighbour's. And a record's figures stood one per row on a phone, where a dashboard's sit two to a row.
  test("a strip's figures stand on one line and a record's figures sit two to a row on a phone, in every look", async ({ page }) => {
    const sample = await startSample('atelier');
    try {
      await signIn(page, sample, ATELIER_ADMIN);
      const customer = scalar(sample.db, 'SELECT id FROM customer ORDER BY id LIMIT 1');
      for (const look of ['lumen', 'mono', 'sage']) {
        await page.addInitScript((value) => localStorage.setItem('mistri.visual-theme', value), look);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${sample.origin}/`);
          const strip = page.locator('.dash-strip').first();
          /* Lumen's figures carry no mark (2d17bc18: the mark beside "To pick" was decoration), so its rows have none to
             mix; the marks are drawn and hidden, and its figures still stand on one line. */
          const marked = look !== 'lumen';
          const mark = strip.locator('.home-card .dash-section-icon').first();
          await expect(mark).toBeAttached();
          if (marked) await expect(mark).toBeVisible();
          else await expect(mark).toBeHidden();
          /* Every card of Today's strip has its mark; every other one gives it up, so each row mixes the two. */
          const rows = await strip.locator('.home-card').evaluateAll((cards) => {
            cards.forEach((card, index) => {
              if (index % 2) card.querySelector('.dash-section-icon')?.remove();
            });
            const byRow = new Map<number, { values: number[]; marks: number }>();
            for (const card of cards) {
              const top = Math.round(card.getBoundingClientRect().top);
              const row = byRow.get(top) ?? { values: [], marks: 0 };
              row.values.push(card.querySelector('.home-card-value')!.getBoundingClientRect().top);
              const mark = card.querySelector('.dash-section-icon');
              if (mark && mark.getBoundingClientRect().width > 0) row.marks++;
              byRow.set(top, row);
            }
            return [...byRow.values()].map(({ values, marks }) => ({
              spread: Math.max(...values) - Math.min(...values),
              mixed: marks > 0 && marks < values.length,
            }));
          });
          expect(
            rows.some((row) => row.mixed),
            `${look} at ${width}px: a row mixes cards with a mark and without`,
          ).toBe(marked);
          for (const { spread } of rows) expect(spread, `${look} at ${width}px`).toBeLessThanOrEqual(1.5);
          if (width > 600) continue;
          await page.goto(`${sample.origin}/customers/${customer}`);
          const figures = page.locator('.page-field-summary > .page-field');
          await expect(figures.first()).toBeVisible();
          const tops = await figures.evaluateAll((fields) => fields.map((field) => Math.round(field.getBoundingClientRect().top)));
          expect(tops.length, look).toBeGreaterThanOrEqual(2);
          expect(tops[1], `${look}: the second figure beside the first`).toBe(tops[0]);
        }
      }
    } finally {
      await sample.stop();
      rmSync(dirname(sample.db), { recursive: true, force: true });
    }
  });

  test('staff pack and ship a paid order, cancel an unpaid one, refund part of a payment, and the dashboards paint', async ({ page }) => {
    const sample = await startSample('atelier');
    try {
      await asStaff(page, sample);
      let plainWrites = 0;
      page.on('request', (request) => {
        if (/^\/api\/(insert|update|delete)$/.test(new URL(request.url()).pathname)) plainWrites++;
      });

      // Today, the home: its counts and the fulfillment pipeline.
      await page.goto(`${sample.origin}/`);
      await expect(page.getByRole('heading', { name: 'Good to see you, Mara Quinn' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^To confirm: \d+$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^To pack: \d+$/ })).toBeVisible();
      // A pipeline step opens its rows in the App's own list, so it is a link there (Dashboard.tsx, viewLink.ts).
      const pending = page.getByRole('link', { name: /^Pending Waiting to be picked and packed \d+$/ });
      await expect(pending).toBeVisible();
      await expect(pending).toHaveAttribute('href', /^\/fulfillment\?/);

      // The orders list, on its To pack tab.
      await page.goto(`${sample.origin}/orders?tab=to_pack`);
      await expect(page.locator('.result-table tbody tr').first()).toBeVisible();

      // Pack the oldest paid, confirmed order: its units leave the warehouse shelf, into the ledger.
      const fulfillment = Number(
        scalar(
          sample.db,
          `SELECT f.id FROM fulfillment f JOIN sales_order o ON o.id = f.sales_order_id JOIN payment p ON p.sales_order_id = o.id
           WHERE f.status = 'pending' AND o.status = 'confirmed' AND p.status = 'paid' AND o.shipping_method != 'pickup'
           ORDER BY f.id LIMIT 1`,
        ),
      );
      const order = Number(scalar(sample.db, `SELECT sales_order_id FROM fulfillment WHERE id = ${fulfillment}`));
      const units = Number(scalar(sample.db, `SELECT sum(quantity) FROM order_line WHERE sales_order_id = ${order}`));
      const before = Number(scalar(sample.db, `SELECT count(*) FROM inventory_movement WHERE fulfillment_id = ${fulfillment}`));
      await page.goto(`${sample.origin}/fulfillment/${fulfillment}`);
      /* Pick & pack asks nothing, so it runs on one click with no dialog (df773272), and its notice says what the
         command said it did. */
      await page.getByRole('button', { name: 'Pick & pack', exact: true }).first().click();
      await expect(page.locator('#toast')).toContainText(`Order #${order} is packed`);
      await expect(page.getByRole('dialog', { name: 'Pick & pack' })).toHaveCount(0);
      expect(scalar(sample.db, `SELECT status FROM fulfillment WHERE id = ${fulfillment}`)).toBe('packed');
      expect(Number(scalar(sample.db, `SELECT -sum(quantity) FROM inventory_movement WHERE fulfillment_id = ${fulfillment}`))).toBe(units);
      expect(before).toBe(0);

      // Ship it: a carrier's parcel without its tracking number is refused beside that field, and the form stays open.
      await page.goto(`${sample.origin}/fulfillment/${fulfillment}`);
      await page.getByRole('button', { name: 'Ship', exact: true }).first().click();
      const ship = page.getByRole('dialog', { name: 'Ship', exact: true });
      await expect(ship.getByRole('status')).toContainText('Ready to submit');
      await ship.getByRole('button', { name: 'Ship', exact: true }).click();
      const tracking = ship.getByRole('textbox', { name: /Tracking number/ });
      await expect(tracking).toHaveAttribute('aria-invalid', 'true');
      await expect(ship).toContainText('needs its tracking number');
      expect(scalar(sample.db, `SELECT status FROM fulfillment WHERE id = ${fulfillment}`)).toBe('packed');
      await tracking.fill('1Z999AA10123456784');
      await ship.getByRole('button', { name: 'Ship', exact: true }).click();
      await expect(ship.getByRole('status')).toHaveAttribute('data-phase', 'success');
      expect(scalar(sample.db, `SELECT status FROM fulfillment WHERE id = ${fulfillment}`)).toBe('shipped');
      // The order reads its parcel's state where the parcel writes it: a rollup, not a copy kept in step.
      await page.goto(`${sample.origin}/orders/${order}`);
      await expect(page.getByText('Shipped', { exact: true }).first()).toBeVisible();

      // An unpaid open order: its payment row offers its own verbs, and one Cancel order voids the payment and cancels the parcel.
      const open = Number(
        scalar(
          sample.db,
          `SELECT o.id FROM sales_order o JOIN payment p ON p.sales_order_id = o.id JOIN fulfillment f ON f.sales_order_id = o.id
           WHERE o.status = 'open' AND p.status = 'pending' AND f.status = 'pending' ORDER BY o.id LIMIT 1`,
        ),
      );
      await page.goto(`${sample.origin}/orders/${open}`);
      await page
        .getByRole('button', { name: /^Actions for / })
        .first()
        .click();
      await expect(page.getByRole('menuitem', { name: 'Mark as paid' })).toBeVisible();
      await page.keyboard.press('Escape');
      await verb(page, 'Cancel order', async (dialog) => {
        await dialog.getByRole('textbox', { name: /Why/ }).fill('Customer changed their mind');
      });
      expect(scalar(sample.db, `SELECT status FROM sales_order WHERE id = ${open}`)).toBe('cancelled');
      expect(scalar(sample.db, `SELECT status FROM payment WHERE sales_order_id = ${open}`)).toBe('voided');
      expect(scalar(sample.db, `SELECT status FROM fulfillment WHERE sales_order_id = ${open}`)).toBe('cancelled');

      // Refund $10 of a paid, delivered order: the amount is offered at what is left, and changed.
      const payment = Number(
        scalar(
          sample.db,
          `SELECT p.id FROM payment p JOIN sales_order o ON o.id = p.sales_order_id WHERE p.status = 'paid' AND o.status = 'completed' ORDER BY p.id DESC LIMIT 1`,
        ),
      );
      const paid = Number(scalar(sample.db, `SELECT paid_amount FROM payment WHERE id = ${payment}`));
      await page.goto(`${sample.origin}/payments/${payment}`);
      await verb(page, 'Refund', async (dialog) => {
        await expect(dialog.getByRole('textbox', { name: /Amount/ })).toHaveValue(String(paid));
        await dialog.getByRole('textbox', { name: /Amount/ }).fill('10');
        await dialog.getByRole('textbox', { name: /Why/ }).fill('Price match');
      });
      expect(scalar(sample.db, `SELECT status FROM payment WHERE id = ${payment}`)).toBe('partially_refunded');
      expect(Number(scalar(sample.db, `SELECT refunded_amount FROM payment WHERE id = ${payment}`))).toBe(10);
      expect(Number(scalar(sample.db, `SELECT count(*) FROM refund WHERE payment_id = ${payment} AND reason = 'Price match'`))).toBe(1);

      // Sales, the owner's desk, paints its charts for staff too.
      await page.goto(`${sample.origin}/sales`);
      await expect(page.getByText('Sales by week', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Top products, last 90 days', { exact: true }).first()).toBeVisible();

      // The rooms around them paint: the fulfillment board, the lookbook's photos and a product's gallery.
      await page.goto(`${sample.origin}/fulfillment`);
      await expect(page.getByText(`#${order} ·`).first()).toBeVisible();
      await page.goto(`${sample.origin}/lookbook`);
      await expect(page.locator('main img').first()).toBeVisible();
      const product = Number(scalar(sample.db, `SELECT product_id FROM product_image ORDER BY id LIMIT 1`));
      await page.goto(`${sample.origin}/products/${product}`);
      await expect(
        page.getByRole('heading', { name: String(scalar(sample.db, `SELECT title FROM product WHERE id = ${product}`)), level: 1 }),
      ).toBeVisible();
      await expect(page.locator('main img').first()).toBeVisible();
      expect(plainWrites).toBe(0);
    } finally {
      await sample.stop();
      rmSync(dirname(sample.db), { recursive: true, force: true });
    }
  });
});
