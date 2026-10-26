/* The payment machine's verbs. Atelier takes no money itself: marking a
   payment paid records a charge the card terminal or the online checkout
   made, and a refund records money given back the same way. A refund never
   exceeds what was paid and not yet refunded — refused here first, and the
   table's CHECK (refunded_amount <= paid_amount) is the last word. */
import { defineCommand, field, refuse, type WriteTable } from '@mistriwork/mistri/commands';
import type { Rows } from '../mistri-schema.d.ts';
import { dollars, toAmount, toCents } from '../pricing.ts';
import { by, said, source, stamp } from './shared.ts';

export const markPaid = defineCommand({
  source,
  target: 'payment',
  input: { reference: field.text({ max: 60, optional: true, help: 'The terminal’s or the checkout’s charge ID.' }) },
  read: ['sales_order'],
  output: said,
  async handle({ db, record, now }, input) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    if (order.status === 'cancelled') refuse(`Order #${order.id} is cancelled; it takes no payment.`);
    await db.payment.update(record, {
      status: 'paid',
      paid_amount: record.charge_amount,
      paid_at: stamp(now),
      reference: input.reference ?? record.reference,
    });
    return { message: `${dollars(toCents(record.charge_amount))} paid on order #${order.id}.` };
  },
});

type RefundDb = {
  payment: WriteTable<Rows['payment']>;
  refund: WriteTable<Rows['refund']>;
};

/**
 * Money given back on a payment: the refund's row and the payment's refunded
 * amount and state, together — the order reads its payment's state where it
 * is written (orders.ts `latest`). Returns the amount still refundable after it.
 */
export async function giveBack(
  db: RefundDb,
  payment: Rows['payment'],
  cents: number,
  m: { reason: string; when: string; by: string | null; order_return_id?: number | null; field?: string },
): Promise<number> {
  // A refund typed by hand is told beside its amount; a return's refund has no amount to point at.
  const at = m.field ? { field: m.field } : undefined;
  const paid = toCents(payment.paid_amount);
  const refunded = toCents(payment.refunded_amount);
  if (payment.status !== 'paid' && payment.status !== 'partially_refunded')
    refuse(`The payment on order #${payment.sales_order_id} is ${payment.status}; only money paid is refunded.`);
  if (cents <= 0) refuse('A refund gives back more than nothing.', at);
  if (cents > paid - refunded)
    refuse(
      `Only ${dollars(paid - refunded)} of the ${dollars(paid)} paid on order #${payment.sales_order_id} is left to refund, not ${dollars(cents)}.`,
      at,
    );
  const total = refunded + cents;
  const status = total === paid ? 'refunded' : 'partially_refunded';
  await db.refund.insert({
    payment_id: payment.id,
    sales_order_id: payment.sales_order_id,
    order_return_id: m.order_return_id ?? null,
    refund_amount: toAmount(cents),
    reason: m.reason,
    refunded_at: m.when,
    refunded_by: m.by,
  });
  await db.payment.update(payment, { refunded_amount: toAmount(total), ...(status === payment.status ? {} : { status }) });
  return paid - total;
}

/* A refund by hand: a goodwill credit, a price match, an order called off after it was paid. */
export const refundPayment = defineCommand({
  source,
  target: 'payment',
  input: {
    amount: field.money({ min: 0.01, help: 'At most what was paid and not yet refunded.' }),
    reason: field.textarea({ max: 300, label: 'Why' }),
  },
  write: ['refund'],
  output: said,
  async initial({ record }) {
    return { amount: (toCents(record.paid_amount) - toCents(record.refunded_amount)) / 100 };
  },
  async handle({ db, record, actor, now }, input) {
    const cents = Math.round(input.amount * 100);
    const left = await giveBack(db, record, cents, { reason: input.reason, when: stamp(now), by: by(actor), field: 'amount' });
    return {
      message: `Refunded ${dollars(cents)} on order #${record.sales_order_id}${left ? `; ${dollars(left)} is still refundable` : ', the whole payment'}.`,
    };
  },
});
