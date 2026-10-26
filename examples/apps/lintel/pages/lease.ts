import { card, fields, header, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A lease in the record anatomy: where it stands and the next step along the
   head, the money it owes and has paid, then its charges and payments; the
   home and the resident beside them. */
export default page(
  'lease',
  [
    header({
      status: 'status',
      facts: ['start_on', 'end_on', 'rent', 'deposit'],
      actions: ['signLease', 'giveNotice', 'addCharge'],
      destructive: ['endLease'],
    }),
    fields(['balance', 'charged', 'paid']),
    related('Charges', 'charge', 'lease_id', {
      show: ['description', 'due_on', 'amount', 'status'],
      sort: 'due_on desc',
      limit: 12,
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
  { listTabs: false },
) satisfies Page;
