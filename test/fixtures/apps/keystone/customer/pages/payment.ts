import { card, fields, header, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One payment: its confirmation number, whether it has posted, and where the
   money went. A returned payment says why, and only then. */
export const paymentPage = page('payment', [
  header({
    status: 'status',
    facts: [{ column: 'received_on', before: 'Paid' }, 'method', 'channel'],
  }),
  fields(['amount', 'principal', 'interest', 'late_fee']),
  fields(['returned_reason'], { title: 'Why it was returned', when: 'status = returned' }),
  card('Loan', 'loan_id', ['loan_number', 'next_due_on']),
]) satisfies Page;
