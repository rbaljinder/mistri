/** The Atelier sample's real seed, App and commands, through HTTP over an owned SQLite file: its order, payment and
    fulfillment machines, refunds bounded by payments, stock that never goes below zero, and totals that add up. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { seed } from '../test/fixtures/databases/atelier/seed.mjs';
import { priceOrder, toCents } from '../test/fixtures/apps/atelier/pricing.ts';
import { day, stamp } from '../test/fixtures/apps/atelier/commands/shared.ts';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

const appDir = resolve('test/fixtures/apps/atelier');
type Row = Record<string, unknown>;
type Reply = { status: number; body: Row & { result?: Row; refusal?: Row; outcome?: string; code?: string; expectedVersion?: number } };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-atelier-test-'));
  const file = await seed(join(directory, 'atelier.db'), { photos: false });
  const db = new DatabaseSync(file, { timeout: 5000 });
  const registry = new Registry();
  let server: ReturnType<typeof createApp> | undefined;
  t.after(async () => {
    try {
      if (server) {
        const closed = new Promise<void>((done) => server!.close(() => done()));
        server.closeAllConnections();
        await closed;
      }
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  registry.add({ id: 'atelier', name: 'atelier', url: file, writable: true, source: 'config' });
  const loaded = await loadApp(appDir);
  const commands = await loadBusinessCommands(join(appDir, 'commands.ts'));
  const accounts: Record<string, Identity> = {
    staff: { id: 'atelier-staff', who: 'staff@atelier.test', role: 'staff' },
    warehouse: { id: 'atelier-warehouse', who: 'dock@atelier.test', role: 'warehouse' },
    owner: { id: 'atelier-owner', who: 'owner@atelier.test', role: 'owner' },
  };
  let current: Identity = accounts.staff;
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    auth: { spec: loaded.app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => current },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], commands: { appId: loaded.app.id, registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = async (path: string, body: unknown): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() };
  };
  let serial = 0;
  /** Prepare (for the record's version) and execute, as `role`. */
  const run = async (role: keyof typeof accounts, command: string, id: number | null, input: Row = {}): Promise<Reply> => {
    current = accounts[role];
    const key = id === null ? undefined : { id };
    let expectedVersion: number | undefined;
    if (key) {
      const prepared = await post('/api/commands/prepare', { command, commandVersion: 1, key });
      if (prepared.status !== 200) return prepared;
      expectedVersion = prepared.body.expectedVersion;
    }
    return post('/api/commands/execute', {
      command,
      commandVersion: 1,
      // A form's command names no record: an empty key, at version 0.
      key: key ?? {},
      expectedVersion: expectedVersion ?? 0,
      idempotencyKey: `atelier-${command}-${++serial}-${Date.now()}`,
      input,
    });
  };
  const one = (sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Row;
  const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
  return { file, db, run, one, all, post };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const ok = (reply: Reply, what: string) => assert.equal(reply.status, 200, `${what}: ${JSON.stringify(reply.body)}`);
const refused = (reply: Reply, what: string, words?: RegExp) => {
  assert.notEqual(reply.status, 200, `${what} should be refused: ${JSON.stringify(reply.body)}`);
  if (words) assert.match(JSON.stringify(reply.body), words, what);
};

/** A variant of an active product with `need` units at the warehouse. */
function stocked(f: Fixture, need: number, skip: number[] = []) {
  const row = f.one(
    `SELECT v.id, v.sku, v.price_amount, l.on_hand FROM variant v JOIN product p ON p.id = v.product_id
     JOIN inventory_level l ON l.variant_id = v.id JOIN location w ON w.id = l.location_id AND w.code = 'SEC'
     WHERE p.status = 'active' AND v.active = 1 AND l.on_hand >= ? ${skip.length ? `AND v.id NOT IN (${skip.join(',')})` : ''}
     ORDER BY v.id LIMIT 1`,
    need,
  );
  assert.ok(row, `a variant with ${need} at the warehouse`);
  return row as { id: number; sku: string; price_amount: number; on_hand: number };
}
const warehouse = (f: Fixture) => Number(f.one(`SELECT id FROM location WHERE code = 'SEC'`).id);
const customerIn = (f: Fixture, state: string) =>
  f.one(`SELECT id, state FROM customer WHERE state = ? ORDER BY id LIMIT 1`, state) as { id: number; state: string };
const levelAt = (f: Fixture, variant: number, location: number) =>
  Number(f.one(`SELECT on_hand FROM inventory_level WHERE variant_id = ? AND location_id = ?`, variant, location).on_hand);

/** A new online order from the warehouse, through createOrder; returns its id. */
async function newOrder(f: Fixture, lines: { variant_id: number; quantity: number }[], extra: Row = {}) {
  const reply = await f.run('staff', 'createOrder', null, {
    customer: customerIn(f, 'NY').id,
    channel: 'online',
    location: warehouse(f),
    shipping: 'standard',
    method: 'card',
    lines,
    ...extra,
  });
  ok(reply, 'createOrder');
  const id = Number(f.one('SELECT max(id) AS id FROM sales_order').id);
  return id;
}
const order = (f: Fixture, id: number) => f.one('SELECT * FROM sales_order WHERE id = ?', id);
const paymentOf = (f: Fixture, id: number) => f.one('SELECT * FROM payment WHERE sales_order_id = ?', id);
const fulfillmentOf = (f: Fixture, id: number) => f.one('SELECT * FROM fulfillment WHERE sales_order_id = ?', id);

/** An order's figures add up, in cents: total = Σ lines − discount + shipping + tax. */
function addsUp(o: Row, lineCents: number) {
  const c = (k: string) => toCents(o[k] as number);
  assert.equal(c('subtotal_amount'), lineCents, `#${o.id} subtotal is the sum of its lines`);
  assert.equal(c('total_amount'), c('subtotal_amount') - c('discount_amount') + c('shipping_amount') + c('tax_amount'), `#${o.id} total`);
}

test('Atelier seed: every order adds up, every shelf agrees with its ledger, no refund exceeds its payment', async (t) => {
  const f = await fixture(t);
  const counts = f.one(`SELECT (SELECT count(*) FROM product) AS products, (SELECT count(*) FROM sales_order) AS orders,
    (SELECT count(*) FROM customer) AS customers, (SELECT count(*) FROM location) AS locations`);
  assert.deepEqual({ ...counts }, { products: 120, orders: 1500, customers: 400, locations: 3 });
  const lines = new Map(
    f.all('SELECT sales_order_id AS id, sum(line_amount) AS amount FROM order_line GROUP BY 1').map((r) => [r.id, r.amount]),
  );
  for (const o of f.all('SELECT * FROM sales_order')) addsUp(o, toCents(lines.get(o.id) as number));
  // Each shelf's count is its ledger's last word, and never below zero.
  const drift = f.all(`SELECT l.id FROM inventory_level l WHERE l.on_hand < 0 OR l.on_hand <> coalesce((SELECT sum(quantity)
    FROM inventory_movement m WHERE m.variant_id = l.variant_id AND m.location_id = l.location_id), 0)`);
  assert.deepEqual(drift, []);
  // Refunds: the rows sum to the payment's refunded amount, which never passes what was paid.
  const money = f.all(`SELECT p.id FROM payment p WHERE p.refunded_amount > p.paid_amount
    OR abs(p.refunded_amount - coalesce((SELECT sum(refund_amount) FROM refund r WHERE r.payment_id = p.id), 0)) > 0.005`);
  assert.deepEqual(money, []);
  // Every order has its one payment and one parcel, whose states its two rollups read (orders.ts `latest`).
  const words = f.all(`SELECT o.id FROM sales_order o WHERE (SELECT count(*) FROM payment p WHERE p.sales_order_id = o.id) <> 1
    OR (SELECT count(*) FROM fulfillment u WHERE u.sales_order_id = o.id) <> 1`);
  assert.deepEqual(words, []);
  // Every state of every machine is there to work with.
  const states = (sql: string) =>
    f
      .all(sql)
      .map((r) => r.status)
      .sort();
  assert.deepEqual(states('SELECT DISTINCT status FROM sales_order'), ['cancelled', 'completed', 'confirmed', 'open']);
  assert.deepEqual(states('SELECT DISTINCT status FROM fulfillment'), ['cancelled', 'delivered', 'packed', 'pending', 'shipped']);
  assert.deepEqual(states('SELECT DISTINCT status FROM order_return'), ['approved', 'received', 'refunded', 'rejected', 'requested']);
});

test('Atelier order lifecycle: placed, paid, confirmed, packed, shipped, delivered, returned and refunded, each by its machine', async (t) => {
  const f = await fixture(t);
  const a = stocked(f, 2);
  const b = stocked(f, 1, [a.id]);
  const sec = warehouse(f);
  const before = { a: levelAt(f, a.id, sec), b: levelAt(f, b.id, sec) };
  const id = await newOrder(f, [
    { variant_id: a.id, quantity: 2 },
    { variant_id: b.id, quantity: 1 },
  ]);
  let o = order(f, id);
  assert.equal(o.status, 'open');
  const payment = paymentOf(f, id);
  const fulfillment = fulfillmentOf(f, id);
  assert.deepEqual([payment.status, fulfillment.status], ['pending', 'pending']);

  // Out of order: nothing is packed before it is confirmed and paid, and the warehouse does not take money.
  refused(await f.run('warehouse', 'fulfillOrder', Number(fulfillment.id)), 'pack an open order', /confirm/i);
  refused(await f.run('warehouse', 'markPaid', Number(payment.id)), 'warehouse marks paid');
  refused(await f.run('staff', 'completeOrder', id), 'complete an open order');
  ok(await f.run('staff', 'confirmOrder', id), 'confirmOrder');
  refused(await f.run('staff', 'confirmOrder', id), 'confirm twice');
  refused(await f.run('warehouse', 'fulfillOrder', Number(fulfillment.id)), 'pack unpaid', /not paid/);
  ok(await f.run('staff', 'markPaid', Number(payment.id), { reference: 'ch_test_1' }), 'markPaid');
  assert.equal(paymentOf(f, id).status, 'paid');

  ok(await f.run('warehouse', 'fulfillOrder', Number(fulfillment.id)), 'fulfillOrder');
  assert.equal(levelAt(f, a.id, sec), before.a - 2);
  assert.equal(levelAt(f, b.id, sec), before.b - 1);
  assert.equal(Number(f.one(`SELECT count(*) AS n FROM inventory_movement WHERE fulfillment_id = ?`, Number(fulfillment.id)).n), 2);
  // Its `when` reads the parcel's state through the order's rollup, in the command's transaction.
  refused(await f.run('staff', 'cancelOrder', id, { reason: 'Changed mind' }), 'cancel after packing');
  refused(await f.run('warehouse', 'shipFulfillment', Number(fulfillment.id), { carrier: 'UPS' }), 'ship without tracking', /tracking/);
  ok(
    await f.run('warehouse', 'shipFulfillment', Number(fulfillment.id), { carrier: 'UPS', tracking_number: '1Z999AA10123456784' }),
    'ship',
  );
  ok(await f.run('warehouse', 'deliverFulfillment', Number(fulfillment.id)), 'deliver');
  o = order(f, id);
  assert.equal(o.status, 'completed', 'a paid order is complete when it is delivered');
  assert.equal(fulfillmentOf(f, id).status, 'delivered');
  refused(await f.run('staff', 'cancelOrder', id, { reason: 'Too late' }), 'cancel a completed order');

  // One of the two A's comes back: approved, received at the warehouse (back on its shelf), refunded at its worth.
  const lineA = f.one('SELECT id FROM order_line WHERE sales_order_id = ? AND variant_id = ?', id, a.id);
  ok(await f.run('staff', 'requestReturn', id, { reason: 'too_small', lines: [{ line: Number(lineA.id), quantity: 1 }] }), 'requestReturn');
  const ret = Number(f.one('SELECT max(id) AS id FROM order_return').id);
  refused(await f.run('warehouse', 'receiveReturn', ret, { location: sec }), 'receive before approval');
  ok(await f.run('staff', 'approveReturn', ret), 'approveReturn');
  ok(await f.run('warehouse', 'receiveReturn', ret, { location: sec }), 'receiveReturn');
  assert.equal(levelAt(f, a.id, sec), before.a - 1);
  ok(await f.run('staff', 'refundReturn', ret), 'refundReturn');
  o = order(f, id);
  const unit = toCents(a.price_amount);
  const expected = priceOrder([{ quantity: 1, unitCents: unit }], { discount: null, shipping: 'pickup', state: 'NY' }).total;
  assert.equal(toCents(f.one('SELECT refund_amount FROM order_return WHERE id = ?', ret).refund_amount as number), expected);
  assert.equal(paymentOf(f, id).status, 'partially_refunded');
  // The same line cannot come back twice over.
  refused(
    await f.run('staff', 'requestReturn', id, { reason: 'too_small', lines: [{ line: Number(lineA.id), quantity: 2 }] }),
    'over-return',
    /left to return/,
  );
});

test('Atelier refunds never exceed what was paid, and a fully refunded payment takes no more', async (t) => {
  const f = await fixture(t);
  const a = stocked(f, 1);
  const id = await newOrder(f, [{ variant_id: a.id, quantity: 1 }]);
  const payment = Number(paymentOf(f, id).id);
  refused(await f.run('staff', 'refundPayment', payment, { amount: 1, reason: 'Goodwill' }), 'refund an unpaid payment');
  ok(await f.run('staff', 'markPaid', payment), 'markPaid');
  const paid = toCents(paymentOf(f, id).paid_amount as number);
  const before = f.one('SELECT count(*) AS n FROM refund').n;
  refused(
    await f.run('staff', 'refundPayment', payment, { amount: (paid + 1) / 100, reason: 'Too much' }),
    'refund past paid',
    /left to refund/,
  );
  assert.equal(f.one('SELECT count(*) AS n FROM refund').n, before, 'a refused refund writes nothing');
  ok(await f.run('staff', 'refundPayment', payment, { amount: 10, reason: 'Price match' }), 'partial refund');
  assert.equal(paymentOf(f, id).status, 'partially_refunded');
  refused(
    await f.run('staff', 'refundPayment', payment, { amount: (paid - 1000 + 1) / 100, reason: 'One cent over' }),
    'refund one cent over',
  );
  ok(await f.run('staff', 'refundPayment', payment, { amount: (paid - 1000) / 100, reason: 'The rest' }), 'refund the rest');
  const p = paymentOf(f, id);
  assert.equal(p.status, 'refunded');
  assert.equal(toCents(p.refunded_amount as number), paid);
  refused(await f.run('staff', 'refundPayment', payment, { amount: 0.01, reason: 'Again' }), 'refund a refunded payment');
  refused(await f.run('warehouse', 'refundPayment', payment, { amount: 0.01, reason: 'Not theirs' }), 'warehouse refunds');
  // Refunded in full, the open order may now be cancelled; its parcel goes with it.
  ok(await f.run('staff', 'cancelOrder', id, { reason: 'Customer asked' }), 'cancel after refund');
  assert.equal(fulfillmentOf(f, id).status, 'cancelled');
  // The database holds the line too: refunded can never pass paid, whoever writes.
  assert.throws(() => f.db.prepare('UPDATE payment SET refunded_amount = paid_amount + 1 WHERE id = ?').run(payment), /CHECK/);
});

test('Atelier stock never goes negative: two fulfillments race for the last unit and one is refused', async (t) => {
  const f = await fixture(t);
  const a = stocked(f, 1);
  const sec = warehouse(f);
  // The test's own setup: leave exactly one at the warehouse.
  f.db.prepare('UPDATE inventory_level SET on_hand = 1 WHERE variant_id = ? AND location_id = ?').run(a.id, sec);
  const orders = [await newOrder(f, [{ variant_id: a.id, quantity: 1 }]), await newOrder(f, [{ variant_id: a.id, quantity: 1 }])];
  for (const id of orders) {
    ok(await f.run('staff', 'markPaid', Number(paymentOf(f, id).id)), 'markPaid');
    ok(await f.run('staff', 'confirmOrder', id), 'confirmOrder');
  }
  const replies = await Promise.all(orders.map((id) => f.run('warehouse', 'fulfillOrder', Number(fulfillmentOf(f, id).id))));
  const won = replies.filter((reply) => reply.status === 200);
  assert.equal(won.length, 1, `exactly one fulfillment takes the last unit: ${JSON.stringify(replies.map((r) => [r.status, r.body]))}`);
  const lost = replies.find((reply) => reply.status !== 200)!;
  // Refused, not failed: stale against the winner's write, or told the shelf is empty; nothing applied either way.
  assert.ok([409, 422].includes(lost.status), JSON.stringify(lost));
  assert.equal(lost.body.outcome, 'not_applied');
  assert.equal(levelAt(f, a.id, sec), 0);
  assert.deepEqual(orders.map((id) => fulfillmentOf(f, id).status).sort(), ['packed', 'pending']);
  assert.equal(
    Number(
      f.one(
        `SELECT count(*) AS n FROM inventory_movement WHERE variant_id = ? AND location_id = ? AND kind = 'fulfilled' AND reference IN (?, ?)`,
        a.id,
        sec,
        `#${orders[0]}`,
        `#${orders[1]}`,
      ).n,
    ),
    1,
  );
  // And the loser, tried again, is told why.
  const loser = orders.find((id) => fulfillmentOf(f, id).status === 'pending')!;
  refused(await f.run('warehouse', 'fulfillOrder', Number(fulfillmentOf(f, loser).id)), 'pack with an empty shelf', /holds 0/);
  assert.throws(
    () => f.db.prepare('UPDATE inventory_level SET on_hand = -1 WHERE variant_id = ? AND location_id = ?').run(a.id, sec),
    /CHECK/,
  );
});

test('Atelier totals: a new order prices its lines, discount, shipping and tax as the seed does, and adds up', async (t) => {
  const f = await fixture(t);
  const a = stocked(f, 3);
  const b = stocked(f, 1, [a.id]);
  const unitA = toCents(a.price_amount);
  const unitB = toCents(b.price_amount);
  const cases: {
    extra: Row;
    discount: { kind: string; percent_off: number | null; amount_off_amount: number | null; min_subtotal_amount: number } | null;
    shipping: 'standard' | 'express' | 'pickup';
    state: string;
  }[] = [
    { extra: {}, discount: null, shipping: 'standard', state: 'NY' },
    {
      extra: { shipping: 'express', discount_code: 'welcome10' },
      discount: { kind: 'percent', percent_off: 10, amount_off_amount: null, min_subtotal_amount: 0 },
      shipping: 'express',
      state: 'NY',
    },
  ];
  // A gift code with a minimum, and a pickup in Silver Lake taxed at the store's rate.
  const gift = f.one(`SELECT * FROM discount WHERE code = 'GIFT20'`);
  const silverLake = Number(f.one(`SELECT id FROM location WHERE code = 'SLVR'`).id);
  for (const c of cases) {
    const id = await newOrder(
      f,
      [
        { variant_id: a.id, quantity: 3 },
        { variant_id: b.id, quantity: 1 },
      ],
      c.extra,
    );
    const o = order(f, id);
    addsUp(o, 3 * unitA + unitB);
    const priced = priceOrder(
      [
        { quantity: 3, unitCents: unitA },
        { quantity: 1, unitCents: unitB },
      ],
      { discount: c.discount, shipping: c.shipping, state: c.state },
    );
    assert.equal(toCents(o.total_amount as number), priced.total, `#${id} priced as the rules say`);
    assert.equal(toCents(paymentOf(f, id).charge_amount as number), priced.total, 'the charge is the total');
  }
  const pickup = await f.run('staff', 'createOrder', null, {
    customer: customerIn(f, 'NY').id,
    channel: 'phone',
    location: silverLake,
    shipping: 'pickup',
    method: 'card',
    lines: [{ variant_id: a.id, quantity: 1 }],
  });
  ok(pickup, 'pickup order');
  const p = order(f, Number(f.one('SELECT max(id) AS id FROM sales_order').id));
  addsUp(p, unitA);
  assert.equal(p.ship_state, 'CA', 'a pickup is taxed where it is handed over');
  assert.equal(toCents(p.shipping_amount as number), 0);
  if (gift.active) {
    const small = await f.run('staff', 'createOrder', null, {
      customer: customerIn(f, 'NY').id,
      channel: 'online',
      location: warehouse(f),
      shipping: 'standard',
      method: 'card',
      lines: [{ variant_id: b.id, quantity: 1 }],
      discount_code: 'GIFT20',
    });
    if (unitB < toCents(gift.min_subtotal_amount as number)) refused(small, 'a code under its minimum', /subtotal/);
  }
  refused(
    await f.run('staff', 'createOrder', null, {
      customer: customerIn(f, 'NY').id,
      channel: 'online',
      location: warehouse(f),
      shipping: 'standard',
      method: 'card',
      lines: [{ variant_id: a.id, quantity: 1 }],
      discount_code: 'FRIENDS30',
    }),
    'an inactive code',
    /does not apply|not a discount/,
  );
});

test("Atelier's New order refuses a bad line at its cell, and places nothing", async (t) => {
  const f = await fixture(t);
  const a = stocked(f, 2);
  const retired = f.one(
    `SELECT v.id FROM variant v JOIN product p ON p.id = v.product_id WHERE v.active = 0 OR p.status <> 'active' ORDER BY v.id LIMIT 1`,
  );
  const orders = Number(f.one('SELECT count(*) AS n FROM sales_order').n);
  const lines = Number(f.one('SELECT count(*) AS n FROM order_line').n);
  const order = (items: unknown) =>
    f.run('staff', 'createOrder', null, {
      customer: customerIn(f, 'NY').id,
      channel: 'online',
      location: warehouse(f),
      shipping: 'standard',
      method: 'card',
      lines: items,
    });
  const at = async (items: unknown, field: string, what: string) => {
    const reply = await order(items);
    refused(reply, what);
    assert.equal(reply.body.field, field, `${what}: ${JSON.stringify(reply.body)}`);
  };
  await at(
    [
      { variant_id: a.id, quantity: 1 },
      { variant_id: a.id, quantity: 'two' },
    ],
    'lines[1].quantity',
    'a count that is not a number',
  );
  await at([{ variant_id: a.id, quantity: 21 }], 'lines[0].quantity', 'more than twenty of one');
  await at(
    [
      { variant_id: a.id, quantity: 1 },
      { variant_id: a.id, quantity: 1 },
    ],
    'lines[1].variant_id',
    'a variant on two lines',
  );
  if (retired)
    await at(
      [
        { variant_id: a.id, quantity: 1 },
        { variant_id: retired.id, quantity: 1 },
      ],
      'lines[1].variant_id',
      'a variant not for sale',
    );
  await at([], 'lines', 'an order of nothing');
  assert.equal(Number(f.one('SELECT count(*) AS n FROM sales_order').n), orders, 'no order placed');
  assert.equal(Number(f.one('SELECT count(*) AS n FROM order_line').n), lines, 'no line written');
});

test("Atelier writes a moment as New York's clock, so an evening order is not placed tomorrow", () => {
  // A timestamp column keeps no zone and is read as written, in the App's zone: 9:58 PM in New York is 01:58 UTC.
  const evening = () => new Date('2026-10-10T01:58:00Z');
  assert.equal(stamp(evening), '2026-10-09 21:58:00');
  assert.equal(day(evening), '2026-10-09');
});
