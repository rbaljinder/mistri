import type { App } from './mistri-schema.d.ts';

/* The top menu: arrangement only. Every entry names a view in views.ts. */
export const navigation = [
  {
    id: 'operate',
    label: 'Operate',
    children: ['operations', 'incident-triage', 'incidents', 'problems'],
  },
  {
    id: 'change',
    label: 'Change',
    children: ['change-queue', 'changes', 'change-reviews', 'change-tasks'],
  },
  {
    id: 'request',
    label: 'Request',
    children: ['service-catalog', 'requests', 'requested-items', 'budget-reviews'],
  },
  {
    id: 'fulfill',
    label: 'Fulfill',
    children: ['fulfillment-queue', 'orders', 'fulfillment-tasks', 'order-lines'],
  },
  {
    id: 'estate',
    label: 'Estate',
    children: ['services', 'assets', 'knowledge'],
  },
  {
    id: 'directory',
    label: 'Directory',
    children: [
      'people',
      {
        id: 'organization',
        label: 'Organization',
        children: ['teams', 'departments', 'locations'],
      },
      'vendors',
      'sla-policies',
    ],
  },
] satisfies NonNullable<App['nav']>;
