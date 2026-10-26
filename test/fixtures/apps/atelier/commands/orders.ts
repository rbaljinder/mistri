/* An order from a customer, priced by pricing.ts — the same rules the seed
   priced six months of orders with — and the order machine's own verbs. */
import { defineCommand, field, refuse } from '@mistriwork/mistri/commands';
import { dollars, priceOrder, toAmount, toCents, type DiscountRule, type ShippingMethod } from '../pricing.ts';
import { day, made, plural, said, source, stamp } from './shared.ts';

/* Taken at the counter, on the phone or for an online customer: lines of
   variants, a discount code if there is one, and how it ships. The order
   starts open, its payment pending and its fulfillment waiting at the
   location it ships from. */
export const createOrder = defineCommand({
  source,
  target: 'sales_order',
  targets: 'none',
  input: {
    customer: field.reference('customer', { by: 'id', labelColumn: 'name' }),
    channel: field.choice(['phone', 'store', 'online'], { default: 'phone' }),
    location: field.reference('location', {
      by: 'id',
      labelColumn: 'name',
      query: 'active = true',
      label: 'Ships from',
      help: 'The warehouse for a delivery; the store for a sale at the counter or a pickup.',
    }),
    shipping: field.choice(
      [
        { value: 'standard', label: 'Standard ($8, free from $150)' },
        { value: 'express', label: 'Express ($18)' },
        { value: 'pickup', label: 'Pickup in store' },
      ],
      { default: 'standard' },
    ),
    // The order's items as the lines grid asks them: a variant and how many, its price shown as it is picked.
    // The handler prices each line from the variant again; the price on screen is only the form's preview.
    lines: field.lines('order_line', {
      label: 'Products',
      show: ['variant_id', 'quantity'],
      copy: { unit_price_amount: 'variant_id.price_amount' },
      // The picker offers what is for sale; the handler still refuses anything else sent.
      query: { variant_id: 'active = true and product_id.status = active' },
      min: 1,
      max: 20,
      description: 'Discount, shipping and tax are added when the order is placed.',
    }),
    discount_code: field.text({ max: 40, optional: true, case: 'upper' }),
    method: field.choice(
      [
        { value: 'card', label: 'Card' },
        { value: 'apple_pay', label: 'Apple Pay' },
        { value: 'paypal', label: 'PayPal' },
        { value: 'cash', label: 'Cash' },
        { value: 'gift_card', label: 'Gift card' },
      ],
      { label: 'Paid with', default: 'card' },
    ),
    note: field.textarea({ max: 500, optional: true }),
  },
  read: ['customer', 'location', 'discount', 'variant', 'product'],
  write: ['order_line', 'payment', 'fulfillment'],
  output: made,
  async handle({ db, now }, input) {
    const customer = await db.customer.get({ id: Number(input.customer) });
    const location = await db.location.get({ id: Number(input.location) });
    const shipping = input.shipping as ShippingMethod;
    if (!location.active) refuse(`${location.name} is closed.`);
    if (shipping === 'pickup' && location.kind !== 'store') refuse('A pickup is collected at a store: choose SoHo or Silver Lake.');
    if (shipping !== 'pickup' && input.channel !== 'store' && !location.ships_online)
      refuse(`${location.name} does not ship parcels; deliveries go out from the warehouse.`);
    if (input.channel === 'store' && location.kind !== 'store') refuse('A sale at the counter is made in a store.');

    const seen = new Set<number>();
    const lines = [];
    for (const [i, line] of input.lines.entries()) {
      // A refusal names the line's cell, so the grid marks it and nothing is written.
      const at = (column: 'variant_id' | 'quantity') => ({ field: `lines[${i}].${column}` });
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20)
        refuse('A line takes a whole number from 1 to 20.', at('quantity'));
      const variant = (await db.variant.find({ id: line.variant_id })) ?? refuse('Choose a variant.', at('variant_id'));
      const product = await db.product.get({ id: variant.product_id });
      if (product.status !== 'active' || !variant.active) refuse(`${variant.sku} is not for sale.`, at('variant_id'));
      if (seen.has(variant.id)) refuse(`${variant.sku} is on two lines; put its whole quantity on one.`, at('variant_id'));
      seen.add(variant.id);
      lines.push({ variant, product, quantity: line.quantity, unitCents: toCents(variant.price_amount) });
    }

    let discount: { id: number; code: string; rule: DiscountRule } | null = null;
    if (input.discount_code) {
      const code = input.discount_code.trim().toUpperCase();
      const row = await db.discount.find({ code });
      const today = day(now);
      if (!row || !row.active || row.starts_on > today || (row.ends_on !== null && row.ends_on < today))
        refuse(`${code} is not a discount that applies today.`);
      if (row.usage_limit !== null && (await db.sales_order.count({ discount_id: row.id })) >= Number(row.usage_limit))
        refuse(`${code} has been used as many times as it may be.`);
      discount = { id: row.id, code: row.code, rule: row };
    }
    // Tax follows the goods: where they ship, or the store they are handed over in.
    const state = shipping === 'pickup' || input.channel === 'store' ? location.state : customer.state;
    const priced = priceOrder(lines, { discount: discount?.rule ?? null, shipping, state });
    if (discount && !priced.discount)
      refuse(`${discount.code} needs a subtotal of ${dollars(toCents(discount.rule.min_subtotal_amount))}.`);

    const order = await db.sales_order.insert({
      customer_id: customer.id,
      location_id: location.id,
      channel: input.channel,
      placed_at: stamp(now),
      status: 'open',
      shipping_method: shipping,
      ship_name: customer.name,
      ship_address: shipping === 'pickup' ? null : customer.address,
      ship_city: shipping === 'pickup' ? location.city : customer.city,
      ship_state: state,
      ship_zip: shipping === 'pickup' ? null : customer.zip,
      discount_id: discount?.id ?? null,
      discount_code: discount?.code ?? null,
      subtotal_amount: toAmount(priced.subtotal),
      discount_amount: toAmount(priced.discount),
      shipping_amount: toAmount(priced.shipping),
      tax_rate: String(priced.taxRate),
      tax_amount: toAmount(priced.tax),
      total_amount: toAmount(priced.total),
      note: input.note ?? null,
    });
    let lineNo = 0;
    for (const line of lines)
      await db.order_line.insert({
        sales_order_id: order.id,
        line_no: ++lineNo,
        variant_id: line.variant.id,
        sku: line.variant.sku,
        description: `${line.product.title} · ${line.variant.color}${line.variant.size === 'One size' ? '' : ` / ${line.variant.size}`}`,
        quantity: line.quantity,
        unit_price_amount: line.variant.price_amount,
        line_amount: toAmount(line.quantity * line.unitCents),
      });
    await db.payment.insert({ sales_order_id: order.id, method: input.method, status: 'pending', charge_amount: toAmount(priced.total) });
    await db.fulfillment.insert({
      sales_order_id: order.id,
      location_id: location.id,
      status: 'pending',
    });
    return {
      reference: `#${order.id}`,
      message: `Order #${order.id} for ${customer.name}: ${plural(lines.length, 'line')}, ${dollars(priced.total)}.`,
    };
  },
});

