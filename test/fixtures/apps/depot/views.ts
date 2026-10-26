import { cards, commandForm, listView, queue, step } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';

/* Everything a Depot reader can open but the two dashboards
   (dashboards.ts). navigation.ts arranges them; column captions are the
   resources' (resources.ts), so a view lists columns and paths only. */

export const views = {
  /* ---------- the floor: worked on a phone as often as at a desk ---------- */

  // The pick queue: what the floor picks next, first to ship first.
  'pick-lists': listView('Pick lists', 'pick_list', {
    icon: 'package',
    query: 'status != shipped',
    presentation: queue('ship_to', {
      lines: ['reference'],
      // Through the order: how big a pick it is, from the order's own rollups.
      properties: [
        'sales_order_id.priority',
        'sales_order_id.ship_by',
        'warehouse_id.name',
        'sales_order_id.lines',
        'sales_order_id.units',
      ],
      openLabel: 'Open pick list',
    }),
    tabs: [
      { segment: 'to_pick_lists', sort: 'sales_order_id.ship_by, released_at' },
      { segment: 'to_pack', sort: 'picked_at' },
      { segment: 'to_ship', sort: 'packed_at' },
    ],
    filters: ['warehouse_id'],
    actions: ['packLists'],
    empty: {
      title: 'Nothing waiting on the floor',
      description: 'Released orders appear here as pick lists.',
      action: { label: 'View orders', to: 'orders' },
    },
  }),
  // Lines on the water, oldest first: receive each into a bin.
  receiving: listView('Receiving', 'po_line', {
    icon: 'truck',
    query: 'open',
    // A line's status has no machine, so the menu cannot tell it is work: the list says so.
    count: true,
    presentation: queue('product_id.name', {
      lines: ['product_id.sku'],
      properties: ['open_qty', 'purchase_order_id.expected_on', 'purchase_order_id.buyer'],
      openLabel: 'Open line',
    }),
    tabs: [
      { segment: 'due', sort: 'purchase_order_id.expected_on' },
      { label: 'All open', sort: 'purchase_order_id.expected_on' },
    ],
    filters: ['purchase_order_id'],
    open: 'modal',
    empty: { title: 'Nothing is on the way', description: 'Lines of sent purchase orders wait here until they are received.' },
  }),
  // A blind count: the sheet names the bin and the SKU, never what the system expects.
  'count-sheet': listView('Count sheet', 'cycle_count_line', {
    icon: 'list-checks',
    query: 'cycle_count_id.status = counting',
    count: true,
    presentation: queue('bin_id.code', {
      lines: ['product_id.name'],
      properties: ['product_id.sku', 'cycle_count_id', 'counted_qty'],
      openLabel: 'Count',
    }),
    tabs: [
      { segment: 'to_count', sort: 'bin_id.code' },
      { segment: 'counted', sort: 'bin_id.code' },
    ],
    open: 'modal',
    /* A count done on paper comes back as a sheet: each row records its bin's
       count through Record count, on the open line its bin and SKU find. */
    import: { command: 'recordCount', match: ['bin_id', 'product_id'] },
    empty: {
      title: 'No count is open',
      description: 'Start a count of an aisle and its bins appear here.',
      action: { label: 'View cycle counts', to: 'cycle-counts' },
    },
  }),

  /* ---------- orders ---------- */

  // Triage happens here: ship-by, priority and carrier change in place, and "Set field…" takes a selection.
  orders: listView('Orders', 'sales_order', {
    icon: 'shopping-cart',
    show: ['id', 'customer_id.name', 'warehouse_id.name', 'ship_by', 'priority', 'carrier', 'lines', 'units', 'shipped_at'],
    editable: ['ship_by', 'priority', 'carrier'],
    tabs: [
      { segment: 'open', sort: 'ship_by' },
      { segment: 'late', sort: 'ship_by' },
      { segment: 'rush', sort: 'ship_by' },
      { segment: 'not_released', sort: 'ordered_on' },
      { segment: 'shipped', sort: 'shipped_at desc' },
      { label: 'All', sort: 'ordered_on desc' },
    ],
    filters: ['warehouse_id', 'priority', 'carrier', 'customer_id', 'ship_by'],
    density: 'compact',
  }),
  release: commandForm('Release an order', 'releaseOrder', {
    icon: 'lightning',
    submitLabel: 'Release to the floor',
    description: 'A keyed order goes to its warehouse as a pick list. It needs at least one line, and it is released once.',
    done: { title: 'Released', description: 'Its pick list is on the floor.' },
  }),
  customers: listView('Customers', 'customer', {
    icon: 'storefront',
    show: ['name', 'kind', 'city', 'state', 'warehouse_id.name', 'orders'],
    sort: 'name',
    filters: ['kind', 'warehouse_id', 'state'],
  }),

  /* ---------- inventory ---------- */

  products: listView('Products', 'product', {
    icon: 'tag',
    show: ['name', 'sku', 'on_hand', 'on_order', 'reorder_point', 'reorder_qty', 'home_bin_id.code'],
    // Where the buyer and the floor triage: a reorder point, a quantity and a home bin change in place.
    editable: ['reorder_point', 'reorder_qty', 'home_bin_id'],
    tabs: [
      { segment: 'active', sort: 'sku' },
      { segment: 'low_stock', sort: 'on_hand' },
      { segment: 'out_of_stock', sort: 'sku' },
      { segment: 'discontinued', sort: 'sku' },
      { label: 'All', sort: 'sku' },
    ],
    filters: ['name', 'category_id', 'supplier_id', 'home_bin_id'],
    density: 'compact',
    favorite: true,
  }),
  // The low-stock list on its own, for the dashboards to show.
  'low-stock': listView('Low stock', 'product', {
    icon: 'warning',
    query: 'status = active and on_hand < reorder_point',
    // Three columns, so the dashboards' side column reads it as names: the product, its SKU, what is left.
    show: ['name', 'sku', 'on_hand'],
    sort: 'on_hand',
    empty: {
      title: 'Every SKU is above its reorder point',
      description: 'A SKU whose stock falls under its reorder point is listed here.',
    },
  }),
  catalog: listView('Catalog', 'product', {
    icon: 'storefront',
    query: 'active',
    presentation: cards('name', {
      value: 'list_price',
      facts: ['sku', 'category_id.name', 'on_hand'],
      properties: ['home_bin_id.code'],
      image: { from: 'product_photo', whose: 'product_id', sort: 'position' },
    }),
    filterBar: 'rail',
    filters: ['category_id', 'supplier_id', 'color', 'list_price', 'specs'],
    sort: [
      { label: 'SKU', sort: 'sku' },
      { label: 'Lowest price', sort: 'list_price' },
      { label: 'Highest price', sort: 'list_price desc' },
      { label: 'Most on hand', sort: 'on_hand desc' },
    ],
  }),
  stock: listView('Stock', 'stock_level', {
    icon: 'stack',
    show: ['product_id.name', 'product_id.sku', 'bin_id.code', 'warehouse_id.name', 'qty', 'value', 'last_counted_on'],
    tabs: [
      { segment: 'in_stock', sort: 'bin_id.code' },
      { segment: 'empty_stock', sort: 'bin_id.code' },
      { label: 'All', sort: 'bin_id.code' },
    ],
    filters: ['warehouse_id', 'bin_id', 'product_id', 'qty'],
    totals: ['qty', 'value'],
    rowActions: true,
    density: 'compact',
  }),
  // The ledger: every unit in and out, newest first.
  movements: listView('Movements', 'stock_movement', {
    icon: 'list',
    show: ['moved_at', 'kind', 'reference', 'product_id.sku', 'bin_id.code', 'qty', 'bin_qty_after', 'value', 'reason', 'moved_by'],
    sort: 'moved_at desc',
    tabs: [
      { label: 'All' },
      'receipts',
      'picks',
      'transfers',
      'adjustments',
      // What the signed-in account moved: the ledger stamps each line with its email.
      'mine',
    ],
    filters: ['kind', 'warehouse_id', 'product_id', 'bin_id', 'moved_at', 'reason'],
    totals: ['qty', 'value'],
    density: 'compact',
  }),
  bins: listView('Bins', 'bin', {
    icon: 'archive',
    show: ['code', 'warehouse_id.name', 'zone', 'aisle', 'units', 'skus', 'value', 'active'],
    editable: ['zone', 'active'],
    tabs: [
      { segment: 'active_bins', sort: 'code' },
      { segment: 'empty_bins', sort: 'code' },
      { segment: 'inactive', sort: 'code' },
    ],
    filters: ['warehouse_id', 'zone', 'aisle'],
    density: 'compact',
  }),
  warehouses: listView('Warehouses', 'warehouse', {
    icon: 'buildings',
    show: ['name', 'city', 'state', 'manager', 'bins', 'stocked', 'units', 'stock_value', 'to_pick'],
    sort: 'id',
  }),
  'cycle-counts': listView('Cycle counts', 'cycle_count', {
    icon: 'clipboard-text',
    show: [
      'id',
      'warehouse_id.name',
      'aisle',
      'status',
      'started_on',
      'completed_on',
      'lines',
      'counted',
      'variance_units',
      'variance_value',
    ],
    tabs: [
      { segment: 'counting', sort: 'started_on' },
      { segment: 'completed', sort: 'completed_on desc' },
      { label: 'All', sort: 'started_on desc' },
    ],
    filters: ['warehouse_id'],
  }),
  'start-count': commandForm('Start a count', 'startCount', {
    icon: 'clipboard-text',
    submitLabel: 'Start count',
    description: 'Every bin in the aisle with stock of any SKU becomes a line of a blind count sheet.',
    done: { title: 'Count started', description: 'Its bins are on the count sheet.' },
  }),

  /* ---------- purchasing ---------- */

  'purchase-orders': listView('Purchase orders', 'purchase_order', {
    icon: 'receipt',
    show: ['id', 'supplier_id.name', 'warehouse_id.name', 'status', 'ordered_on', 'expected_on', 'lines', 'total', 'open_value'],
    tabs: [
      { segment: 'drafts', sort: 'ordered_on desc' },
      // The drafts a flow holds for a manager's word (the Large order approval flow).
      { segment: 'awaiting_approval', sort: 'ordered_on desc' },
      { segment: 'open', sort: 'expected_on' },
      { segment: 'overdue', sort: 'expected_on' },
      { segment: 'received_orders', sort: 'received_on desc' },
      // The orders the signed-in buyer drafted.
      { segment: 'mine', sort: 'ordered_on desc' },
      { label: 'All', sort: 'ordered_on desc' },
    ],
    filters: ['supplier_id', 'warehouse_id', 'status', 'expected_on'],
    rowActions: true,
  }),
  'new-purchase-order': commandForm(
    'New purchase order',
    'draftPurchaseOrder',
    [step('Supplier', ['supplier', 'warehouse', 'expected_on', 'notes']), step('Lines', ['lines'])],
    {
      icon: 'receipt',
      submitLabel: 'Save draft',
      description: 'A draft until it is sent: each SKU at its standard cost, from the supplier that makes it.',
      done: { title: 'Purchase order drafted', description: 'Send it to the supplier from its page when it is ready.' },
    },
  ),
  // The purchase orders' flows: rows Purchasing edits while the App runs (resources.ts, jobs.ts).
  'po-flows': listView('Flows', 'po_flow', {
    icon: 'lightning',
    show: ['name', 'start', 'condition', 'active'],
    sort: 'name',
  }),
  suppliers: listView('Suppliers', 'supplier', {
    icon: 'handshake',
    show: ['name', 'contact', 'city', 'state', 'lead_time_days', 'terms', 'products', 'open_orders', 'open_value'],
    sort: 'name',
  }),
} satisfies Views;
