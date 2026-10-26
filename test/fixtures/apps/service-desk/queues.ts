import { board, dashboard, rows } from '@mistriwork/mistri/app';

export const incidentTriage = dashboard('Incident triage', [
  board('Active incidents by status', 'incident', 'status', {
    query: 'status != resolved and status != closed',
    primary: 'name',
    lines: ['reference', 'priority', 'assignee_id.name'],
    sort: 'due_at',
    limit: 4,
  }),
  rows('Critical response', 'incident', {
    query: 'priority = critical and status != resolved and status != closed',
    sort: 'due_at',
    show: ['reference', 'name', 'team_id.name', 'assignee_id.name', 'due_at'],
    limit: 8,
  }),
]);

export const changeQueue = dashboard('Change queue', [
  board('Active changes by status', 'change_request', 'status', {
    query: 'status != closed and status != canceled',
    primary: 'name',
    lines: ['reference', 'risk', 'owner_id.name'],
    sort: 'starts_at',
    limit: 3,
  }),
  rows('Pending change reviews', 'change_approval', {
    query: 'decision = pending',
    show: ['name', 'change_id.name', 'change_id.status', 'reviewer_id.name'],
    limit: 6,
    width: 'half',
  }),
  rows('Outstanding change tasks', 'change_task', {
    query: 'status != done',
    sort: 'due_at',
    show: ['name', 'change_id.name', 'change_id.status', 'status', 'due_at'],
    limit: 6,
    width: 'half',
  }),
]);

export const fulfillmentQueue = dashboard('Fulfillment queue', [
  board('Active requests by status', 'service_request', 'status', {
    query: 'status != completed and status != canceled',
    primary: 'name',
    lines: ['reference', 'requested_for.name', 'needed_on'],
    sort: 'needed_on',
    limit: 3,
  }),
  rows('Outstanding fulfillment tasks', 'fulfillment_task', {
    query: 'status != done',
    sort: 'due_on',
    show: ['name', 'request_item_id.request_id.name', 'request_item_id.request_id.status', 'status', 'due_on'],
    limit: 8,
    width: 'half',
  }),
  rows('Orders awaiting receipt', 'purchase_order', {
    query: 'status = issued or status = part_received',
    sort: 'expected_on',
    show: ['reference', 'name', 'vendor_id.name', 'status', 'expected_on'],
    limit: 6,
    width: 'half',
  }),
]);
