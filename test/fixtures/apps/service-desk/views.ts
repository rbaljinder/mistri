import { listView } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { operations, serviceCatalog } from './dashboards.ts';
import { changeQueue, fulfillmentQueue, incidentTriage } from './queues.ts';

/* Everything Service Atlas opens: the dashboards and queues, and a module
   per record type with its filters and tabs. navigation.ts arranges them;
   the New forms and record actions are the resources' (resources.ts). */
export const views = {
  operations,
  'incident-triage': incidentTriage,
  'change-queue': changeQueue,
  'service-catalog': serviceCatalog,
  'fulfillment-queue': fulfillmentQueue,
  incidents: listView('Incidents', 'incident', {
    show: ['reference', 'name', 'priority', 'status', 'service_id.name', 'assignee_id.name', 'due_at'],
    filters: ['name', 'priority', 'status', 'team_id', 'service_id'],
    tabs: [
      'active',
      'critical',
      'resolved_incidents',
      {
        label: 'All',
      },
    ],
  }),
  problems: listView('Problems', 'problem', {
    show: ['name', 'service_id.name', 'status', 'owner_id.name'],
  }),
  changes: listView('Changes', 'change_request', {
    show: ['reference', 'name', 'status', 'risk', 'service_id.name', 'starts_at'],
    filters: ['name', 'status', 'risk', 'team_id'],
    tabs: [
      'active',
      'under_review',
      {
        label: 'All',
      },
    ],
  }),
  'change-reviews': listView('Change reviews', 'change_approval', {
    show: ['name', 'change_id.name', 'reviewer_id.name', 'decision'],
    filters: ['decision'],
  }),
  'change-tasks': listView('Change tasks', 'change_task', {
    show: ['name', 'change_id.name', 'owner_id.name', 'status', 'due_at'],
    filters: ['status', 'owner_id'],
  }),
  requests: listView('Requests', 'service_request', {
    show: ['reference', 'name', 'requested_for.name', 'status', 'needed_on'],
    filters: ['name', 'status', 'requested_for'],
  }),
  'requested-items': listView('Requested items', 'request_item', {
    show: ['name', 'request_id.name', 'catalog_item_id.name', 'quantity', 'status'],
  }),
  'budget-reviews': listView('Budget reviews', 'request_approval', {
    show: ['name', 'request_id.name', 'reviewer_id.name', 'decision'],
    filters: ['decision'],
  }),
  orders: listView('Orders', 'purchase_order', {
    show: ['reference', 'name', 'vendor_id.name', 'status', 'expected_on'],
    filters: ['status', 'vendor_id'],
  }),
  'fulfillment-tasks': listView('Fulfillment tasks', 'fulfillment_task', {
    show: ['name', 'request_item_id.name', 'team_id.name', 'status', 'due_on'],
    filters: ['status', 'team_id'],
  }),
  'order-lines': listView('Order lines', 'order_line', {
    show: ['name', 'order_id.name', 'request_item_id.name', 'quantity', 'unit_price', 'received_quantity'],
  }),
  services: listView('Services', 'service', {
    show: ['name', 'criticality', 'status', 'owner_id.name', 'team_id.name'],
  }),
  assets: listView('Assets', 'asset', {
    path: 'equipment',
    show: ['asset_tag', 'name', 'kind', 'service_id.name', 'status', 'location_id.name'],
    filters: ['name', 'kind', 'status', 'service_id'],
  }),
  knowledge: listView('Knowledge', 'knowledge_article', {
    show: ['name', 'service_id.name', 'status', 'reviewed_on'],
    filters: ['name', 'service_id', 'status'],
  }),
  people: listView('People', 'person', {
    show: ['name', 'email', 'department_id.name', 'location_id.name'],
    open: 'drawer',
  }),
  teams: listView('Teams', 'support_team', {
    show: ['name', 'lead_id.name', 'coverage'],
  }),
  departments: listView('Departments', 'department', {
    show: ['name', 'cost_center'],
    open: 'drawer',
  }),
  locations: listView('Locations', 'location', {
    show: ['name', 'city', 'timezone'],
    open: 'drawer',
  }),
  vendors: listView('Vendors', 'vendor', {
    show: ['name', 'contact_email', 'support_tier'],
    open: 'drawer',
  }),
  'sla-policies': listView('SLA policies', 'sla_policy', {
    show: ['name', 'priority', 'response_minutes', 'resolution_minutes', 'calendar'],
    open: 'drawer',
  }),
} satisfies NonNullable<App['views']>;
