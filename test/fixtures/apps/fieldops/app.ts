/**
 * Field Ops in TypeScript, with the schema's own names: run on Node's
 * native type stripping, checked against mistri-schema.d.ts (from
 * `tablewalk --export types`), so a mistyped table or display key
 * squiggles here before the server ever refuses it. Every helper still
 * returns exactly the JSON it stands for; the server parses the result
 * through the same door.
 */
import { breakdown, defineApp, fields, listView, metric, navGroup, page, related } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { opsBoard } from './board.ts';
import { customerPage } from './pages/customer.ts';

export default defineApp({
  id: 'fieldops',
  name: 'Field Ops',

  resources: {
    work_order: {
      segments: {
        open: 'status = open',
        in_progress: 'status = in_progress',
        on_hold: 'status = on_hold or status = awaiting_parts',
        done: 'status = completed',
      },
      display: {
        status: {
          tone: {
            open: 'info',
            in_progress: 'info',
            scheduled: 'info',
            on_hold: 'warn',
            awaiting_parts: 'warn',
            completed: 'good',
            cancelled: 'bad',
          },
        },
        total_cost: { format: 'money' },
        priority: { tone: { '>= 5': 'bad', '>= 4': 'warn' } },
      },
      labels: {
        customer_id: 'Customer',
        assigned_to: 'Engineer',
        due_on: 'Due',
      },
    },
    invoice: {
      segments: {
        draft: 'status = draft',
        issued: 'status = issued',
        paid: 'status = paid',
      },
      display: {
        total: { format: 'money' },
        status: { tone: { paid: 'good', void: 'bad', issued: 'info', draft: 'warn' } },
      },
      labels: { customer_id: 'Customer', invoice_date: 'Date' },
    },
    customer: {
      labels: { country_code: 'Country' },
    },
    shipment: {
      segments: {
        waiting: 'shipped_on is empty',
        shipped: 'shipped_on is not empty',
      },
    },
    employee: {},
    product: {},
    work_order_note: {},
    work_order_part: {},
  },

  views: {
    'ops-board': opsBoard,

    'work-orders': listView('Work orders', 'work_order', {
      advancedFilters: true,
      show: ['reference', 'status', 'priority', 'customer_id', 'assigned_to', 'due_on'],
      filters: ['status', 'priority', 'is_urgent'],
      tabs: [
        { segment: 'open', sort: 'due_on' },
        { segment: 'in_progress', sort: 'due_on' },
        'on_hold',
        { segment: 'done', sort: 'closed_on desc' },
        { label: 'All', sort: 'opened_on desc' },
      ],
    }),

    'urgent-orders': listView('Urgent orders', 'work_order', {
      query: 'is_urgent = true and status != completed and status != cancelled',
      show: ['reference', 'customer_id.name', 'status', 'priority', 'due_on'],
      filters: ['status', 'priority'],
      /* Triage reads at a glance; the full Work orders entry keeps the
         page. Same table, two doors, two presentations. */
      open: 'drawer',
    }),

    shipments: listView('Shipments', 'shipment', {
      open: 'drawer',
      tabs: ['waiting', { segment: 'shipped', sort: 'shipped_on desc' }, { label: 'All' }],
    }),
    invoices: listView('Invoices', 'invoice', {
      show: ['id', 'customer_id', 'invoice_date', 'status', 'total'],
      tabs: [
        'draft',
        { segment: 'issued', sort: 'invoice_date desc' },
        { segment: 'paid', sort: 'invoice_date desc' },
        { label: 'All', sort: 'invoice_date desc' },
      ],
    }),
    customers: listView('Customers', 'customer', {
      show: ['name', 'email', 'country_code', 'credit_limit'],
    }),
    engineers: listView('Engineers', 'employee'),
    products: listView('Products', 'product', { open: 'modal' }),
  },

  home: 'ops-board',
  nav: [
    navGroup('operations', 'Operations', ['ops-board', 'work-orders', 'urgent-orders', 'shipments', 'invoices']),
    navGroup('directory', 'Directory', ['customers', 'engineers', 'products']),
  ],

  pages: {
    'work-order': page(
      'work_order',
      [
        fields([], { width: 'full' }),
        fields(['customer_id.name', 'customer_id.email', 'customer_id.country_code', 'customer_id.credit_limit'], {
          title: 'Customer',
          width: 'half',
        }),
        breakdown("This customer's work orders", 'work_order', 'status', { about: 'customer_id', whose: 'customer_id', width: 'half' }),
        metric('Notes', 'work_order_note', { whose: 'work_order_id', width: 'third' }),
        metric('Parts used', 'work_order_part', { measure: 'sum quantity', whose: 'work_order_id', width: 'third' }),
        related('Notes', 'work_order_note', 'work_order_id', { show: ['written_on', 'body'], sort: 'written_on desc' }),
        related('Parts', 'work_order_part', 'work_order_id', { show: ['line_no', 'sku', 'quantity'] }),
        related(
          "Customer's invoices",
          'invoice',
          { same: ['customer_id'] },
          { show: ['invoice_date', 'status', 'total'], sort: 'invoice_date desc' },
        ),
      ],
      {
        listTabs: true,
      },
    ),
    customer: customerPage,
  },

  ui: { theme: { accent: '#4f46e5' }, export: false },
} satisfies App);
