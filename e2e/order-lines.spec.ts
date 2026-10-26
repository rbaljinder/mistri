import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from './support/harness';
import { TMP } from './support/fixtures';
import { rows, scalar } from './support/db';

/**
 * An order, its lines and its totals (test/fixtures/apps/order-desk): money
 * kept in cents and said in each order's own currency; a New order's lines
 * asked as a grid, its total said as they are typed, and the order and every
 * line written together — or, when one line is refused, nothing. The
 * database is asked what was written, never the screen alone.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp), so it runs
 * beside the other parallel specs and edits nothing they read.
 */
let origin = '';
let db = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(TMP, 'order-lines-'));
  db = join(directory, 'shop.db');
  execFileSync(process.execPath, [resolve('test/fixtures/apps/order-desk/seed.mjs'), db], { stdio: 'pipe' });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/mistri/src/server/index.ts',
      '--config',
      `${db}.json`,
      '--app',
      'test/fixtures/apps/order-desk',
      '--port',
      String(port),
    ],
    { env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = started;
  let log = '';
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Order desk did not start: ${log}`)), 20_000);
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`Order desk exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
});

const linesOf = (order: number) =>
  rows<{ position: number; product: string; quantity: number; unit_price: number }>(
    db,
    'SELECT position, product, quantity, unit_price FROM order_line WHERE order_id = ? ORDER BY position',
    order,
  ).map((line) => ({ ...line }));

test("amounts kept in cents are said in each order's own currency", async ({ page }) => {
  await page.goto(`${origin}/orders`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  const dollars = page.locator('.result-table tbody tr', { hasText: 'Ada Lovelace' });
  const yen = page.locator('.result-table tbody tr', { hasText: 'Kenji Sato' });
  // 2 × $19.99 + 3 × $8.50 + $5.00 shipping; ¥4,200 + ¥800.
  await expect(dollars).toContainText('$70.48');
  // The shipping column holds whole amounts only, so it says them whole (45aaa320): $5, not $5.00.
  await expect(dollars).toContainText(/\$5(?![.\d])/);
  await expect(yen).toContainText('¥5,000');
  await expect(yen).toContainText('¥800');
});

test('a new order is asked with its lines, its total said as they are typed, and saved whole or not at all', async ({ page }) => {
  await page.goto(`${origin}/orders/new`);
  const form = page.locator('form').filter({ has: page.getByRole('group', { name: 'Lines' }) });
  await form.getByRole('textbox', { name: 'Customer' }).fill('Grace Hopper');
  await form.getByRole('textbox', { name: 'Currency' }).fill('USD');
  await form.getByRole('textbox', { name: 'Shipping' }).fill('5');

  // An order is saved with at least one line, so the form starts with one.
  const lines = form.getByRole('group', { name: 'Lines' });
  await lines.getByRole('textbox', { name: 'Product, 1' }).fill('Kettle');
  await lines.getByRole('textbox', { name: 'Quantity, 1' }).fill('2');
  await lines.getByRole('textbox', { name: 'Unit price, 1' }).fill('19.99');
  const total = form.locator('.form-live dt', { hasText: /^Total$/ }).locator('xpath=following-sibling::dd[1]');
  await expect(total).toHaveText('$44.98');

  await lines.getByRole('button', { name: 'Add line' }).click();
  // The new line's first box has the focus, so a keyboard adds lines as fast as it types them.
  await expect(lines.getByRole('textbox', { name: 'Product, 2' })).toBeFocused();
  await page.keyboard.type('Lid');
  await lines.getByRole('textbox', { name: 'Quantity, 2' }).fill('0');
  await lines.getByRole('textbox', { name: 'Unit price, 2' }).fill('0.5');
  await expect(total).toHaveText('$44.98');

  // The line's own validation refuses the order: its sentence said on the line's cell, nothing written.
  const orders = Number(scalar(db, 'SELECT count(*) FROM sales_order'));
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(lines.getByText('Order at least one.')).toBeVisible();
  await expect(lines.getByRole('textbox', { name: 'Quantity, 2' })).toHaveAttribute('aria-invalid', 'true');
  await expect(lines.getByRole('textbox', { name: 'Quantity, 1' })).not.toHaveAttribute('aria-invalid', 'true');
  expect(Number(scalar(db, 'SELECT count(*) FROM sales_order'))).toBe(orders);

  await lines.getByRole('textbox', { name: 'Quantity, 2' }).fill('4');
  await expect(total).toHaveText('$46.98');
  // The handle is the keyboard's way to move a line as well as the pointer's.
  await lines.getByRole('button', { name: 'Move line 2' }).press('Alt+ArrowUp');
  await expect(lines.getByRole('textbox', { name: 'Product, 1' })).toHaveValue('Lid');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => Number(scalar(db, 'SELECT count(*) FROM sales_order'))).toBe(orders + 1);
  const id = Number(scalar(db, "SELECT id FROM sales_order WHERE customer = 'Grace Hopper'"));
  expect(Number(scalar(db, 'SELECT shipping FROM sales_order WHERE id = ?', id))).toBe(500);
  expect(linesOf(id)).toEqual([
    { position: 1, product: 'Lid', quantity: 4, unit_price: 50 },
    { position: 2, product: 'Kettle', quantity: 2, unit_price: 1999 },
  ]);
});
