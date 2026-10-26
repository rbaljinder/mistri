import { document, fields, history, note, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* An order as the shop reads it — what was bought, what it came to, where its
   payment and its parcel stand, and anything that came back — and the three
   records that follow it, each a page of its own with its machine's verbs. */
export const orderPages = {
  'sales-order': page(
    'sales_order',
    [
      fields(['customer_id', 'financial_status', 'fulfillment_status']),
      related('Items', 'order_line', 'sales_order_id', {
        show: ['description', 'quantity', 'unit_price_amount', 'line_amount'],
        sort: 'line_no',
        totals: ['quantity', 'line_amount'],
        limit: 50,
      }),
      fields(['subtotal_amount', 'discount_code', 'discount_amount', 'shipping_amount', 'tax_amount', 'total_amount', 'refunded'], {
        title: 'Totals',
        presentation: 'properties',
      }),
      // The payment and the parcel are moved from here, each row's own verbs in its ⋯; their pages say more.
      related('Payment', 'payment', 'sales_order_id', {
        show: ['method', 'status', 'paid_amount', 'refunded_amount'],
        rowActions: true,
      }),
      related('Fulfillment', 'fulfillment', 'sales_order_id', {
        show: ['status', 'location_id', 'carrier', 'tracking_number'],
        rowActions: true,
      }),
      related('Refunds', 'refund', 'sales_order_id', {
        show: ['refunded_at', 'refund_amount', 'reason', 'refunded_by'],
        sort: 'refunded_at',
        empty: 'hide',
      }),
      related('Returns', 'order_return', 'sales_order_id', {
        show: ['id', 'status', 'reason', 'refund_amount'],
        empty: 'hide',
        rowActions: true,
      }),
      fields(['channel', 'location_id', 'shipping_method', 'ship_name', 'ship_address', 'ship_city', 'ship_state', 'ship_zip'], {
        title: 'Delivery',
        region: 'aside',
      }),
      fields(['placed_at', 'confirmed_at', 'completed_at', 'cancelled_at', 'cancel_reason', 'note'], { title: 'Order', region: 'aside' }),
      history(),
    ],
    { listTabs: true },
  ),
  payment: page('payment', [
    fields(['sales_order_id', 'paid_amount', 'refunded_amount']),
    related('Refunds', 'refund', 'payment_id', {
      show: ['refunded_at', 'refund_amount', 'reason', 'order_return_id'],
      sort: 'refunded_at',
      totals: ['refund_amount'],
      empty: {
        title: 'Nothing refunded',
        description: 'Refunds on this payment, by hand or for a return, are listed here.',
      },
    }),
    fields(['method', 'charge_amount', 'reference', 'paid_at', 'sales_order_id.customer_id'], { title: 'Payment', region: 'aside' }),
    history(),
  ]),
  fulfillment: page(
    'fulfillment',
    [
      fields(['sales_order_id', 'location_id', 'sales_order_id.shipping_method']),
      related(
        'To pack',
        'order_line',
        { same: ['sales_order_id'] },
        {
          show: ['sku', 'description', 'quantity'],
          sort: 'line_no',
          totals: ['quantity'],
          limit: 50,
        },
      ),
      related('Taken from the shelf', 'inventory_movement', 'fulfillment_id', {
        show: ['variant_id', 'location_id', 'quantity', 'on_hand_after'],
        sort: 'id',
        empty: 'hide',
      }),
      fields(
        [
          'sales_order_id.ship_name',
          'sales_order_id.ship_address',
          'sales_order_id.ship_city',
          'sales_order_id.ship_state',
          'sales_order_id.ship_zip',
        ],
        { title: 'Ship to', region: 'aside' },
      ),
      fields(['carrier', 'tracking_number', 'packed_at', 'packed_by', 'shipped_at', 'delivered_at'], {
        title: 'Progress',
        region: 'aside',
      }),
      history(undefined, { limit: 6 }),
    ],
    { listTabs: true },
  ),
  'order-return': page(
    'order_return',
    [
      fields(['sales_order_id', 'reason', 'requested_on']),
      related('Coming back', 'return_line', 'order_return_id', {
        show: ['order_line_id', 'quantity', 'restock'],
        totals: ['quantity'],
      }),
      related('Back on the shelf', 'inventory_movement', 'order_return_id', {
        show: ['variant_id', 'location_id', 'quantity', 'on_hand_after'],
        empty: 'hide',
      }),
      fields(['sales_order_id.customer_id', 'location_id', 'received_at', 'refund_amount', 'note'], { title: 'Return', region: 'aside' }),
      history(undefined, { limit: 6 }),
    ],
    { listTabs: true },
  ),
  /* The order on paper: More → Invoice on an order, at /atelier/orders/<id>/invoice. The shop's
     own lines head it; the reader's grants decide what it shows, as on the order's page. */
  invoice: document(
    'sales_order',
    [
      fields(['customer_id', 'customer_id.email'], {
        title: 'Billed to',
        presentation: 'facts',
        width: 'third',
      }),
      fields(['ship_name', 'ship_address', 'ship_city', 'ship_state', 'ship_zip'], {
        title: 'Ship to',
        presentation: 'facts',
        width: 'third',
      }),
      /* The order's note, where it has one, under its caption at the column's width: a sentence is read, not
         squeezed beside a label. */
      fields(['placed_at', 'shipping_method', 'financial_status', 'note'], {
        presentation: 'properties',
        width: 'third',
      }),
      related('Items', 'order_line', 'sales_order_id', {
        show: ['sku', 'description', 'quantity', 'unit_price_amount', 'line_amount'],
        sort: 'line_no',
      }),
      note(
        'Thank you for shopping with Atelier. Returns are accepted within 30 days of delivery.\n\nQuestions about this order? Write to orders@atelier.example and quote its number.',
        {
          variant: 'quiet',
          width: 'half',
        },
      ),
      fields(['subtotal_amount', 'discount_amount', 'shipping_amount', 'tax_amount', 'total_amount'], {
        presentation: 'table',
        width: 'half',
      }),
    ],
    {
      label: 'Invoice',
      number: 'id',
      description: 'Atelier Goods Co.\n214 Alder Street, Portland, OR 97204\norders@atelier.example',
    },
  ),
  /* What goes in the box: the lines to pick, without a price, and where it goes. */
  'packing-slip': document(
    'fulfillment',
    [
      fields(
        [
          'sales_order_id.ship_name',
          'sales_order_id.ship_address',
          'sales_order_id.ship_city',
          'sales_order_id.ship_state',
          'sales_order_id.ship_zip',
        ],
        { title: 'Ship to', presentation: 'facts', width: 'half' },
      ),
      fields(['sales_order_id', 'location_id', 'sales_order_id.shipping_method', 'carrier'], { presentation: 'properties', width: 'half' }),
      // The parcel is the order's lines: the order lines that share this fulfillment's order.
      related(
        'In this parcel',
        'order_line',
        { same: ['sales_order_id'] },
        { show: ['sku', 'description', 'quantity'], sort: 'line_no', totals: ['quantity'] },
      ),
      note('Something not right? Reply to your order email within 30 days and we will make it right.', { variant: 'quiet' }),
    ],
    {
      label: 'Packing slip',
      number: 'sales_order_id',
      description: 'Atelier Goods Co.\n214 Alder Street, Portland, OR 97204',
    },
  ),
} satisfies Pages;
