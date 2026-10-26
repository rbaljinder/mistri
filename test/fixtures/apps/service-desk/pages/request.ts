import { fields, page, related } from '@mistriwork/mistri/app';

export const requestPage = page(
  'service_request',
  [
    fields(['reference', 'status', 'requested_for', 'department_id', 'opened_at', 'needed_on'], { columns: 3 }),
    fields(['name', 'justification'], {
      title: 'Business need',
      columns: 1,
    }),
    related('Requested items', 'request_item', 'request_id', {
      create: {
        label: 'Add requested item',
        show: ['name', 'catalog_item_id', 'quantity', 'specifications'],
      },
      show: ['name', 'catalog_item_id.name', 'quantity', 'status', 'specifications'],
    }),
    related('Budget reviews', 'request_approval', 'request_id', {
      show: ['name', 'reviewer_id.name', 'decision', 'rationale'],
    }),
    related('Fulfillment', 'fulfillment_task', 'request_item_id.request_id', {
      show: ['name', 'status', 'assignee_id.name', 'due_on'],
    }),
    related('Order lines', 'order_line', 'request_item_id.request_id', {
      show: ['name', 'order_id.name', 'quantity', 'received_quantity'],
    }),
  ],
  { listTabs: true },
);
