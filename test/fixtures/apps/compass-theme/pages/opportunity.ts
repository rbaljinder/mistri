import { fields, metric, page, related, stream, timeline } from '@mistriwork/mistri/app';

export const opportunityPage = page(
  'opportunity',
  [
    fields(['name', 'stage', 'account_id', 'owner_id', 'amount', 'probability', 'close_date']),
    metric('Activities', 'activity', { whose: 'opportunity_id' }),
    metric('Open tasks', 'task', { whose: 'opportunity_id', query: 'status = open' }),
    related('Line items', 'opportunity_line', 'opportunity_id', {
      show: ['line_no', 'product_sku.name', 'qty', 'unit_price'],
    }),
    related('Tasks', 'task', 'opportunity_id', {
      show: ['subject', 'status', 'priority', 'due_on'],
      sort: 'due_on',
    }),
    timeline('Activity', [
      stream('activity', 'opportunity_id', 'happened_on', 'subject', { detail: 'kind' }),
      stream('task', 'opportunity_id', 'created_on', 'subject', { detail: 'status' }),
    ]),
    fields(['id', 'created_on'], { title: 'Record details' }),
  ],
  { listTabs: true },
);
