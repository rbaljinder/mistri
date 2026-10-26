/* Stock that moves outside an order: a delivery from a maker received onto a
   shelf, and a shelf counted and set right. Each is one line of the ledger. */
import { defineCommand, field, refuse } from '@mistriwork/mistri/commands';
import { by, moveStock, said, source, stamp } from './shared.ts';

export const receiveStock = defineCommand({
  source,
  target: 'inventory_level',
  input: {
    quantity: field.number({ integer: true, min: 1, max: 10000, label: 'Units received' }),
    reference: field.text({ max: 40, label: 'Delivery', help: 'The maker’s packing slip or purchase order number.' }),
  },
  read: ['variant', 'location'],
  write: ['inventory_movement'],
  output: said,
  async handle({ db, record, actor, now }, input) {
    const variant = await db.variant.get({ id: record.variant_id });
    const location = await db.location.get({ id: record.location_id });
    const after = await moveStock(db, stamp(now), {
      kind: 'received',
      variant,
      location,
      quantity: input.quantity,
      reference: input.reference,
      by: by(actor),
    });
    return { message: `Received ${input.quantity} × ${variant.sku} at ${location.code}; it holds ${after}.` };
  },
});

export const adjustStock = defineCommand({
  source,
  target: 'inventory_level',
  input: {
    quantity: field.number({ integer: true, min: 0, max: 10000, label: 'Units on the shelf', default: { record: 'on_hand' } }),
    reason: field.choice(['Damaged on the floor', 'Short at the count', 'Found at the count', 'Used for a photo shoot', 'Correction']),
    note: field.textarea({ max: 300, optional: true }),
  },
  read: ['variant', 'location'],
  write: ['inventory_movement'],
  output: said,
  async handle({ db, record, actor, now }, input) {
    const variant = await db.variant.get({ id: record.variant_id });
    const location = await db.location.get({ id: record.location_id });
    const change = input.quantity - Number(record.on_hand);
    if (!change)
      refuse(`${location.code} already holds ${input.quantity} of ${variant.sku}; there is nothing to adjust.`, { field: 'quantity' });
    if (input.reason === 'Found at the count' && change < 0)
      refuse('Found stock adds to the shelf; this takes away. Choose another reason.', { field: 'reason' });
    if (input.reason !== 'Found at the count' && input.reason !== 'Correction' && change > 0)
      refuse(`${input.reason} takes from the shelf; this adds to it. Choose another reason.`, { field: 'reason' });
    await moveStock(db, stamp(now), {
      kind: 'adjusted',
      variant,
      location,
      quantity: change,
      reference: 'Stock count',
      reason: input.note ? `${input.reason}: ${input.note}` : input.reason,
      by: by(actor),
    });
    return { message: `${location.code} now holds ${input.quantity} of ${variant.sku} (${change > 0 ? '+' : ''}${change}).` };
  },
});
