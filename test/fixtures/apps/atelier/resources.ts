import { action, count, max, min, sum } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';
import { orderResources } from './orders.ts';

/* What Atelier says about its catalog, its stock and its customers, once:
   captions, how values dress, the numbers rolled up from the rows that point
   at each, and the verbs a record offers. The order side — an order, its
   payment, its fulfillment and its returns, each with its own machine — is
   orders.ts. */

const usd = { format: 'money' } as const;
const units = { format: 'number' } as const;

export const resources = {
  /* ---------- the catalog ---------- */
  product: {
    segments: {
      active: 'status = active',
      drafts: 'status = draft',
      archived: 'status = archived',
    },
    access: 'write',
    favorite: true,
    // A new season arrives as a spreadsheet from the buying team: Import beside New, each row a new product.
    import: true,
    recordLabel: '{title}',
    tags: { through: 'product_tag', to: 'tag', toneOf: 'tone' },
    rollups: {
      variants: count('variant', { query: 'active = true' }),
      // A rollup of a rollup: each variant's units across the three locations, summed.
      on_hand: sum('variant', 'on_hand'),
      price_from: min('variant', 'price_amount'),
      price_to: max('variant', 'price_amount'),
      // A line names its variant; the product is one hop further, and a cancelled order sold nothing.
      units_sold: sum('order_line', 'quantity', { whose: 'variant_id.product_id', query: 'sold' }),
      revenue: sum('order_line', 'line_amount', { whose: 'variant_id.product_id', query: 'sold' }),
      images: count('product_image'),
    },
    display: {
      status: { tone: { active: 'good', draft: 'info', archived: 'neutral' } },
      price_from: usd,
      price_to: usd,
      revenue: usd,
      on_hand: units,
      units_sold: units,
      // Its first picture beside its name, here and wherever a variant is named through it (an order's lines).
      title: { avatar: { from: 'product_image', whose: 'product_id', sort: 'position' } },
    },
    labels: {
      title: 'Product',
      product_type: 'Type',
      price_from: 'From',
      price_to: 'To',
      created_on: 'Added',
    },
    form: {
      defaults: { category: 'apparel', vendor: 'Atelier' },
      groups: [
        { label: 'Product', fields: ['title', 'handle', 'product_type', 'category', 'vendor', 'status'] },
        { label: 'Description', fields: ['description', 'material', 'care'] },
      ],
    },
    actions: {
      publish: action('Publish', { set: { status: 'active' }, when: 'status = draft' }),
      archive: action('Archive', { set: { status: 'archived' }, when: 'status = active', confirm: true }),
      restore: action('Restore', { set: { status: 'active' }, when: 'status = archived' }),
    },
  },
  product_image: {
    access: 'write',
    delete: true,
    noun: 'image',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail', maxBytes: 5_000_000 },
    labels: { position: 'Order', file_name: 'File', byte_size: 'Size', alt: 'Description' },
  },
  tag: {
    access: 'write',
    recordLabel: '{name}',
    rollups: { products: count('product_tag') },
    labels: { name: 'Tag' },
  },
  product_tag: { access: 'write', delete: true, noun: 'product tag' },
  collection: {
    access: 'write',
    recordLabel: '{title}',
    rollups: { products: count('collection_product') },
    display: { published: { tone: { true: 'good', false: 'neutral' } } },
    labels: { title: 'Collection' },
    form: { show: ['title', 'handle', 'description', 'published'], defaults: { published: false } },
  },
  collection_product: {
    access: 'write',
    delete: true,
    recordLabel: '{product_id.title}',
    noun: 'collection product',
    labels: { position: 'Order' },
  },
  variant: {
    segments: {
      active_variants: { query: 'active = true', label: 'Active' },
      on_sale: 'active = true and compare_at_amount is not empty',
      inactive: 'active = false',
    },
    access: 'write',
    // Prices change by the sheet at the start of a sale: Import matches each row to its variant by SKU.
    import: true,
    // Named as the order's line says it, so a picker, a ledger row and the line all read alike; the SKU is its second line.
    recordLabel: '{product_id.title} · {color} / {size}',
    rollups: {
      on_hand: sum('inventory_level', 'on_hand'),
      sold: sum('order_line', 'quantity', { query: 'sold' }),
      last_moved: max('inventory_movement', 'moved_at'),
    },
    display: {
      product_id: { subtitle: 'sku' },
      on_hand: { format: 'number', tone: { '= 0': 'bad', '< 4': 'warn' } },
      sold: units,
      reorder_point: units,
      last_moved: { format: 'relative' },
      barcode: { scan: true },
    },
    labels: {
      price_amount: 'Price',
      compare_at_amount: 'Compare at',
      cost_amount: 'Cost',
      reorder_point: 'Reorder at',
      position: 'Order',
    },
    form: { defaults: { active: true, reorder_point: 3 } },
    validation: [
      { must: 'price_amount >= cost_amount', message: 'A variant sells for at least what it costs.' },
      { must: 'compare_at_amount is empty or compare_at_amount > price_amount', message: 'A compare-at price is above the price.' },
    ],
  },

  /* ---------- stock: written only by commands, into the ledger ---------- */
  location: {
    recordLabel: '{name}',
    rollups: {
      units: sum('inventory_level', 'on_hand'),
      stocked: count('inventory_level', { query: 'on_hand > 0' }),
      to_pack: count('fulfillment', { query: 'status = pending' }),
      to_ship: count('fulfillment', { query: 'status = packed' }),
    },
    display: { kind: { tone: { store: 'info', warehouse: 'neutral' } }, units },
    labels: { name: 'Location', ships_online: 'Ships online orders', stocked: 'Variants in stock' },
  },
  inventory_level: {
    segments: {
      in_stock: 'on_hand > 0',
      out_of_stock: 'on_hand = 0 and variant_id.active = true',
    },
    access: 'write',
    recordLabel: '{variant_id.sku} at {location_id.code}',
    noun: { one: 'stock level', many: 'stock levels' },
    display: { on_hand: { format: 'number', tone: { '= 0': 'bad', '< 3': 'warn' } } },
    actions: {
      receive: action('Receive', { command: 'receiveStock' }),
      adjust: action('Adjust', { command: 'adjustStock' }),
    },
  },
  inventory_movement: {
    segments: {
      received: 'kind = received',
      fulfilled: 'kind = fulfilled',
      returned: 'kind = returned',
      adjusted: 'kind = adjusted',
      mine: 'moved_by = me',
    },
    access: 'write',
    recordLabel: '{reference} · {variant_id.sku}',
    noun: 'movement',
    display: {
      quantity: units,
      on_hand_after: units,
      kind: {
        tone: { adjusted: 'warn', returned: 'info', '*': 'neutral' },
        icons: { received: 'truck', fulfilled: 'package', returned: 'arrow-circle-down', adjusted: 'sliders' },
      },
    },
    labels: {
      moved_at: 'When',
      kind: 'Movement',
      moved_by: 'By',
      order_return_id: 'Return',
    },
  },

  /* ---------- customers and offers ---------- */
  customer: {
    segments: {
      best_customers: 'spent >= 1000',
      email_offers: 'accepts_marketing = true',
      new_this_month: 'created_on = last 30 days',
    },
    access: 'write',
    favorite: true,
    recordLabel: '{name}',
    rollups: {
      orders: count('sales_order', { query: 'live' }),
      spent: sum('sales_order', 'total_amount', { query: 'live' }),
      last_order: max('sales_order', 'placed_at'),
    },
    display: { spent: usd, last_order: { format: 'relative' }, accepts_marketing: { tone: { true: 'good', false: 'neutral' } } },
    labels: {
      name: 'Customer',
      zip: 'ZIP',
      accepts_marketing: 'Email offers',
      created_on: 'Customer since',
    },
    form: {
      show: ['name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'accepts_marketing', 'note'],
      defaults: { accepts_marketing: false },
    },
  },
  discount: {
    segments: {
      active_codes: { query: 'active = true', label: 'Active' },
    },
    access: 'write',
    recordLabel: '{code}',
    rollups: {
      uses: count('sales_order', { query: 'live' }),
      given: sum('sales_order', 'discount_amount', { query: 'live' }),
      sales: sum('sales_order', 'total_amount', { query: 'live' }),
    },
    display: {
      percent_off: { unit: '%' },
      given: usd,
      sales: usd,
      active: { tone: { true: 'good', false: 'neutral' } },
      kind: { values: { percent: 'Percent off', fixed: 'Amount off' } },
    },
    labels: {
      amount_off_amount: 'Amount off',
      min_subtotal_amount: 'Minimum subtotal',
      usage_limit: 'Use limit',
      given: 'Discount given',
      sales: 'Sales with it',
    },
    form: {
      show: [
        'code',
        'description',
        'kind',
        'percent_off',
        'amount_off_amount',
        'min_subtotal_amount',
        'starts_on',
        'ends_on',
        'usage_limit',
        'active',
      ],
      defaults: { kind: 'percent', active: true, min_subtotal_amount: 0 },
    },
    validation: [
      { must: 'ends_on is empty or ends_on >= starts_on', message: 'A discount ends on or after the day it starts.' },
      { must: 'kind = fixed or percent_off > 0', message: 'A percent discount takes a percent off.' },
      { must: 'kind = percent or amount_off_amount > 0', message: 'An amount-off discount takes an amount off.' },
    ],
    actions: {
      pause: action('Pause', { set: { active: false }, when: 'active = true' }),
      resume: action('Resume', { set: { active: true }, when: 'active = false' }),
    },
  },
  ...orderResources,
} satisfies Resources;
