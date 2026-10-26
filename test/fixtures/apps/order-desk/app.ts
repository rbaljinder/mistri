/*
 * Order desk: the browser gate's own App for an order and its lines — money
 * kept in cents with each order's currency, the lines asked as a grid on the
 * New form and edited in place on the record, and the totals said live as the
 * form is filled in (e2e/order-lines.spec.ts). Owned by the test suite, sized
 * to that one spec: two orders, one in dollars and one in yen. Do not grow it
 * to demonstrate a feature; author a fixture beside it, or a public sample.
 */
import { computed, defineApp, fields, listView, page, related, sum } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

const money = { format: 'money', minor: true, currency: { column: 'currency' } } as const;

export default defineApp({
  id: 'order-desk',
  name: 'Order desk',
  sources: { shop: { connection: 'shop' } },
  resources: {
    order_line: {
      noun: 'line',
      access: 'write',
      delete: true,
      computed: { line_total: computed.number('quantity * unit_price') },
      validation: [{ must: 'quantity > 0', message: 'Order at least one.' }],
      display: { unit_price: { format: 'money', minor: true } },
    },
    sales_order: {
      noun: 'order',
      access: 'write',
      rollups: { subtotal: sum('order_line', 'line_total') },
      computed: { total: computed.number('subtotal + shipping') },
      display: { shipping: money, subtotal: money, total: money },
      form: {
        show: ['customer', 'currency', 'shipping'],
        lines: [
          { label: 'Lines', from: 'order_line', whose: 'order_id', show: ['product', 'quantity', 'unit_price'], order: 'position', min: 1 },
        ],
        live: ['subtotal', 'total'],
      },
    },
  },
  views: {
    orders: listView('Orders', 'sales_order', { show: ['customer', 'currency', 'shipping', 'total'] }),
  },
  pages: {
    order: page('sales_order', [
      fields(['customer', 'currency', 'shipping', 'subtotal', 'total'], { columns: 2 }),
      related('Lines', 'order_line', 'order_id', { show: ['product', 'quantity', 'unit_price'] }),
    ]),
  },
  home: 'orders',
  nav: ['orders'],
  ui: { currency: 'USD', locale: 'en-US' },
} satisfies App);
