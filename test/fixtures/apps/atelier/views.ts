import { cards, commandForm, listView, step } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';

/* Everything an Atelier reader opens but the two dashboards (dashboards.ts).
   navigation.ts arranges them; captions are the resources' (resources.ts,
   orders.ts), so a view lists columns and paths only. */

export const views = {
  /* ---------- orders ---------- */

  orders: listView('Orders', 'sales_order', {
    icon: 'receipt',
    show: ['id', 'placed_at', 'customer_id', 'channel', 'status', 'financial_status', 'fulfillment_status', 'units', 'total_amount'],
    tabs: [
      { segment: 'open_orders', sort: 'placed_at' },
      { segment: 'to_confirm', sort: 'placed_at' },
      { segment: 'unpaid', sort: 'placed_at' },
      { segment: 'to_pack', sort: 'placed_at' },
      { segment: 'in_transit', sort: 'placed_at' },
      { segment: 'completed_orders', sort: 'placed_at desc' },
      { segment: 'cancelled_orders', sort: 'placed_at desc' },
      { label: 'All', sort: 'placed_at desc' },
    ],
    filters: ['channel', 'status', 'financial_status', 'fulfillment_status', 'location_id', 'customer_id', 'placed_at', 'discount_code'],
    totals: ['total_amount'],
    rowActions: true,
    density: 'compact',
    favorite: true,
  }),
  'new-order': commandForm(
    'New order',
    'createOrder',
    [
      step('Customer', ['customer', 'channel', 'location', 'shipping']),
      step('Items', ['lines', 'discount_code']),
      step('Payment', ['method', 'note']),
    ],
    {
      icon: 'shopping-cart',
      submitLabel: 'Place order',
      description: 'A phone or counter order: priced with the shop’s tax and shipping rules, open until it is confirmed.',
      done: { title: 'Order placed', description: 'Mark it paid and confirm it from its page; then it can be packed.' },
    },
  ),
  // The floor's board: each order's fulfillment by stage, dragged on by its verbs. A card is titled by its
  // order (`#1042 · Ana Ruiz`) and says where it ships from by name.
  fulfillment: listView('Fulfillment', 'fulfillment', {
    icon: 'package',
    query: 'status != cancelled and (status != delivered or delivered_at = last 7 days)',
    board: {
      by: 'status',
      primary: 'sales_order_id',
      footer: [
        { column: 'location_id', icon: 'storefront' },
        { column: 'carrier', icon: 'truck' },
        { column: 'tracking_number', icon: 'map-pin' },
      ],
      folded: ['delivered', 'cancelled'],
    },
    filters: ['location_id', 'carrier'],
  }),
  returns: listView('Returns', 'order_return', {
    icon: 'arrow-circle-up',
    show: ['id', 'sales_order_id', 'status', 'reason', 'requested_on', 'units', 'refund_amount'],
    tabs: [
      { segment: 'to_approve', sort: 'requested_on' },
      { segment: 'on_the_way_back', sort: 'requested_on' },
      { segment: 'to_refund', sort: 'received_at' },
      { segment: 'refunded_returns', sort: 'requested_on desc' },
      { segment: 'rejected_returns', sort: 'requested_on desc' },
      { label: 'All', sort: 'requested_on desc' },
    ],
    filters: ['reason', 'status', 'requested_on'],
    totals: ['refund_amount'],
    rowActions: true,
  }),
  payments: listView('Payments', 'payment', {
    icon: 'credit-card',
    show: ['sales_order_id', 'method', 'status', 'charge_amount', 'paid_amount', 'refunded_amount', 'paid_at'],
    tabs: [
      { segment: 'pending_payments', sort: 'id' },
      { segment: 'paid_payments', sort: 'paid_at desc' },
      { segment: 'refunded_payments', sort: 'paid_at desc' },
      { label: 'All', sort: 'id desc' },
    ],
    filters: ['method', 'status', 'paid_at'],
    totals: ['charge_amount', 'paid_amount', 'refunded_amount'],
    rowActions: true,
    density: 'compact',
  }),
  refunds: listView('Refunds', 'refund', {
    icon: 'arrow-circle-up',
    show: ['refunded_at', 'sales_order_id', 'order_return_id', 'refund_amount', 'reason', 'refunded_by'],
    sort: 'refunded_at desc',
    filters: ['refunded_at', 'refunded_by'],
    totals: ['refund_amount'],
    density: 'compact',
  }),

  /* ---------- the catalog ---------- */

  products: listView('Products', 'product', {
    icon: 'tag',
    show: ['title', 'tags', 'product_type', 'category', 'status', 'variants', 'price_from', 'on_hand', 'units_sold'],
    tabs: [
      { segment: 'active', sort: 'title' },
      { segment: 'drafts', sort: 'created_on desc' },
      { segment: 'archived', sort: 'title' },
      { label: 'All', sort: 'title' },
    ],
    filters: ['title', 'category', 'product_type', 'vendor', 'tags'],
    density: 'compact',
    favorite: true,
  }),
  // The catalog as the shop floor sees it: a photo, a price, what is in stock.
  lookbook: listView('Lookbook', 'product', {
    icon: 'bookmark-simple',
    query: 'status = active',
    presentation: cards('title', {
      value: 'price_from',
      facts: ['product_type', 'on_hand'],
      properties: ['vendor'],
      image: { from: 'product_image', whose: 'product_id', sort: 'position' },
    }),
    filterBar: 'rail',
    filters: ['category', 'product_type', 'vendor', 'tags'],
    sort: [
      { label: 'Name', sort: 'title' },
      { label: 'Lowest price', sort: 'price_from' },
      { label: 'Highest price', sort: 'price_from desc' },
      { label: 'Best selling', sort: 'units_sold desc' },
      { label: 'Newest', sort: 'created_on desc' },
    ],
  }),
  collections: listView('Collections', 'collection', {
    icon: 'stack',
    show: ['title', 'published', 'products', 'created_on'],
    sort: 'title',
  }),
  variants: listView('Variants', 'variant', {
    icon: 'list',
    // The product leads, its SKU the second line under it (resources.ts), as an order's line reads it.
    show: ['product_id', 'color', 'size', 'price_amount', 'compare_at_amount', 'on_hand', 'reorder_point', 'sold'],
    // A markdown is a price changed in place, or a selection's compare-at set at once.
    editable: ['price_amount', 'compare_at_amount', 'reorder_point'],
    tabs: [
      { segment: 'active_variants', sort: 'sku' },
      { segment: 'on_sale', sort: 'sku' },
      { segment: 'inactive', sort: 'sku' },
    ],
    filters: ['product_id', 'color', 'size', 'price_amount'],
    density: 'compact',
  }),
  tags: listView('Tags', 'tag', {
    icon: 'tag',
    show: ['name', 'tone', 'products'],
    sort: 'name',
  }),

  /* ---------- stock ---------- */

  'low-stock': listView('Low stock', 'variant', {
    icon: 'warning',
    query: 'active = true and product_id.status = active and on_hand <= reorder_point',
    show: ['product_id', 'color', 'size', 'on_hand'],
    sort: 'on_hand',
    empty: { title: 'Every variant is above its reorder point', description: 'A variant at or under its reorder point is listed here.' },
  }),
  inventory: listView('Inventory', 'inventory_level', {
    icon: 'stack',
    show: ['variant_id', 'variant_id.product_id', 'location_id', 'on_hand'],
    tabs: [
      { segment: 'in_stock', sort: 'variant_id.sku' },
      { segment: 'out_of_stock', sort: 'variant_id.sku' },
      { label: 'All', sort: 'variant_id.sku' },
    ],
    filters: ['location_id', 'variant_id', 'on_hand'],
    totals: ['on_hand'],
    rowActions: true,
    density: 'compact',
  }),
  movements: listView('Movements', 'inventory_movement', {
    icon: 'arrows-left-right',
    show: ['moved_at', 'kind', 'reference', 'variant_id', 'location_id', 'quantity', 'on_hand_after', 'reason', 'moved_by'],
    sort: 'moved_at desc',
    tabs: [{ label: 'All' }, 'received', 'fulfilled', 'returned', 'adjusted', 'mine'],
    filters: ['kind', 'location_id', 'variant_id', 'moved_at'],
    totals: ['quantity'],
    density: 'compact',
  }),
  locations: listView('Locations', 'location', {
    icon: 'buildings',
    show: ['name', 'code', 'kind', 'city', 'state', 'units', 'stocked', 'to_pack', 'to_ship'],
    sort: 'id',
  }),

  /* ---------- customers and offers ---------- */

  // The people who sell: the warehouse reads a customer only as far as a parcel needs (app.ts).
  customers: listView('Customers', 'customer', {
    icon: 'users',
    roles: ['staff', 'owner', 'admin'],
    show: ['name', 'email', 'city', 'state', 'orders', 'spent', 'last_order', 'accepts_marketing'],
    tabs: [
      { label: 'All', sort: 'name' },
      { segment: 'best_customers', sort: 'spent desc' },
      { segment: 'email_offers', sort: 'name' },
      { segment: 'new_this_month', sort: 'created_on desc' },
    ],
    // Lifetime orders and spend are rollups, and filter as any number does: a Min and a Max.
    filters: ['state', 'city', 'orders', 'spent', 'accepts_marketing', 'created_on'],
    density: 'compact',
  }),
  discounts: listView('Discounts', 'discount', {
    icon: 'ticket',
    show: ['code', 'description', 'kind', 'percent_off', 'amount_off_amount', 'starts_on', 'ends_on', 'uses', 'given', 'active'],
    tabs: [
      { segment: 'active_codes', sort: 'code' },
      { label: 'All', sort: 'code' },
    ],
  }),
} satisfies Views;
