/* Returns: asked for on a delivered order, approved or rejected, received
   at a location — the units fit to sell go back on its shelf, into the
   ledger — and refunded at what the goods were worth on the order, never
   more than is left of the payment. */
import { defineCommand, field, refuse } from '@mistriwork/mistri/commands';
import { dollars, returnCents, toCents } from '../pricing.ts';
import { giveBack } from './payments.ts';
import { by, made, moveStock, plural, said, source, stamp, day } from './shared.ts';

const REASONS = [
  { value: 'too_small', label: 'Too small' },
  { value: 'too_large', label: 'Too large' },
  { value: 'not_as_pictured', label: 'Not as pictured' },
  { value: 'changed_mind', label: 'Changed their mind' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'arrived_late', label: 'Arrived late' },
] as const;

/* Started on the order: its lines are filled in, each at its whole quantity,
   to be trimmed to what is coming back. */
export const requestReturn = defineCommand({
  source,
  target: 'sales_order',
  input: {
    reason: field.choice(REASONS),
    lines: field.group(
      {
        // The picker offers this order's lines; the handler still refuses another order's, which an API caller can send.
        line: field.reference('order_line', {
          by: 'id',
          labelColumn: 'description',
          label: 'Item',
          query: 'sales_order_id = record.id',
        }),
        quantity: field.number({ integer: true, min: 1, max: 20 }),
      },
      { repeat: { min: 1, max: 20 } },
    ),
    note: field.textarea({ max: 300, optional: true }),
  },
  read: ['order_line', 'return_line', 'fulfillment'],
  write: ['order_return', 'return_line'],
  when: 'fulfillment_status = delivered',
  output: made,
  async initial({ db, record }) {
    const lines = await db.order_line.where({ sales_order_id: record.id }).orderBy('line_no').limit(50);
    return { lines: lines.map((line) => ({ line: line.id, quantity: line.quantity })) };
  },
  async handle({ db, record, now }, input) {
    const seen = new Set<number>();
    const lines = [];
    for (const wanted of input.lines) {
      const line = await db.order_line.get({ id: Number(wanted.line) });
      if (line.sales_order_id !== record.id) refuse(`${line.sku} is not on order #${record.id}.`);
      if (seen.has(line.id)) refuse(`${line.sku} is on two lines of the return.`);
      seen.add(line.id);
      // What earlier returns already took back, unless they were turned down.
      const earlier = await db.return_line.where({ order_line_id: line.id }).limit(50);
      let back = 0;
      for (const prior of earlier) {
        const ret = await db.order_return.get({ id: prior.order_return_id });
        if (ret.status !== 'rejected') back += prior.quantity;
      }
      if (wanted.quantity > line.quantity - back)
        refuse(
          `Only ${line.quantity - back} of ${line.sku} ${line.quantity - back === 1 ? 'is' : 'are'} left to return on order #${record.id}.`,
          { field: `lines[${lines.length}].quantity` },
        );
      lines.push({ line, quantity: wanted.quantity });
    }
    const ret = await db.order_return.insert({
      sales_order_id: record.id,
      status: 'requested',
      reason: input.reason,
      requested_on: day(now),
      note: input.note ?? null,
    });
    for (const { line, quantity } of lines)
      await db.return_line.insert({
        order_return_id: ret.id,
        order_line_id: line.id,
        quantity,
        // A damaged piece is written off, not sold again.
        restock: input.reason !== 'damaged',
      });
    return {
      reference: `Return ${ret.id}`,
      message: `Return ${ret.id} on order #${record.id}: ${plural(lines.length, 'line')}, awaiting approval.`,
    };
  },
});

export const approveReturn = defineCommand({
  source,
  target: 'order_return',
  output: said,
  async handle({ db, record }) {
    await db.order_return.update(record, { status: 'approved' });
    return { message: `Return ${record.id} is approved; the customer can send it back.` };
  },
});

export const rejectReturn = defineCommand({
  source,
  target: 'order_return',
  input: { note: field.textarea({ max: 300, label: 'Why', help: 'Kept on the return.' }) },
  output: said,
  async handle({ db, record }, input) {
    await db.order_return.update(record, { status: 'rejected', note: input.note });
    return { message: `Return ${record.id} is rejected.` };
  },
});

/* In through the door: the units fit to sell go back on that location's shelf. */
export const receiveReturn = defineCommand({
  source,
  target: 'order_return',
  input: {
    location: field.reference('location', { by: 'id', labelColumn: 'name', query: 'active = true', label: 'Received at' }),
  },
  read: ['return_line', 'order_line', 'variant', 'location'],
  write: ['inventory_level', 'inventory_movement'],
  output: said,
  async initial({ db }) {
    const warehouse = await db.location.find({ kind: 'warehouse' });
    return warehouse ? { location: warehouse.id } : {};
  },
  async handle({ db, record, actor, now }, input) {
    const location = await db.location.get({ id: Number(input.location) });
    const lines = await db.return_line.where({ order_return_id: record.id }).limit(50);
    const when = stamp(now);
    let back = 0;
    for (const line of lines) {
      if (!line.restock) continue;
      const ordered = await db.order_line.get({ id: line.order_line_id });
      const variant = await db.variant.get({ id: ordered.variant_id });
      await moveStock(db, when, {
        kind: 'returned',
        variant,
        location,
        quantity: line.quantity,
        reference: `Return ${record.id}`,
        by: by(actor),
        order_return_id: record.id,
      });
      back += line.quantity;
    }
    await db.order_return.update(record, { status: 'received', location_id: location.id, received_at: when });
    return {
      message: `Return ${record.id} is in at ${location.code}; ${back ? `${plural(back, 'unit')} back on the shelf` : 'nothing goes back on the shelf'}.`,
    };
  },
});

/* What the goods were worth on the order (their share after its discount, with tax), capped at what is left of the payment. */
export const refundReturn = defineCommand({
  source,
  target: 'order_return',
  read: ['return_line', 'order_line', 'sales_order'],
  write: ['payment', 'refund'],
  output: said,
  async handle({ db, record, actor, now }) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    const payment = (await db.payment.find({ sales_order_id: order.id })) ?? refuse(`Order #${order.id} has no payment.`);
    const lines = await db.return_line.where({ order_return_id: record.id }).limit(50);
    const priced = [];
    for (const line of lines) {
      const sold = await db.order_line.get({ id: line.order_line_id });
      priced.push({ quantity: line.quantity, unit_price_amount: sold.unit_price_amount });
    }
    const worth = returnCents(
      { subtotal: toCents(order.subtotal_amount), discount: toCents(order.discount_amount), taxRate: Number(order.tax_rate) },
      priced,
    );
    const left = toCents(payment.paid_amount) - toCents(payment.refunded_amount);
    if (left <= 0) refuse(`Nothing is left to refund on order #${order.id}.`);
    const cents = Math.min(worth, left);
    await giveBack(db, payment, cents, { reason: `Return ${record.id}`, when: stamp(now), by: by(actor), order_return_id: record.id });
    await db.order_return.update(record, { status: 'refunded', refund_amount: (cents / 100).toFixed(2) });
    return { message: `Refunded ${dollars(cents)} for return ${record.id} on order #${order.id}.` };
  },
});
