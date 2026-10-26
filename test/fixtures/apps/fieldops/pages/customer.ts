import { breakdown, fields, page, related } from '@mistriwork/mistri/app';

export const customerPage = page(
  'customer',
  [
    fields([], { width: 'full' }),
    breakdown('Work orders by status', 'work_order', 'status', { whose: 'customer_id', width: 'half' }),
    breakdown('Invoices by status', 'invoice', 'status', { whose: 'customer_id', width: 'half' }),
    related('Work orders', 'work_order', 'customer_id', {
      show: ['reference', 'status', 'opened_on'],
      sort: 'opened_on desc',
    }),
    related('Invoices', 'invoice', 'customer_id', { show: ['invoice_date', 'status', 'total'] }),
  ],
  { listTabs: true },
);
