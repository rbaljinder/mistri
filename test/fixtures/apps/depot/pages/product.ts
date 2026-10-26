import { chart, fields, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A SKU as the floor and the buyer read it: its photo and facts, what is on
   hand and where, what is on the way, and every unit in and out. */
export const productPage = page('product', [
  fields(['sku', 'category_id.name', 'color', 'size', 'unit'], { presentation: 'facts' }),
  related('Photos', 'product_photo', 'product_id', {
    presentation: 'gallery',
    show: ['caption'],
    sort: 'position',
    limit: 6,
    width: 'half',
    empty: 'hide',
  }),
  fields(['on_hand', 'on_order', 'reorder_point', 'stock_value'], { title: 'Stock', columns: 2, width: 'half' }),
  related('Stock by location', 'stock_level', 'product_id', {
    show: ['bin_id', 'bin_id.zone', 'warehouse_id', 'qty'],
    sort: 'warehouse_id, bin_id.code',
    totals: ['qty'],
    tab: 'Stock',
  }),
  chart('Peak on hand by month', 'stock_movement', 'month moved_at', {
    whose: 'product_id',
    measure: 'max on_hand_after',
    height: 180,
    tab: 'Stock',
  }),
  related('Movement ledger', 'stock_movement', 'product_id', {
    show: ['moved_at', 'kind', 'qty', 'on_hand_after'],
    sort: 'moved_at desc',
    limit: 15,
    tab: 'Ledger',
  }),
  related('Open purchase orders', 'po_line', 'product_id', {
    query: 'open',
    show: ['purchase_order_id', 'purchase_order_id.supplier_id', 'purchase_order_id.expected_on', 'open_qty'],
    sort: 'purchase_order_id.expected_on',
    tab: 'Purchasing',
    empty: { title: 'Nothing on order', description: 'Sent purchase orders with this SKU still to arrive are listed here.' },
  }),
  related('Purchase history', 'po_line', 'product_id', {
    query: 'status = received',
    show: ['purchase_order_id', 'purchase_order_id.received_on', 'qty_received', 'unit_cost'],
    sort: 'purchase_order_id.received_on desc',
    limit: 10,
    tab: 'Purchasing',
  }),
  related('On open orders', 'order_line', 'product_id', {
    query: 'sales_order_id.shipped_at is empty',
    show: ['sales_order_id', 'sales_order_id.customer_id', 'sales_order_id.ship_by', 'qty'],
    sort: 'sales_order_id.ship_by',
    tab: 'Orders',
    empty: { title: 'No open orders want this SKU', description: 'Lines of orders not yet shipped are listed here.' },
  }),
  fields(['reorder_point', 'reorder_qty', 'home_bin_id', 'supplier_id', 'unit_cost', 'list_price', 'upc', 'weight_lb', 'status'], {
    title: 'Stocking and pricing',
    region: 'aside',
  }),
  fields(['specs'], { title: 'Specifications', region: 'aside' }),
  fields(['description'], { title: 'Description', region: 'aside', columns: 1 }),
  history(),
]) satisfies Page;
