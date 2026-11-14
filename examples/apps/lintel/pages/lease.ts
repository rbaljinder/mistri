import { card, fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A lease in the record anatomy: where it stands and the next step along the
   head, the money it owes and has paid, then its charges and payments as one
   strip of tabs, each saying how many it holds; the home and the resident
   beside them. A charge is added where the charges are read: the lease's own
   Add charge verb stands in that list's head, not among the head's. */
export default page(
  'lease',
  [
    header({
      status: 'status',
      facts: ['start_on', 'end_on', 'rent', 'deposit'],
      actions: ['signLease', 'giveNotice'],
      destructive: ['endLease'],
    }),
    // What each figure counts, under it: the three rollups as the lease resource defines them (resources.ts).
    fields(['balance', 'charged', 'paid'], {
      notes: { balance: 'Charges still open', charged: 'Since the lease began', paid: 'Payments received' },
    }),
    related('Charges', 'charge', 'lease_id', {
      show: ['description', 'due_on', 'amount', 'status'],
      sort: 'due_on desc',
      limit: 12,
      actions: ['addCharge'],
    }),
    related('Payments', 'payment', 'lease_id', {
      show: ['received_on', 'amount', 'method', 'reference'],
      sort: 'received_on desc',
      limit: 12,
    }),
    card('Home', 'unit_id', ['property_id', 'bedrooms', 'sqft']),
    card('Resident', 'resident_id', ['email', 'phone']),
    history(),
  ],
  { listTabs: true },
) satisfies Page;