/* Confirmed: the shop has accepted it, and once paid it may be packed. */
export const confirmOrder = defineCommand({
  source,
  target: 'sales_order',
  read: ['order_line'],
  output: said,
  async handle({ db, record, now }) {
    if (!(await db.order_line.count({ sales_order_id: record.id }))) refuse(`Order #${record.id} has no lines.`);
    await db.sales_order.update(record, { status: 'confirmed', confirmed_at: stamp(now) });
    return { message: `Order #${record.id} is confirmed.` };
  },
});

/* Completed by hand where its delivery did not complete it: paid and delivered. */
export const completeOrder = defineCommand({
  source,
  target: 'sales_order',
  read: ['payment', 'fulfillment'],
  // Offered once the parcel has arrived; the handler still checks the payment.
  when: 'fulfillment_status = delivered',
  output: said,
  async handle({ db, record, now }) {
    const fulfillment = (await db.fulfillment.find({ sales_order_id: record.id })) ?? refuse(`Order #${record.id} has no fulfillment.`);
    if (fulfillment.status !== 'delivered') refuse(`Order #${record.id} is ${fulfillment.status}, not yet delivered.`);
    const payment = (await db.payment.find({ sales_order_id: record.id })) ?? refuse(`Order #${record.id} has no payment.`);
    if (payment.status === 'pending') refuse(`Order #${record.id} is not paid yet.`);
    await db.sales_order.update(record, { status: 'completed', completed_at: stamp(now) });
    return { message: `Order #${record.id} is complete.` };
  },
});

export const cancelOrder = defineCommand({
  source,
  target: 'sales_order',
  input: { reason: field.textarea({ max: 300, label: 'Why', help: 'Kept on the order.' }) },
  // Its pending payment is voided and its pending parcel cancelled with it, by their machines (orders.ts).
  write: ['payment', 'fulfillment'],
  // Not offered once the units have left the shelf: those come back as a return.
  when: 'fulfillment_status = pending or fulfillment_status = cancelled',
  output: said,
  async handle({ db, record, now }, input) {
    // Money taken is refunded first: cancelling never decides a refund on its own.
    const payment = await db.payment.find({ sales_order_id: record.id });
    if (payment?.status === 'paid' || payment?.status === 'partially_refunded')
      refuse(
        `Order #${record.id} has ${payment.status === 'paid' ? 'been paid' : 'money still paid on it'}; refund the payment first, then cancel.`,
      );
    const refunded = payment?.status === 'refunded';
    await db.sales_order.update(record, {
      status: 'cancelled',
      cancelled_at: stamp(now),
      cancel_reason: input.reason,
    });
    return { message: `Order #${record.id} is cancelled, ${refunded ? 'its payment was already refunded' : 'its payment voided'}.` };
  },
});
