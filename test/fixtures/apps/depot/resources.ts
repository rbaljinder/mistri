import { action, count, machine, max, sum } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';
import { stockSparkline } from './components.ts';

/* What Depot says about each table, once: which it writes, how values dress,
   the captions every list, page and form uses, the numbers rolled up from
   the rows that point at it, and the verbs a record offers. */

const usd = { format: 'money' } as const;
const units = { format: 'number' } as const;

export const resources = {
  /* ---------- the catalog ---------- */
  product: {
    segments: {
      active: 'status = active',
      low_stock: 'status = active and on_hand < reorder_point',
      out_of_stock: 'status = active and on_hand = 0',
      discontinued: 'status = discontinued',
    },
    access: 'write',
    favorite: true,
    // A catalog arrives as a spreadsheet: Import beside New, each row a new product, judged as the New form's would be.
    import: true,
    /* A tent's capacity and a headlamp's lumens are not columns: each category's
       attributes are rows a manager keeps (the attribute resource), and a
       product's values for them live in its one JSON column, drawn, edited,
       judged and filtered as its own fields. */
    defined: { specs: { from: 'attribute', per: 'category_id' } },
    // Stock is never typed here: it is the sum of the bins, read from the ledger's side.
    rollups: {
      on_hand: sum('stock_level', 'qty'),
      stock_value: sum('stock_level', 'value'),
      on_order: sum('po_line', 'open_qty', { query: 'open' }),
      locations: count('stock_level', { query: 'in_stock' }),
      last_moved: max('stock_movement', 'moved_at'),
    },
    display: {
      stock_value: usd,
      // On hand beside its last thirty days, as a line, in a grid (widgets/StockSparkline.tsx).
      on_hand: stockSparkline,
      on_order: units,
      reorder_point: units,
      reorder_qty: units,
      status: { tone: { discontinued: 'warn' } },
      // A product's name in a list starts with a tag square, tinted warn once it is discontinued.
      name: { icon: { mark: 'tag', toneOf: 'status' } },
      last_moved: { format: 'relative' },
      // Read off the box with the camera at the receiving bench, or typed.
      upc: { scan: true },
    },
    labels: {
      name: 'Product',
      upc: 'UPC',
      weight_lb: 'Weight',
      specs: 'Specifications',
    },
    form: {
      groups: [
        { label: 'Product', fields: ['sku', 'name', 'category_id', 'color', 'size', 'unit', 'upc'] },
        { label: 'Buying', fields: ['supplier_id', 'unit_cost', 'list_price'] },
        { label: 'Stocking', fields: ['reorder_point', 'reorder_qty', 'home_bin_id'] },
        { label: 'Specifications', fields: ['specs'] },
      ],
    },
    validation: [{ must: 'list_price >= unit_cost', message: 'A product sells for at least what it costs.' }],
    actions: {
      discontinue: action('Discontinue', { set: { status: 'discontinued' }, when: 'status = active', confirm: true }),
      reactivate: action('Reactivate', { set: { status: 'active' }, when: 'status = discontinued' }),
    },
  },
  product_photo: {
    access: 'write',
    delete: true,
    noun: 'photo',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail', maxBytes: 5_000_000 },
    labels: { position: 'Order', file_name: 'File', byte_size: 'Size' },
  },
  // The questions a category's products answer: one row per attribute, null category for every product.
  attribute: {
    access: 'write',
    delete: true,
    labels: { position: 'Order' },
  },
  category: {
    noun: { one: 'category', many: 'categories' },
    rollups: { products: count('product', { query: 'active' }) },
    labels: { name: 'Category' },
  },
  supplier: {
    access: 'write',
    rollups: {
      products: count('product', { query: 'active' }),
      open_orders: count('purchase_order', { query: 'open' }),
      received_recently: count('purchase_order', { query: 'status = received and received_on = last 90 days' }),
      // A rollup of a rollup: each purchase order's open value, summed — what the supplier still owes the depot.
      open_value: sum('purchase_order', 'open_value'),
    },
    display: { open_value: usd },
    labels: {
      name: 'Supplier',
      lead_time_days: 'Lead time',
      open_orders: 'Open POs',
      received_recently: 'Received, last 90 days',
      open_value: 'On order',
    },
    form: { show: ['name', 'contact', 'email', 'phone', 'city', 'state', 'lead_time_days', 'terms'], defaults: { terms: 'Net 30' } },
  },

  /* ---------- the buildings ---------- */
  warehouse: {
    rollups: {
      stock_value: sum('stock_level', 'value'),
      units: sum('stock_level', 'qty'),
      stocked: count('stock_level', { query: 'in_stock' }),
      to_pick: count('pick_list', { query: 'status = to_pick' }),
      bins: count('bin', { query: 'active = true' }),
    },
    display: { stock_value: usd, units },
    labels: {
      name: 'Warehouse',
      stocked: 'Stocked locations',
    },
  },
  bin: {
    segments: {
      active_bins: { query: 'active = true', label: 'Active' },
      empty_bins: { query: 'active = true and skus = 0', label: 'Empty' },
      inactive: 'active = false',
    },
    access: 'write',
    rollups: {
      units: sum('stock_level', 'qty'),
      skus: count('stock_level', { query: 'in_stock' }),
      value: sum('stock_level', 'value'),
    },
    display: { zone: { tone: { receiving: 'info', reserve: 'neutral', pick: 'neutral' } }, value: usd, units },
    labels: {
      code: 'Bin',
      skus: 'SKUs',
    },
    form: { show: ['warehouse_id', 'code', 'aisle', 'zone', 'capacity'], defaults: { zone: 'pick', active: true, capacity: 120 } },
  },

  /* ---------- stock and the ledger: written only by commands ---------- */
  stock_level: {
    segments: {
      in_stock: 'qty > 0',
      empty_stock: { query: 'qty = 0', label: 'Empty' },
    },
    access: 'write',
    recordLabel: '{product_id.sku} in {bin_id.code}',
    noun: { one: 'bin stock', many: 'bin stock' },
    display: { qty: units, last_counted_on: { format: 'relative' } },
    labels: {
      qty: 'On hand',
    },
    actions: { transfer: action('Transfer', { command: 'transferStock' }), adjust: action('Adjust', { command: 'adjustStock' }) },
  },
  stock_movement: {
    segments: {
      receipts: 'kind = receipt',
      picks: 'kind = pick',
      transfers: 'kind = transfer',
      adjustments: 'kind = adjustment or kind = count',
      mine: 'moved_by = me',
    },
    access: 'write',
    recordLabel: '{reference} · {product_id.sku}',
    noun: 'movement',
    display: {
      qty: { format: 'number' },
      bin_qty_after: units,
      on_hand_after: units,
      kind: { tone: { adjustment: 'warn', count: 'info', '*': 'neutral' } },
    },
    labels: {
      moved_at: 'When',
      kind: 'Movement',
      bin_qty_after: 'Bin after',
      moved_by: 'By',
    },
  },

  /* ---------- purchasing ---------- */
  purchase_order: {
    segments: {
      drafts: 'status = draft',
      awaiting_approval: 'approval = requested',
      open: 'status = sent or status = partial',
      overdue: 'open and expected_on < today',
      received_orders: { query: 'status = received', label: 'Received' },
      mine: 'buyer_email = me',
    },
    access: 'write',
    favorite: true,
    recordLabel: 'PO-{id}',
    noun: 'purchase order',
    rollups: {
      total: sum('po_line', 'amount'),
      open_value: sum('po_line', 'open_value', { query: 'open' }),
      lines: count('po_line'),
      units: sum('po_line', 'qty_ordered'),
      open_units: sum('po_line', 'open_qty'),
    },
    display: {
      // Each stage its mark: a draft being written, sent on its way, part in, all in, called off.
      status: {
        tone: { sent: 'info', partial: 'warn', received: 'good', '*': 'neutral' },
        icons: { draft: 'pencil-simple', sent: 'paper-plane-tilt', partial: 'hourglass', received: 'check-circle', cancelled: 'x-circle' },
        values: { partial: 'Partly received' },
      },
      total: usd,
      open_value: usd,
      approval: { tone: { requested: 'warn', approved: 'good', rejected: 'bad' } },
      units,
      open_units: units,
    },
    labels: {
      id: 'PO',
      draft_value: 'Value as drafted',
      ordered_on: 'Drafted',
      buyer_email: 'Buyer’s email',
      open_units: 'Units open',
    },
    /* The buyer who drafted an order hears when it is in, or when someone
       else cancels it: by the email their draft was stamped with (commands.ts). */
    notify: [
      {
        on: { changes: 'status' },
        when: 'status = received or status = cancelled',
        to: 'buyer_email',
        title: 'PO-{id} from {supplier_id.name} is {status}',
      },
    ],
    /* Where an order stands, and what moves it: its buttons, the page's
       stepper and the only changes of status the server takes. Receiving a
       line is the line's button; it moves the order on as the last one
       arrives, along the edges named here. */
    /* What happens to an order by itself is rows, not code: Purchasing keeps
       the flows (po_flow) and their steps (po_flow_step) under Flows, and the
       runner (jobs.ts) runs each matching flow on the order, durably. A step
       is one of the platform's (wait, until, branch, set, waitFor) or one
       named here, which runs the App's command on the order, so a flow
       writes only what the commands do, under their rules. The seeded flow:
       an order drafted over $5,000 asks a manager, waits for the word
       (po.decided, about its `order`), and is sent if approved. */
    flows: {
      from: 'po_flow',
      steps: 'po_flow_step',
      events: { 'po.decided': 'order' },
      kinds: {
        approval: { command: 'requestApproval', input: ['approver'], waitFor: 'po.decided' },
        send: { command: 'sendPurchaseOrder' },
      },
    },
    // The manager's word an approval step waits for: offered while an order waits for it (the commands' `when`).
    actions: {
      approve: action('Approve', { command: 'approvePurchaseOrder' }),
      reject: action('Reject', { command: 'rejectPurchaseOrder' }),
    },
    machine: machine('status', {
      draft: {
        on: {
          sendPurchaseOrder: { to: 'sent', label: 'Send to supplier' },
          cancelPurchaseOrder: { to: 'cancelled', label: 'Cancel order' },
        },
      },
      sent: { on: { receiveLine: ['partial', 'received'], cancelPurchaseOrder: { to: 'cancelled', label: 'Cancel order' } } },
      partial: { on: { receiveLine: 'received' } },
      received: { final: true },
      cancelled: { final: true },
    }),
  },
  /* A flow and its steps: rows Purchasing edits while the App runs, each
     judged as it is written (a step names a kind the order offers, a
     condition reads, a duration parses), so a run never meets a step it
     cannot take. */
  po_flow: {
    access: 'write',
    delete: true,
    recordLabel: '{name}',
    noun: 'flow',
    display: { start: { values: { created: 'When an order is drafted', updated: 'When an order changes', manual: 'By hand' } } },
    labels: { start: 'Starts', changes: 'When this changes' },
    form: { show: ['name', 'start', 'condition', 'changes', 'active'], defaults: { start: 'created', active: true } },
  },
  po_flow_step: {
    access: 'write',
    delete: true,
    recordLabel: '{position}. {kind}',
    noun: 'flow step',
    labels: { goto: 'Otherwise go to step', field: 'Date field' },
  },
  po_line: {
    segments: {
      // Still to arrive: the Receiving queue, what is on order and a product's Purchasing tab.
      open: 'status = open',
      due: 'purchase_order_id.expected_on <= today',
    },
    access: 'write',
    recordLabel: '{product_id.sku} × {qty_ordered}',
    noun: { one: 'order line', many: 'order lines' },
    display: {
      status: { tone: { open: 'info', received: 'good', '*': 'neutral' } },
      qty_ordered: units,
      qty_received: units,
      open_qty: units,
    },
    labels: {
      purchase_order_id: 'Purchase order',
      line_no: 'Line',
      qty_ordered: 'Ordered',
      qty_received: 'Received',
      open_qty: 'Open',
      'purchase_order_id.buyer': 'Buyer',
    },
    actions: { receive: action('Receive', { command: 'receiveLine' }) },
  },

  /* ---------- orders and the floor ---------- */
  customer: {
    rollups: { orders: count('sales_order') },
    labels: { name: 'Customer' },
  },
  sales_order: {
    segments: {
      open: 'shipped_at is empty',
      late: 'shipped_at is empty and ship_by < today',
      rush: 'priority = rush and shipped_at is empty',
      not_released: 'released = 0',
      shipped: 'shipped_at is not empty',
    },
    access: 'write',
    favorite: true,
    recordLabel: 'SO-{id}',
    noun: 'order',
    // An order's stage is its pick list's: these say where it is without a column the floor must keep in step.
    rollups: {
      lines: count('order_line'),
      units: sum('order_line', 'qty'),
      released: count('pick_list'),
      shipped_at: max('pick_list', 'shipped_at'),
    },
    // A priority reads as signal bars beside its word, a rush as a flame.
    display: {
      priority: {
        tone: { rush: 'bad', high: 'warn', '*': 'neutral' },
        icons: { rush: 'fire', high: 'cell-signal-high', normal: 'cell-signal-medium', low: 'cell-signal-low' },
      },
      units,
      ship_by: { format: 'relative' },
    },
    labels: {
      id: 'Order',
      customer_po: 'Customer PO',
      shipped_at: 'Shipped',
    },
    form: {
      show: ['customer_id', 'warehouse_id', 'customer_po', 'ship_by', 'priority', 'carrier', 'notes'],
    },
    validation: [{ must: 'ship_by >= ordered_on', message: 'An order ships on or after the day it was taken.' }],
  },
  order_line: {
    access: 'write',
    delete: true,
    recordLabel: '{product_id.sku} × {qty}',
    noun: 'order line',
    display: { qty: units },
    labels: {
      sales_order_id: 'Order',
    },
  },
  // A receiver's signature, one picture per shipment: written by the pick list's signature pad, never listed.
  delivery_signature: {
    access: 'write',
    noun: 'signature',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 200_000 },
  },
  pick_list: {
    segments: {
      to_pick_lists: { query: 'status = to_pick', label: 'To pick' },
      to_pack: 'status = picked',
      to_ship: 'status = packed',
    },
    access: 'write',
    noun: 'pick list',
    display: {
      // Signed for at the dock: drawn on the pad (or the receiver's name typed) and kept as a PNG.
      signature_id: { signature: true },
      status: {
        tone: { to_pick: 'warn', shipped: 'good', '*': 'neutral' },
        // The floor's four steps, each with its mark: the steps on the Operations board draw them.
        icons: { to_pick: 'list-checks', picked: 'package', packed: 'archive', shipped: 'truck' },
      },
    },
    labels: {
      reference: 'Pick list',
      sales_order_id: 'Order',
      signature_id: 'Signed for',
      'sales_order_id.customer_po': 'Customer PO',
      'sales_order_id.notes': 'Order notes',
    },
    // The floor's walk: picked whole, packed (several at once from the queue), shipped.
    machine: machine('status', {
      to_pick: { on: { pickList: { to: 'picked', label: 'Pick' } } },
      picked: { on: { packLists: { to: 'packed', label: 'Pack', bulk: true } } },
      packed: { on: { shipList: { to: 'shipped', label: 'Ship' } } },
      shipped: { final: true },
    }),
  },

  /* ---------- cycle counts ---------- */
  cycle_count: {
    segments: {
      counting: 'status = counting',
      completed: 'status = completed',
    },
    access: 'write',
    recordLabel: 'CC-{id}',
    noun: 'cycle count',
    rollups: {
      lines: count('cycle_count_line'),
      counted: count('cycle_count_line', { query: 'counted_qty is not empty' }),
      variance_units: sum('cycle_count_line', 'variance'),
      variance_value: sum('cycle_count_line', 'variance_value'),
    },
    display: { status: { tone: { counting: 'warn', completed: 'good' } }, variance_value: usd },
    labels: {
      id: 'Count',
      lines: 'Bins',
      variance_units: 'Variance',
    },
    actions: { completeCount: action('Complete count', { command: 'completeCount' }) },
  },
  cycle_count_line: {
    segments: {
      to_count: 'counted_qty is empty',
      counted: 'counted_qty is not empty',
    },
    access: 'write',
    recordLabel: '{bin_id.code} · {product_id.sku}',
    noun: 'count line',
    display: { variance: { tone: { '< 0': 'bad', '> 0': 'warn' } } },
    labels: {
      cycle_count_id: 'Count',
      stock_level_id: 'Bin stock',
      expected_qty: 'Expected',
      counted_qty: 'Counted',
    },
    actions: { recordCount: action('Record count', { command: 'recordCount' }) },
  },
} satisfies Resources;
