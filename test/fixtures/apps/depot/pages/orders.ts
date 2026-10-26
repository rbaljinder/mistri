import { fields, history, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* The floor's document and the customer's. A pick list reads as the walk a
   picker makes: its lines in bin order, with what was taken from where once
   it is picked. An order is the customer's: its lines, its pick list and who
   changed its priority or date. */
export const orderPages = {
  'pick-list': page(
    'pick_list',
    [
      fields(['ship_to'], { presentation: 'facts' }),
      fields(['sales_order_id.ship_by', 'sales_order_id.priority', 'warehouse_id']),
      related(
        'Pick list',
        'order_line',
        { same: ['sales_order_id'] },
        { show: ['bin_id', 'product_id.sku', 'product_id', 'qty'], sort: 'bin_id.code', limit: 50 },
      ),
      related('Picked', 'stock_movement', 'pick_list_id', {
        show: ['bin_id', 'product_id.sku', 'qty', 'bin_qty_after'],
        sort: 'bin_id.code',
        empty: 'hide',
      }),
      // Signed for at the dock, on the pad or by a typed name: wide enough to sign on a tablet.
      fields(['signature_id'], { title: 'Proof of delivery' }),
      fields(
        ['sales_order_id', 'sales_order_id.notes', 'released_at', 'picked_at', 'packed_at', 'cartons', 'shipped_at', 'carrier', 'tracking'],
        { title: 'Shipment', region: 'aside' },
      ),
      history(undefined, { limit: 6 }),
    ],
    { listTabs: true },
  ),
  'sales-order': page(
    'sales_order',
    [
      fields(['customer_id', 'ship_by', 'priority']),
      related('Lines', 'order_line', 'sales_order_id', {
        show: ['product_id.sku', 'product_id', 'qty', 'bin_id'],
        sort: 'id',
        limit: 50,
        create: { label: 'Add line', show: ['product_id', 'qty'] },
        empty: {
          title: 'No lines yet',
          description: 'Add what the customer ordered, then release the order to the floor.',
        },
      }),
      related('Pick list', 'pick_list', 'sales_order_id', {
        show: ['reference', 'status', 'shipped_at', 'tracking'],
        empty: 'hide',
      }),
      fields(['warehouse_id', 'customer_po', 'channel', 'ordered_on', 'carrier', 'lines', 'units', 'shipped_at'], {
        title: 'Order',
        region: 'aside',
      }),
      fields(['notes'], { title: 'Notes', region: 'aside', columns: 1 }),
      history(),
    ],
    { listTabs: true },
  ),
} satisfies Pages;
