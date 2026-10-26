/**
 * The Ops board, in its own file: an app.mjs is a real module graph, so
 * a screen can live where a screen-sized thing belongs and the manifest
 * stays a table of contents. Hot reload evaluates the whole graph fresh
 * — edit this file, save, refresh.
 */
import { board, breakdown, chart, dashboard, matrix, metric, rows } from '@mistriwork/mistri/app';
import type { TypedDashboardView } from '@mistriwork/mistri/app';
import type { Tables } from './mistri-schema.d.ts';

export const opsBoard = dashboard(
  'Ops board',
  [
    metric('Open orders', 'work_order', { query: 'status = open', over: 'opened_on', spark: true }),
    metric('Shipments', 'shipment'),
    breakdown('Orders by status', 'work_order', 'status', { width: 'half', over: 'opened_on', to: 'work-orders' }),
    chart('Orders per month', 'work_order', 'month opened_on', {
      query: 'opened_on = last 12 months',
      width: 'half',
    }),
    matrix('Orders: status × month', 'work_order', 'status, month opened_on', {
      query: 'opened_on = last 6 months',
      to: 'work-orders',
    }),
    /* The pipeline read: lanes from status's own vocabulary, a card per
     order, the record one click away through the entry's own door. */
    board('Order flow', 'work_order', 'status', {
      primary: 'reference',
      lines: ['customer_id.name'],
      limit: 4,
    }),
    rows('Newest orders', 'work_order', {
      show: ['reference', 'customer_id.name', 'status'],
      sort: 'id desc',
      limit: 5,
      width: 'half',
      over: 'opened_on',
    }),
    rows('Recent invoices', 'invoice', {
      show: ['customer_id.name', 'total', 'status', 'invoice_date'],
      sort: 'invoice_date desc',
      limit: 5,
      width: 'half',
      over: 'invoice_date',
    }),
  ],
  { filters: ['status', 'customer_id'] },
) satisfies TypedDashboardView<Tables>;
