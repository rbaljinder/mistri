import { card, current, fields, header, history, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* A loan as servicing reads it: whose it is and when the next payment falls
   due in the head; what is owed and how far behind in the figures; the
   schedule, the payments, the documents and servicing's own notes as tabs;
   and beside them the borrower to call, their autopay and the terms. */
export const loanPages = {
  loan: page(
    'loan',
    [
      header({
        status: 'status',
        facts: ['dealer_id', 'vehicle_description', { column: 'next_due_on', before: 'Next due' }],
        primary: 'recordServicingNote',
      }),
      fields(['principal_balance', 'amount_due', 'days_past_due']),
      timeline(
        'Servicing notes',
        [stream('servicing_note', 'loan_id', 'created_at', 'kind', { detail: 'body', author: 'author_id.name' })],
        { limit: 20, tab: 'Notes' },
      ),
      related('Schedule', 'installment', 'loan_id', {
        show: ['number', 'due_on', 'amount', 'status'],
        sort: 'number',
        limit: 96,
        tab: 'Schedule',
      }),
      related('Payments', 'payment', 'loan_id', {
        show: ['received_on', 'amount', 'method', 'status'],
        sort: 'received_on desc',
        limit: 36,
        tab: 'Payments',
        empty: { title: 'No payments yet', description: 'The first installment is not due yet.' },
      }),
      related('Documents', 'loan_document', 'loan_id', {
        show: ['title', 'issued_on'],
        sort: 'issued_on desc',
        tab: 'Documents',
      }),
      related('Payoff quotes', 'payoff_quote', 'loan_id', {
        show: ['requested_on', 'good_through', 'amount', 'status'],
        sort: 'requested_on desc',
        tab: 'Payoff quotes',
        empty: {
          title: 'No payoff quotes',
          description: 'A quote the borrower or the dealer asks for is kept here with its good-through date.',
        },
      }),
      card('Borrower', 'customer_id', ['phone', 'preferred_contact']),
      current('Autopay', 'autopay', 'loan_id', {
        query: 'status != cancelled',
        sort: 'enrolled_on desc',
        show: ['draft_day', 'account_type', 'status'],
        empty: { title: 'Not on autopay', description: 'The borrower pays by hand each month.' },
      }),
      fields(
        [
          'principal',
          'apr',
          'term_months',
          'payment_amount',
          'funded_on',
          'maturity_on',
          'interest_paid',
          'last_paid_on',
          'dealer_id',
          'application_id',
        ],
        { title: 'Loan', region: 'aside' },
      ),
      history(),
    ],
    { listTabs: true },
  ),

  payment: page('payment', [
    header({ status: 'status', facts: ['loan_id', 'method', { column: 'received_on', before: 'Received' }] }),
    fields(['amount', 'principal', 'interest']),
    fields(['returned_reason'], { title: 'Returned', columns: 1, when: 'status = returned' }),
    card('Loan', 'loan_id', ['customer_id', 'status']),
    fields(['channel', 'late_fee', 'reference'], { title: 'Payment', region: 'aside' }),
  ]),

  customer: page('customer', [
    header({ facts: ['city', 'state', { column: 'customer_since', before: 'Customer since' }] }),
    fields(['loans', 'balance']),
    related('Loans', 'loan', 'customer_id', {
      show: ['loan_number', 'principal_balance', 'status'],
      sort: 'funded_on desc',
    }),
    fields(['email', 'phone', 'preferred_contact', 'paperless', 'street', 'zip'], { title: 'Contact', region: 'aside' }),
  ]),
} satisfies Pages;
