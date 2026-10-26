import { fields, header, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A resident: how to reach them, what they owe by lease, their leases and repairs. */
export default page(
  'resident',
  [
    header({ facts: ['email', 'phone', 'language'] }),
    fields(['balance', 'open_requests', 'since']),
    related('Leases', 'lease', 'resident_id', { show: ['unit_id', 'start_on', 'end_on', 'rent', 'status'], sort: 'start_on desc' }),
    related('Repairs', 'maintenance_request', 'resident_id', {
      show: ['title', 'status', 'reported_on'],
      sort: 'reported_on desc',
      limit: 8,
    }),
    related('Charges', 'charge', 'lease_id.resident_id', {
      group: { by: 'lease_id', show: ['start_on', 'status'], sort: 'start_on desc', limit: 3 },
      show: ['description', 'due_on', 'amount', 'status'],
      sort: 'due_on desc',
      limit: 4,
      empty: 'hide',
    }),
  ],
  { listTabs: false },
) satisfies Page;
