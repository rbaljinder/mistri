import { breakdown, card, diagram, fields, flows, history, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* A purchase order, its lines received one at a time from their own rows;
   a line, as the receiving queue opens it; a supplier and what it makes. */
export const purchasingPages = {
  'purchase-order': page(
    'purchase_order',
    [
      // The supplier is the aside's card; the summary is where it goes, when and for how much,
      // under the order's machine as a stepper.
      fields(['warehouse_id', 'expected_on', 'total']),
      related('Lines', 'po_line', 'purchase_order_id', {
        show: ['product_id', 'qty_ordered', 'qty_received', 'amount'],
        sort: 'line_no',
        limit: 30,
      }),
      related('Receipts', 'stock_movement', 'purchase_order_id', {
        show: ['moved_at', 'product_id.sku', 'bin_id', 'qty'],
        sort: 'moved_at desc',
        empty: 'hide',
      }),
      // An order that went for approval: its run drawn over the flow, the step it waits at in the accent.
      diagram('Approval flow', { when: 'approval is not empty' }),
      fields(['status', 'buyer', 'ordered_on', 'sent_on', 'expected_on', 'received_on', 'open_units', 'open_value'], {
        title: 'Order',
        region: 'aside',
      }),
      fields(['notes'], { title: 'Notes', region: 'aside', columns: 1, when: 'notes is not empty' }),
      card('Supplier', 'supplier_id', ['contact', 'phone', 'terms']),
      fields(['approval', 'approver', 'draft_value'], { title: 'Approval', region: 'aside', when: 'approval is not empty' }),
      // What the order's flows did by themselves, and what a waiting one waits for (jobs.ts).
      flows('Flows', { region: 'aside' }),
      history(undefined, { limit: 10 }),
    ],
    { listTabs: true },
  ),
  /* A flow, as Purchasing writes it: when it starts, and its steps in order. */
  'po-flow': page('po_flow', [
    fields(['start', 'condition', 'changes', 'active'], { presentation: 'properties' }),
    // The steps drawn in order: a branch's other way runs to its goto or to the end.
    diagram('Flow'),
    related('Steps', 'po_flow_step', 'flow_id', {
      show: ['position', 'kind', 'title', 'approver', 'condition', 'goto', 'duration'],
      sort: 'position',
      limit: 100,
    }),
  ]),
  'po-line': page('po_line', [
    fields(['product_id', 'open_qty', 'qty_ordered', 'qty_received']),
    fields(
      [
        'purchase_order_id',
        'purchase_order_id.warehouse_id',
        'purchase_order_id.expected_on',
        'product_id.home_bin_id',
        'unit_cost',
        'status',
      ],
      {
        title: 'Receiving',
        presentation: 'properties',
      },
    ),
    related(
      'Received so far',
      'stock_movement',
      { same: ['purchase_order_id', 'product_id'] },
      {
        show: ['moved_at', 'bin_id', 'qty'],
        sort: 'moved_at desc',
        empty: 'hide',
      },
    ),
  ]),
  supplier: page(
    'supplier',
    [
      fields(['contact', 'city', 'state', 'terms'], { presentation: 'facts' }),
      // How many products it makes is the Products tab's count.
      fields(['open_orders', 'open_value', 'received_recently']),
      // Measured by a rollup of each order: what is still to arrive, and where it is going.
      breakdown('On order by warehouse', 'purchase_order', 'warehouse_id.name', {
        whose: 'supplier_id',
        measure: 'sum open_value',
        query: 'open',
      }),
      related('Purchase orders', 'purchase_order', 'supplier_id', {
        show: ['id', 'status', 'expected_on', 'total'],
        sort: 'ordered_on desc',
        limit: 10,
      }),
      related('Products', 'product', 'supplier_id', {
        show: ['name', 'on_hand', 'reorder_point', 'on_order'],
        sort: 'sku',
        limit: 25,
      }),
      fields(['email', 'phone', 'lead_time_days'], { title: 'Contact', region: 'aside' }),
    ],
    { listTabs: true },
  ),
} satisfies Pages;
