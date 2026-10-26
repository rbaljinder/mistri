import { fields, page, related } from '@mistriwork/mistri/app';

export const problemPage = page(
  'problem',
  [
    fields(['name', 'status', 'service_id', 'owner_id'], { columns: 3 }),
    fields(['root_cause', 'workaround'], {
      columns: 2,
    }),
    related('Affected incidents', 'incident', 'problem_id', {
      show: ['reference', 'name', 'status', 'priority'],
    }),
    related('Remediation changes', 'change_request', 'problem_id', {
      show: ['reference', 'name', 'status', 'risk'],
    }),
  ],
  { listTabs: true },
);
