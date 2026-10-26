import { activity, breakdown, chart, dashboard, embed, firstRun, metric, rows } from '@mistriwork/mistri/app';

/* The two desks. Operations is where the day starts: what the floor has to
   pick and receive, what is short, what the stock is worth and how it has
   moved. Purchasing is the buyer's: drafts to send, trucks due and late, and
   what is on order from whom. */

export const operations = dashboard(
  'Operations',
  [
    // A depot on its first day: what to add before this board has anything to say.
    firstRun(
      'Set up your depot',
      [
        { label: 'Add your suppliers', to: 'suppliers', description: 'Who you buy from, with their lead times.' },
        { label: 'Add your products', to: 'products', description: 'Each SKU with its cost, reorder point and home bin.' },
        { label: 'Draft a purchase order', to: 'purchase-orders', description: 'Stock arrives through receiving, into a bin.' },
      ],
      { description: 'Warehouses and bins are in place. Three steps and stock starts to move.' },
    ),
    metric('To pick', 'pick_list', { query: 'status = to_pick', to: 'pick-lists', icon: 'package' }),
    metric('Due to ship today', 'pick_list', {
      query: 'status != shipped and sales_order_id.ship_by <= today',
      to: 'pick-lists',
      icon: 'truck',
    }),
    metric('Receipts due', 'po_line', {
      query: 'status = open and purchase_order_id.expected_on <= today',
      to: 'receiving',
      icon: 'clipboard-text',
    }),
    // The floor's work as one flow, a card per step in the status's order: what waits at each, a click to the lists.
    breakdown('Pick lists by step', 'pick_list', 'status', {
      query: 'status != shipped or shipped_at = last 7 days',
      shape: 'steps',
      notes: {
        to_pick: 'Released, waiting on the floor',
        picked: 'On the bench to pack',
        packed: 'Boxed for the carrier',
        shipped: 'Out the door this week',
      },
      icon: 'package',
    }),
    embed('pick-lists', { title: 'Next to pick', width: 'half', limit: 5, icon: 'list-checks' }),
    embed('receiving', { title: 'Receiving', width: 'half', limit: 5, icon: 'tray' }),
    // Its own period, picked in its heading: the last week at a glance, the month or the quarter behind it.
    chart('Lines moved by day', 'stock_movement', 'day moved_at', {
      query: 'moved_at = last 7 days and kind != "count"',
      over: 'moved_at',
      windows: ['last 7 days', 'last 30 days', 'last 90 days'],
      limit: 91,
      height: 200,
      shape: 'bar',
      icon: 'chart-bar',
    }),
    // When the floor is busy: a cell per weekday and hour, so a shift is planned where the moves gather.
    chart('Moves by weekday and hour', 'stock_movement', 'weekday moved_at, hour moved_at', {
      query: 'moved_at = last 90 days and kind != "count"',
      shape: 'heatmap',
      icon: 'calendar',
    }),
    // Where the money sits: a tile per category, sized by the stock's value, too many parts for a donut.
    chart('Stock value by category', 'stock_level', 'product_id.category_id.name', {
      measure: 'sum value',
      shape: 'treemap',
      width: 'half',
      icon: 'package',
    }),
    // What each month added to or took from the shelves: receipts rise, picks fall, the net at the end.
    chart('Net units by month', 'stock_movement', 'month moved_at', {
      query: 'moved_at = last 6 months',
      measure: 'sum qty',
      shape: 'waterfall',
      width: 'half',
      icon: 'chart-bar',
    }),
    breakdown('Stock value by warehouse', 'stock_level', 'warehouse_id.name', { measure: 'sum value', width: 'half', icon: 'buildings' }),
    breakdown('Orders shipped by warehouse, last 30 days', 'pick_list', 'warehouse_id.name', {
      query: 'status = shipped and shipped_at = last 30 days',
      width: 'half',
      icon: 'truck',
    }),
    // The open orders, worked where they are read: searched, filtered, and a selection's ship-by, priority or carrier set at once.
    embed('orders', { title: 'Open orders', tab: 'open', limit: 8, icon: 'shopping-cart', interactive: true }),
  ],
  {
    icon: 'gauge',
    heading: 'Hello, {me.name}',
    description: 'Today on the floor: pick lists, trucks due and the SKUs running short.',
    aside: [
      // What the floor and the buyers did, newest first: each change's record, who and when.
      activity(
        'Latest updates',
        {
          pick_list: { icon: 'truck' },
          purchase_order: { icon: 'receipt' },
          sales_order: { icon: 'shopping-cart' },
          stock_movement: { icon: 'arrows-left-right' },
        },
        { limit: 6, icon: 'clock' },
      ),
      embed('low-stock', { title: 'Below reorder point', limit: 8, icon: 'warning' }),
      rows('Adjustments this week', 'stock_movement', {
        query: 'kind = adjustment and moved_at = last 7 days',
        show: ['product_id.sku', 'reason', 'qty'],
        sort: 'moved_at desc',
        limit: 5,
        icon: 'sliders',
      }),
    ],
  },
);

export const purchasing = dashboard(
  'Purchasing',
  [
    metric('On order', 'po_line', { query: 'open', measure: 'sum open_value', width: 'third', icon: 'shopping-cart' }),
    // Summed over each SKU's own rollup: every unit still to arrive, counted once per product.
    metric('Units on order', 'product', { query: 'active', measure: 'sum on_order', width: 'third', icon: 'package' }),
    metric('Received, last 30 days', 'stock_movement', {
      query: 'kind = receipt and moved_at = last 30 days',
      measure: 'sum value',
      compare: 'previous period',
      better: 'up',
      width: 'third',
      icon: 'receipt',
      spark: true,
      over: 'moved_at',
    }),
    breakdown('On order by supplier', 'po_line', 'purchase_order_id.supplier_id.name', {
      query: 'open',
      measure: 'sum open_value',
      width: 'half',
      limit: 8,
      icon: 'handshake',
    }),
    chart('Received by month', 'stock_movement', 'month moved_at', {
      query: 'kind = receipt and moved_at = last 6 months',
      measure: 'sum value',
      width: 'half',
      shape: 'bar',
      icon: 'chart-bar',
    }),
    // Oldest first, so a truck that is late leads the list.
    rows('Due in', 'purchase_order', {
      query: 'open',
      show: ['id', 'supplier_id.name', 'warehouse_id.name', 'expected_on', 'open_units'],
      sort: 'expected_on',
      limit: 8,
      icon: 'clock',
    }),
  ],
  {
    icon: 'chart-bar',
    description: 'Drafts, trucks on the way and what each supplier owes the depot.',
    aside: [
      // The buyer's to-do first: drafts waiting to be sent, each named by its supplier.
      rows('Drafts to send', 'purchase_order', {
        query: 'status = draft',
        show: ['supplier_id.name', 'warehouse_id.name', 'expected_on'],
        sort: 'ordered_on desc',
        limit: 5,
      }),
      embed('low-stock', { title: 'Below reorder point', limit: 10 }),
    ],
  },
);
