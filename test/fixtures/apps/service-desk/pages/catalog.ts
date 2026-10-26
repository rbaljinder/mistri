import { fields, page, related } from '@mistriwork/mistri/app';

export const catalogPage = page('catalog_item', [
  fields(['name', 'category_id', 'price', 'fulfillment_days', 'approval_required', 'service_id'], { columns: 3 }),
  fields(['description'], {
    title: 'Service offering',
    columns: 1,
  }),
  related('Requested items', 'request_item', 'catalog_item_id', {
    create: {
      label: 'Add to request',
      show: ['name', 'request_id', 'quantity', 'specifications'],
    },
    show: ['name', 'request_id.name', 'quantity', 'status'],
  }),
]);
