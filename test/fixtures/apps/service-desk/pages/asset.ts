import { fields, page, related } from '@mistriwork/mistri/app';

export const assetPage = page(
  'asset',
  [
    fields(['name', 'asset_tag', 'kind', 'status', 'service_id', 'location_id', 'assigned_to', 'vendor_id', 'purchased_on'], {
      columns: 3,
    }),
    related('Dependencies', 'asset_relation', 'asset_id', {
      show: ['depends_on.name', 'kind'],
    }),
    related('Used by', 'asset_relation', 'depends_on', {
      show: ['asset_id.name', 'kind'],
    }),
    related('Incidents', 'incident', 'asset_id', {
      show: ['reference', 'name', 'priority', 'status'],
    }),
  ],
  { listTabs: true },
);
