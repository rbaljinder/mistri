/**
 * The payment processor's signed callback (jobs.ts `paymentSettled`): a
 * settled payment pays the charge it names once, a retried delivery replays
 * that one write, the same delivery sent again is refused as a replay, and a
 * forged or wrong one changes nothing.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

const openCharge = (skip = 0) =>
  lintel.rows<{ id: number; amount: number }>(`SELECT id, amount FROM charge WHERE status = 'open' ORDER BY id LIMIT 1 OFFSET ?`, skip)[0];
const paymentsOf = (charge: number) =>
  lintel.rows<{ reference: string; amount: number; method: string }>(
    `SELECT reference, amount, method FROM payment WHERE charge_id = ?`,
    charge,
  );

test('a settled payment pays its charge once, and a retried delivery replays it', async () => {
  const charge = openCharge();
  const body = { id: 'pay_8Kd2xQ71', status: 'succeeded', charge: charge.id, amount: charge.amount, method: 'card' };
  const signedAt = Math.floor(Date.now() / 1000);
  const first = await lintel.settle(body, undefined, signedAt);
  assert.equal(first.status, 204, await first.clone().text());
  assert.equal(lintel.rows<{ status: string }>(`SELECT status FROM charge WHERE id = ?`, charge.id)[0].status, 'paid');
  assert.deepEqual(paymentsOf(charge.id), [{ reference: 'pay_8Kd2xQ71', amount: charge.amount, method: 'card' }]);

  // The same bytes again, inside its window (a resend after a timeout, or someone who captured it): the receipt answers.
  const replayed = await lintel.settle(body, undefined, signedAt);
  assert.equal(replayed.status, 204, await replayed.clone().text());
  assert.equal(paymentsOf(charge.id).length, 1);
  // The processor did not hear back and sends it again, signed anew: the receipt answers, nothing is written twice.
  const again = await lintel.settle(body, undefined, signedAt + 1);
  assert.equal(again.status, 204, await again.clone().text());
  assert.equal(paymentsOf(charge.id).length, 1);
});

test('a forged callback is refused and pays nothing', async () => {
  const charge = openCharge();
  const forged = await lintel.settle(
    { id: 'pay_ForgedPay01', status: 'succeeded', charge: charge.id, amount: charge.amount, method: 'ach' },
    'not-the-processor-secret',
  );
  assert.equal(forged.status, 401);
  assert.equal(lintel.rows<{ status: string }>(`SELECT status FROM charge WHERE id = ?`, charge.id)[0].status, 'open');
  assert.deepEqual(paymentsOf(charge.id), []);
});

test('a callback for the wrong amount, or one that did not succeed, settles nothing', async () => {
  const charge = openCharge(1);
  const short = await lintel.settle({
    id: 'pay_ShortPay01',
    status: 'succeeded',
    charge: charge.id,
    amount: charge.amount - 1,
    method: 'ach',
  });
  assert.ok(short.status >= 400, `short answered ${short.status}`);
  const failed = await lintel.settle({ id: 'pay_FailedPay1', status: 'failed', charge: charge.id, amount: charge.amount, method: 'ach' });
  assert.ok(failed.status >= 400, `failed answered ${failed.status}`);
  assert.equal(lintel.rows<{ status: string }>(`SELECT status FROM charge WHERE id = ?`, charge.id)[0].status, 'open');
  assert.deepEqual(paymentsOf(charge.id), []);
});
