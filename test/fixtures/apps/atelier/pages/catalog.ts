import { chart, fields, history, metric, page, related } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* The catalog and the people who buy from it: a product with its photos,
   its variants and how it sells; a variant with its stock at each location
   and its ledger; a customer with their orders and returns. */
export const catalogPages = {
  product: page('product', [
    fields(['product_type', 'category', 'vendor', 'price_from', 'price_to'], { presentation: 'facts' }),
    related('Photos', 'product_image', 'product_id', {
      presentation: 'gallery',
      show: ['alt'],
      sort: 'position',
      limit: 6,
      width: 'half',
      empty: 'hide',
    }),
    fields(['on_hand', 'variants', 'units_sold', 'revenue'], { title: 'At a glance', columns: 2, width: 'half' }),
    related('Variants', 'variant', 'product_id', {
      show: ['sku', 'color', 'size', 'on_hand'],
      sort: 'position',
      limit: 60,
      create: { label: 'Add variant', show: ['sku', 'color', 'size', 'price_amount', 'cost_amount'] },
    }),
    // A line names its variant; the product is the hop past it.
    chart('Units sold by month', 'order_line', 'month sales_order_id.placed_at', {
      whose: 'variant_id.product_id',
      query: 'sold',
      measure: 'sum quantity',
      height: 180,
      tab: 'Sales',
    }),
    related('Recent orders', 'order_line', 'variant_id.product_id', {
      show: ['sales_order_id', 'sku', 'quantity', 'line_amount'],
      sort: 'id desc',
      limit: 10,
      tab: 'Sales',
    }),
    related('Collections', 'collection_product', 'product_id', {
      show: ['collection_id'],
      tab: 'Collections',
      empty: { title: 'In no collection', description: 'Add it to a collection from the collection’s page.' },
    }),
    fields(['description'], { title: 'Description', region: 'aside', columns: 1 }),
    fields(['material', 'care', 'handle', 'status', 'created_on'], { title: 'Material and care', region: 'aside' }),
    history(),
  ]),
  variant: page('variant', [
    fields(['product_id', 'price_amount', 'on_hand']),
    related('Stock by location', 'inventory_level', 'variant_id', {
      show: ['location_id', 'on_hand'],
      sort: 'location_id',
      totals: ['on_hand'],
      rowActions: true,
    }),
    chart('Units on hand after each move, by month', 'inventory_movement', 'month moved_at', {
      whose: 'variant_id',
      measure: 'min on_hand_after',
      height: 160,
    }),
    related('Ledger', 'inventory_movement', 'variant_id', {
      show: ['moved_at', 'location_id', 'quantity'],
      sort: 'moved_at desc',
      limit: 20,
    }),
    fields(['color', 'size', 'sku', 'barcode', 'compare_at_amount', 'cost_amount', 'reorder_point', 'active'], {
      title: 'Variant',
      region: 'aside',
    }),
    history(undefined, { limit: 6 }),
  ]),
  customer: page(
    'customer',
    [
      fields(['email', 'phone', 'city', 'state'], { presentation: 'facts' }),
      fields(['orders', 'spent', 'last_order']),
      related('Orders', 'sales_order', 'customer_id', {
        show: ['id', 'status', 'total_amount', 'refunded'],
        sort: 'placed_at desc',
        // What was spent and what came back, over every order: `refunded` is each order's rollup of its refunds.
        totals: ['total_amount', 'refunded'],
        limit: 20,
      }),
      fields(['address', 'zip', 'accepts_marketing', 'created_on', 'note'], { title: 'Customer', region: 'aside' }),
      history(undefined, { limit: 6 }),
    ],
    { roles: ['staff', 'owner', 'admin'] },
  ),
  collection: page('collection', [
    fields(['description'], { columns: 1 }),
    related('Products', 'collection_product', 'collection_id', {
      show: ['product_id', 'product_id.price_from', 'product_id.on_hand', 'position'],
      sort: 'position',
      limit: 60,
      create: { label: 'Add product', show: ['product_id', 'position'] },
    }),
    fields(['handle', 'published', 'created_on'], { title: 'Collection', region: 'aside' }),
  ]),
  discount: page('discount', [
    fields(['description', 'uses', 'given']),
    related('Orders', 'sales_order', 'discount_id', {
      show: ['id', 'customer_id', 'discount_amount', 'total_amount'],
      sort: 'placed_at desc',
      totals: ['discount_amount', 'total_amount'],
      limit: 20,
    }),
    fields(['kind', 'percent_off', 'amount_off_amount', 'min_subtotal_amount', 'starts_on', 'ends_on', 'usage_limit', 'active'], {
      title: 'Discount',
      region: 'aside',
    }),
    history(undefined, { limit: 6 }),
  ]),
} satisfies Pages;
