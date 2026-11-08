/**
 * Records and a carrier's API: the storeroom's deliveries are Lintel's rows, and the tracking beside them is the
 * carrier's (examples/databases/lintel/carrier), a second source read over HTTP. The office reads it; a resident
 *  is refused it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

test("staff read a delivery's tracking through the App, from the carrier", async () => {
  const [delivery] = lintel.rows<{ tracking_number: string }>(`SELECT tracking_number FROM part_receipt ORDER BY received_on LIMIT 1`);
  assert.match(delivery.tracking_number, /^NB\d{10}$/);
  for (const role of ['manager', 'leasing', 'technician'] as const) {
    const staff = await lintel.as(role);
    const tracking = await staff.rows('carrier.shipments', { where: `tracking_number = ${delivery.tracking_number}` });
    assert.ok(tracking.ok, `${role}: ${JSON.stringify(tracking)}`);
    assert.equal(tracking.value.length, 1);
    assert.equal(tracking.value[0].tracking_number, delivery.tracking_number);
    assert.equal(tracking.value[0].status, 'delivered');
  }
});

test('every delivery has a shipment, and the carrier says what is still on its way', async () => {
  const numbers = lintel.rows<{ tracking_number: string }>(`SELECT tracking_number FROM part_receipt`).map((row) => row.tracking_number);
  assert.equal(numbers.length, 6);
  const manager = await lintel.as('manager');
  const all = await manager.rows('carrier.shipments', { limit: 50 });
  assert.ok(all.ok, JSON.stringify(all));
  const known = new Set(all.value.map((row) => String(row.tracking_number)));
  for (const number of numbers) assert.ok(known.has(number), `${number} is a shipment`);
  const coming = await manager.rows('carrier.shipments', { where: 'status = in_transit' });
  assert.ok(coming.ok && coming.value.length === 1, JSON.stringify(coming));
});

test("a resident is refused the carrier's tracking, and so is the accountant and a visitor", async () => {
  const refused = async (client: Awaited<ReturnType<Lintel['as']>>) => {
    const answer = await client.rows('carrier.shipments', { limit: 5 });
    assert.equal(answer.ok, false, 'the read was refused');
  };
  await refused(await lintel.as('resident'));
  await refused(await lintel.as('accountant'));
  await refused(lintel.anonymous());
});

test("the delivery board is offered to the storeroom's roles, and only to a role granted every read it declares and named by its `roles`", async () => {
  const offered = async (client: Awaited<ReturnType<Lintel['as']>>) => {
    const reply = await client.request('/api/app?app=lintel');
    const { app } = (await reply.json()) as { app: { views: Record<string, unknown> } };
    return 'delivery-board' in app.views;
  };
  for (const role of ['manager', 'admin', 'technician'] as const) assert.equal(await offered(await lintel.as(role)), true, role);
  // Leasing is granted both reads but is not the storeroom's role; the accountant and a resident lack the carrier's.
  for (const role of ['leasing', 'accountant', 'resident'] as const) assert.equal(await offered(await lintel.as(role)), false, role);
});
