import { fields, page, related } from '@mistriwork/mistri/app';

export const orderPage = page(
  'purchase_order',
  [
    fields(['reference', 'status', 'vendor_id', 'buyer_id', 'shipping_location_id', 'expected_on'], { columns: 3 }),
    fields(['name', 'ordered_on'], {
      columns: 2,
    }),
    related('Order lines', 'order_line', 'order_id', {
      create: {
        label: 'Add order line',
        show: ['name', 'request_item_id', 'quantity', 'unit_price'],
      },
      show: ['name', 'request_item_id.request_id.name', 'quantity', 'unit_price', 'received_quantity'],
    }),
    related('Vendor orders', 'purchase_order', { same: ['vendor_id'] }, { show: ['reference', 'name', 'status', 'expected_on'] }),
  ],
  { listTabs: true },
);
