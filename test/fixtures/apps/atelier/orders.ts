import { action, computed, count, latest, machine, sum } from '@mistriwork/mistri/app';

/* An order and the three records that follow it, each with its own machine:
   the order itself (open → confirmed → completed, or cancelled), its payment
   (pending → paid → partly or wholly refunded, or voided) and its
   fulfillment (pending → packed → shipped → delivered, or cancelled); and a
   return, its own record with its own walk. Every verb is a command
   (commands/), so the server takes no change of state that is not one of
   these edges.

   The order reads where the other two machines stand, `financial_status`
   and `fulfillment_status`, for its lists, tabs, charts and commands' `when`:
   each the newest payment's or fulfillment's own status (a `latest` rollup),
   read where it is written, so there is no copy on the order to keep in step. */

const usd = { format: 'money' } as const;
const units = { format: 'number' } as const;

const financial = {
  tone: { pending: 'warn', paid: 'good', partially_refunded: 'info', refunded: 'neutral', voided: 'neutral' },
  icons: {
    pending: 'hourglass',
    paid: 'check-circle',
    partially_refunded: 'arrow-circle-up',
    refunded: 'arrow-circle-up',
    voided: 'x-circle',
  },
  values: { partially_refunded: 'Partly refunded' },
} as const;
const parcel = {
  tone: { packed: 'info', shipped: 'info', delivered: 'good', cancelled: 'neutral' },
  icons: { packed: 'package', shipped: 'truck', delivered: 'check-circle', cancelled: 'x-circle' },
} as const;
const fulfillmentStatus = {
  tone: { ...parcel.tone, pending: 'warn' },
  icons: { ...parcel.icons, pending: 'clock' },
} as const;

