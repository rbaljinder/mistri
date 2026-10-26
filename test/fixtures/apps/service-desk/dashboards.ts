import { breakdown, chart, dashboard, metric, rows } from '@mistriwork/mistri/app';

export const operations = dashboard('Operations', [
  metric('Active incidents', 'incident', {
    query: 'status != resolved and status != closed',
    width: 'third',
  }),
  metric('Critical incidents', 'incident', {
    query: 'priority = critical and status != resolved and status != closed',
    width: 'third',
  }),
  metric('Changes awaiting authorization', 'change_request', {
    query: 'status = authorize',
    width: 'third',
  }),
  chart('Incidents opened by day (all time)', 'incident', 'day opened_at as opened_day', {
    width: 'half',
  }),
  chart('Active incidents by priority', 'incident', 'priority', {
    shape: 'donut',
    query: 'status != resolved and status != closed',
    width: 'half',
  }),
  rows('Priority response', 'incident', {
    show: ['reference', 'name', 'priority', 'service_id.name', 'assignee_id.name'],
    limit: 8,
    query: 'priority = critical and status != resolved and status != closed',
  }),
  breakdown('Active incidents by support team', 'incident', 'team_id.name', {
    query: 'status != resolved and status != closed',
    width: 'half',
  }),
  rows('Change windows', 'change_request', {
    show: ['reference', 'name', 'starts_at', 'risk', 'status'],
    limit: 6,
    query: 'status != closed and status != canceled',
    sort: 'starts_at',
    width: 'half',
  }),
  rows('Service health', 'service', {
    show: ['name', 'status', 'team_id.name'],
    limit: 6,
    width: 'half',
  }),
  rows('Fulfillment queue', 'fulfillment_task', {
    show: ['name', 'status', 'assignee_id.name', 'due_on'],
    limit: 6,
    query: 'status != done',
    width: 'half',
  }),
  rows('Pending budget reviews', 'request_approval', {
    show: ['name', 'request_id.name', 'reviewer_id.name'],
    limit: 6,
    query: 'decision = pending',
    width: 'half',
  }),
]);

export const serviceCatalog = dashboard('Service catalog', [
  rows('Hardware', 'catalog_item', {
    show: ['name', 'description', 'price', 'fulfillment_days'],
    limit: 8,
    query: 'category_id = 1 and active = true',
    width: 'half',
  }),
  rows('Access', 'catalog_item', {
    show: ['name', 'description', 'fulfillment_days', 'approval_required'],
    limit: 8,
    query: 'category_id = 2 and active = true',
    width: 'half',
  }),
  rows('Software', 'catalog_item', {
    show: ['name', 'description', 'price', 'fulfillment_days'],
    limit: 8,
    query: 'category_id = 3 and active = true',
    width: 'half',
  }),
  rows('Workplace', 'catalog_item', {
    show: ['name', 'description', 'price', 'fulfillment_days'],
    limit: 8,
    query: 'category_id = 4 and active = true',
    width: 'half',
  }),
]);
