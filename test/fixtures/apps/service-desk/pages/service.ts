import { fields, metric, page, related } from '@mistriwork/mistri/app';

export const servicePage = page(
  'service',
  [
    fields(['name', 'status', 'criticality', 'owner_id', 'team_id', 'vendor_id'], { columns: 3 }),
    fields(['description'], {
      columns: 1,
    }),
    metric('Active incidents', 'incident', {
      whose: 'service_id',
      query: 'status != resolved and status != closed',
      width: 'third',
    }),
    metric('Active changes', 'change_request', {
      whose: 'service_id',
      query: 'status != closed and status != canceled',
      width: 'third',
    }),
    metric('Assets', 'asset', {
      whose: 'service_id',
      width: 'third',
    }),
    related('Incidents', 'incident', 'service_id', {
      show: ['reference', 'name', 'priority', 'status'],
    }),
    related('Changes', 'change_request', 'service_id', {
      show: ['reference', 'name', 'status', 'starts_at'],
    }),
    related('Assets', 'asset', 'service_id', {
      show: ['name', 'asset_tag', 'kind', 'status'],
    }),
    related('Knowledge', 'knowledge_article', 'service_id', {
      show: ['name', 'summary', 'status'],
    }),
  ],
  { listTabs: true },
);