export const orderResources = {
  sales_order: {
    segments: {
      open_orders: { query: 'status = open or status = confirmed', label: 'Open' },
      to_confirm: 'status = open',
      unpaid: 'financial_status = pending and status != cancelled',
      to_pack: 'status = confirmed and financial_status = paid and fulfillment_status = pending',
      in_transit: 'fulfillment_status = shipped',
      completed_orders: { query: 'status = completed', label: 'Completed' },
      cancelled_orders: { query: 'status = cancelled', label: 'Cancelled' },
      // Every order that still counts: what a customer has spent and a discount has given.
      live: 'status != cancelled',
    },
    access: 'write',
    favorite: true,
    recordLabel: '#{id} · {customer_id.name}',
    noun: 'order',
    rollups: {
      lines: count('order_line'),
      units: sum('order_line', 'quantity'),
      refunded: sum('refund', 'refund_amount'),
      returns: count('order_return'),
      financial_status: latest('payment', 'status'),
      fulfillment_status: latest('fulfillment', 'status'),
    },
    display: {
      status: {
        tone: { open: 'warn', confirmed: 'info', completed: 'good', cancelled: 'neutral' },
        icons: { open: 'circle-dashed', confirmed: 'calendar-check', completed: 'check-circle', cancelled: 'x-circle' },
      },
      financial_status: financial,
      fulfillment_status: fulfillmentStatus,
      channel: { icons: { online: 'globe', store: 'storefront', phone: 'phone' } },
      refunded: usd,
      units,
      placed_at: { format: 'relative' },
    },
    labels: {
      id: 'Order',
      location_id: 'Sold from',
      status: 'Order',
      financial_status: 'Payment',
      fulfillment_status: 'Fulfillment',
      subtotal_amount: 'Subtotal',
      discount_amount: 'Discount',
      shipping_amount: 'Shipping',
      tax_amount: 'Tax',
      total_amount: 'Total',
      ship_name: 'Ship to',
      ship_address: 'Address',
      ship_city: 'City',
      ship_state: 'State',
      ship_zip: 'ZIP',
      cancel_reason: 'Why cancelled',
    },
    // A return starts on the order it comes from, once the parcel has arrived (the command's `when`).
    actions: { requestReturn: action('Start a return', { command: 'requestReturn' }) },
    machine: machine('status', {
      open: {
        on: {
          confirmOrder: { to: 'confirmed', label: 'Confirm order' },
          cancelOrder: { to: 'cancelled', label: 'Cancel order' },
        },
      },
      // Completed by its delivery once it is paid (deliverFulfillment), or here once both are true.
      confirmed: {
        on: {
          completeOrder: { to: 'completed', label: 'Complete order' },
          cancelOrder: { to: 'cancelled', label: 'Cancel order' },
        },
      },
      completed: { final: true },
      cancelled: { final: true },
    }),
  },
  order_line: {
    segments: {
      // The lines that count as sold: a line's order, through its reference, not cancelled.
      sold: 'sales_order_id.status != cancelled',
      sold_last_90_days: 'sold and sales_order_id.placed_at = last 90 days',
    },
    access: 'write',
    recordLabel: '{sku} × {quantity}',
    noun: 'order line',
    // What a line comes to as New order's grid works it out, before the line is stored; the stored line_amount is
    // the handler's, priced in whole cents by pricing.ts, and the CHECK holds the two together.
    computed: { amount: computed.number('quantity * unit_price_amount') },
    display: { quantity: units },
    labels: {
      sales_order_id: 'Order',
      line_no: 'Line',
      unit_price_amount: 'Price',
      line_amount: 'Amount',
    },
  },
  payment: {
    segments: {
      pending_payments: { query: 'status = pending', label: 'Pending' },
      paid_payments: { query: 'status = paid', label: 'Paid' },
      refunded_payments: { query: 'status = partially_refunded or status = refunded', label: 'Refunded' },
    },
    access: 'write',
    recordLabel: 'Payment for #{sales_order_id}',
    rollups: { refunds: count('refund') },
    display: {
      status: financial,
      method: { values: { apple_pay: 'Apple Pay', paypal: 'PayPal' } },
      paid_at: { format: 'relative' },
    },
    labels: {
      sales_order_id: 'Order',
      charge_amount: 'Charge',
      paid_amount: 'Paid',
      refunded_amount: 'Refunded',
    },
    machine: machine('status', {
      pending: {
        on: {
          markPaid: { to: 'paid', label: 'Mark as paid' },
          // Moves with the order's cancel: the order is cancelled once, and its pending payment is voided with it.
          cancelOrder: 'voided',
        },
      },
      paid: { on: { refundPayment: { to: ['partially_refunded', 'refunded'], label: 'Refund' } } },
      partially_refunded: { on: { refundPayment: { to: ['partially_refunded', 'refunded'], label: 'Refund' } } },
      refunded: { final: true },
      voided: { final: true },
    }),
  },
  refund: {
    access: 'write',
    recordLabel: 'Refund {id} · #{sales_order_id}',
    labels: {
      sales_order_id: 'Order',
      order_return_id: 'Return',
      refund_amount: 'Amount',
      refunded_by: 'By',
    },
  },
  fulfillment: {
    access: 'write',
    recordLabel: 'Fulfillment of #{sales_order_id}',
    display: {
      status: fulfillmentStatus,
      // Carriers are said as their own names, not as words: UPS, not "Ups".
      carrier: { values: { UPS: 'UPS', USPS: 'USPS', FedEx: 'FedEx', DHL: 'DHL' } },
      shipped_at: { format: 'relative' },
    },
    labels: {
      sales_order_id: 'Order',
      location_id: 'Ships from',
      tracking_number: 'Tracking',
      'sales_order_id.ship_name': 'Ship to',
      'sales_order_id.shipping_method': 'Shipping',
    },
    // Packing takes the units off the shelf of the location it ships from, into the ledger; nothing moves twice.
    machine: machine('status', {
      pending: {
        on: {
          fulfillOrder: { to: 'packed', label: 'Pick & pack' },
          cancelOrder: 'cancelled',
        },
      },
      packed: { on: { shipFulfillment: { to: 'shipped', label: 'Ship' } } },
      shipped: { on: { deliverFulfillment: { to: 'delivered', label: 'Mark delivered' } } },
      delivered: { final: true },
      cancelled: { final: true },
    }),
  },
  order_return: {
    segments: {
      to_approve: 'status = requested',
      on_the_way_back: 'status = approved',
      to_refund: 'status = received',
      refunded_returns: { query: 'status = refunded', label: 'Refunded' },
      rejected_returns: { query: 'status = rejected', label: 'Rejected' },
    },
    access: 'write',
    favorite: true,
    recordLabel: 'Return {id} · #{sales_order_id}',
    noun: 'return',
    rollups: { lines: count('return_line'), units: sum('return_line', 'quantity') },
    display: {
      status: {
        tone: { requested: 'warn', approved: 'info', received: 'info', refunded: 'good', rejected: 'neutral' },
        icons: {
          requested: 'envelope',
          approved: 'check-circle',
          received: 'arrow-circle-down',
          refunded: 'arrow-circle-up',
          rejected: 'x-circle',
        },
      },
      reason: { tone: { damaged: 'bad', not_as_pictured: 'warn', '*': 'neutral' } },
      units,
    },
    labels: {
      id: 'Return',
      sales_order_id: 'Order',
      location_id: 'Received at',
      refund_amount: 'Refunded',
    },
    machine: machine('status', {
      requested: {
        on: {
          approveReturn: { to: 'approved', label: 'Approve' },
          rejectReturn: { to: 'rejected', label: 'Reject' },
        },
      },
      approved: { on: { receiveReturn: { to: 'received', label: 'Receive' } } },
      received: { on: { refundReturn: { to: 'refunded', label: 'Refund' } } },
      refunded: { final: true },
      rejected: { final: true },
    }),
  },
  return_line: {
    access: 'write',
    recordLabel: '{order_line_id.sku} × {quantity}',
    noun: 'return line',
    display: { quantity: units },
    labels: { order_return_id: 'Return', restock: 'Back to stock' },
  },
} as const;
