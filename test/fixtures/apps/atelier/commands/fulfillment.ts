/* The fulfillment machine's verbs: picked and packed (the units leave the
   shelf of the location it ships from, into the ledger), shipped with a
   carrier and tracking number, delivered — which completes a paid order. */
import { defineCommand, field, refuse } from '@mistriwork/mistri/commands';
import { by, moveStock, plural, said, source, stamp } from './shared.ts';

/* Only a confirmed, paid order is packed, and only from stock that is there:
   each line takes its units off the shelf, and a line the shelf cannot cover
   refuses the whole pack, with nothing moved. */
export const fulfillOrder = defineCommand({
  source,
  target: 'fulfillment',
  read: ['sales_order', 'order_line', 'variant', 'location', 'payment'],
  write: ['inventory_level', 'inventory_movement'],
  output: said,
  async handle({ db, record, actor, now }) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    if (order.status !== 'confirmed') refuse(`Order #${order.id} is ${order.status}; confirm it before it is packed.`);
    const payment = (await db.payment.find({ sales_order_id: order.id })) ?? refuse(`Order #${order.id} has no payment.`);
    if (payment.status !== 'paid') refuse(`Order #${order.id} is not paid; an unpaid order stays on the shelf.`);
    const location = await db.location.get({ id: record.location_id });
    const lines = await db.order_line.where({ sales_order_id: order.id }).orderBy('line_no').limit(50);
    const when = stamp(now);
    let units = 0;
    for (const line of lines) {
      const variant = await db.variant.get({ id: line.variant_id });
      await moveStock(db, when, {
        kind: 'fulfilled',
        variant,
        location,
        quantity: -line.quantity,
        reference: `#${order.id}`,
        by: by(actor),
        fulfillment_id: record.id,
      });
      units += line.quantity;
    }
    await db.fulfillment.update(record, { status: 'packed', packed_at: when, packed_by: by(actor) });
    return { message: `Order #${order.id} is packed at ${location.code}: ${plural(units, 'unit')} off the shelf.` };
  },
});

export const shipFulfillment = defineCommand({
  source,
  target: 'fulfillment',
  input: {
    carrier: field.choice(['UPS', 'USPS', 'FedEx', 'DHL', 'Pickup']),
    tracking_number: field.text({ max: 40, optional: true, help: 'Every carrier but a pickup.' }),
  },
  read: ['sales_order'],
  output: said,
  async initial({ db, record }) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    return { carrier: order.shipping_method === 'pickup' ? 'Pickup' : order.shipping_method === 'express' ? 'FedEx' : 'UPS' };
  },
  async handle({ db, record, now }, input) {
    const order = await db.sales_order.get({ id: record.sales_order_id });
    if (input.carrier !== 'Pickup' && !input.tracking_number)
      refuse(`A parcel by ${input.carrier} needs its tracking number.`, { field: 'tracking_number' });
    if ((input.carrier === 'Pickup') !== (order.shipping_method === 'pickup'))
      refuse(
        order.shipping_method === 'pickup'
          ? `Order #${order.id} is collected in store.`
          : `Order #${order.id} ships ${order.shipping_method}.`,
      );
    await db.fulfillment.update(record, {
      status: 'shipped',
      carrier: input.carrier,
      tracking_number: input.tracking_number ?? null,
      shipped_at: stamp(now),
    });
    return {
      message:
        input.carrier === 'Pickup' ? `Order #${order.id} is ready to collect.` : `Order #${order.id} is on its way by ${input.carrier}.`,
    };
  },
});

/* Delivered (or collected): a paid order is complete with it. */
export const deliverFulfillment = defineCommand({
  source,
  target: 'fulfillment',
  read: ['payment'],
  write: ['sales_order'],
  output: said,
  async handle({ db, record, now }) {
    const when = stamp(now);
    const order = await db.sales_order.get({ id: record.sales_order_id });
    const payment = (await db.payment.find({ sales_order_id: order.id })) ?? refuse(`Order #${order.id} has no payment.`);
    await db.fulfillment.update(record, { status: 'delivered', delivered_at: when });
    const complete = order.status === 'confirmed' && payment.status !== 'pending' && payment.status !== 'voided';
    if (complete) await db.sales_order.update(order, { status: 'completed', completed_at: when });
    return { message: `Order #${order.id} is delivered${complete ? ' and complete' : ''}.` };
  },
});
