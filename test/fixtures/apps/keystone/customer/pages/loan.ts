import { card, current, fields, header, note, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One loan, as its borrower reads it. The head says the car, where the loan
   stands and when the next payment is due, with one filled verb: Make a
   payment. A late loan says so once, gently, with what fixes it. Then the
   figures a borrower checks, and the loan's parts as tabs: what is coming,
   what was paid, the papers and any payoff quote. Beside them, autopay, who
   sold the car, and the loan's terms. */
export const loanPage = page(
  'loan',
  [
    header({
      status: 'status',
      facts: [{ column: 'next_due_on', before: 'Next payment due' }, 'payment_amount', 'loan_number'],
      primary: 'makePayment',
    }),
    note(
      'Your loan is past due. Paying the amount due brings it current; if you need more time, call Keystone at (800) 555-0142 and we will work it out with you.',
      { title: 'A payment is late', when: 'days_past_due > 0' },
    ),
    fields(['amount_due', 'principal_balance', 'paid_to_date', 'payments_left']),
    related('Schedule', 'installment', 'loan_id', {
      show: ['number', 'due_on', 'amount', 'status'],
      query: 'status = upcoming or status = due or status = past_due',
      sort: 'due_on',
      limit: 6,
      empty: { title: 'Nothing left to pay', description: 'Every scheduled payment has been made.' },
    }),
    related('Payments', 'payment', 'loan_id', {
      show: ['reference', 'received_on', 'amount', 'status'],
      sort: 'received_on desc',
      limit: 24,
      empty: { title: 'No payments yet', description: 'Your first payment will be listed here.' },
    }),
    related('Documents', 'loan_document', 'loan_id', {
      show: ['title', 'issued_on'],
      sort: 'issued_on desc',
      empty: { title: 'No documents yet', description: 'Your contract and statements appear here.' },
    }),
    related('Payoff quotes', 'payoff_quote', 'loan_id', {
      show: ['amount', 'good_through', 'status'],
      sort: 'requested_on desc',
      empty: 'hide',
    }),
    current('Autopay', 'autopay', 'loan_id', {
      query: 'status = active or status = paused',
      sort: 'enrolled_on desc',
      show: ['status', 'draft_day', 'account_type'],
      empty: { title: 'Autopay is off', description: 'Set it up and each payment is drafted from your bank on the day you choose.' },
    }),
    card('Bought from', 'dealer_id', ['city', 'phone']),
    fields(['principal', 'apr', 'term_months', 'funded_on', 'maturity_on', 'interest_paid', 'vin'], {
      title: 'Your loan',
      region: 'aside',
    }),
  ],
  { listTabs: true },
) satisfies Page;
