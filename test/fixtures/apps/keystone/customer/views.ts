import { cards, dashboard, embed, listView, metric, rows } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* The borrower's rooms. Home greets them and says the three things anyone
   opens a loan servicing site to learn: what is due, when, and what is
   left. Each loan is a card that opens it; a borrower with two cars has two
   cards and chooses there. The lists behind the menu are the loan's parts,
   across every loan the borrower holds, newest first. */

const loanCard = cards('vehicle_description', {
  value: 'amount_due',
  badge: 'status',
  facts: [
    { column: 'next_due_on', before: 'Due' },
    { column: 'principal_balance', after: { one: 'left to pay', many: 'left to pay' } },
  ],
  properties: ['loan_number', 'dealer_id.name'],
});

export const views = {
  home: dashboard(
    'Home',
    [
      embed('loans', { title: 'Your loans' }),
      metric('Balance', 'loan', { measure: 'sum principal_balance', query: 'status != paid_off and status != charged_off', width: 'half' }),
      metric('Paid so far', 'payment', { measure: 'sum amount', query: 'status = posted', width: 'half' }),
      rows('Coming up', 'installment', {
        query: 'status = due or status = past_due or status = upcoming',
        show: ['due_on', 'amount', 'status'],
        sort: 'due_on',
        limit: 3,
        width: 'half',
      }),
      rows('Recent payments', 'payment', { show: ['received_on', 'amount', 'status'], sort: 'received_on desc', limit: 3, width: 'half' }),
    ],
    {
      heading: 'Hello, {me.name}',
      description: 'Your Keystone auto loans, in one place.',
      icon: 'house',
    },
  ),

  loans: listView('Your loans', 'loan', {
    icon: 'car',
    show: ['vehicle_description', 'amount_due', 'next_due_on', 'principal_balance', 'status', 'loan_number', 'dealer_id.name'],
    presentation: loanCard,
    sort: 'next_due_on',
    filters: [],
    empty: { title: 'No loans yet', description: 'Once Keystone funds your loan, it appears here.' },
  }),

  payments: listView('Payments', 'payment', {
    icon: 'wallet',
    show: ['reference', 'received_on', 'amount', 'method', 'status'],
    sort: 'received_on desc',
    tabs: [{ label: 'All' }, 'pending', 'returned'],
    filters: ['loan_id', 'received_on'],
    empty: { title: 'No payments yet', description: 'Payments you make, and autopay drafts, are listed here.' },
  }),

  schedule: listView('Schedule', 'installment', {
    icon: 'calendar',
    show: ['number', 'due_on', 'amount', 'principal', 'status'],
    sort: 'due_on',
    tabs: ['coming_up', 'paid', { label: 'All' }],
    filters: ['loan_id'],
    empty: { title: 'Nothing scheduled', description: 'Every payment on your loan has been made.' },
  }),

  documents: listView('Documents', 'loan_document', {
    icon: 'file-text',
    show: ['title', 'kind', 'issued_on', 'loan_id'],
    sort: 'issued_on desc',
    filters: ['kind', 'loan_id'],
    empty: { title: 'No documents yet', description: 'Your contract, disclosures and statements appear here.' },
  }),

  autopay: listView('Autopay', 'autopay', {
    icon: 'bank',
    show: ['bank_name', 'account_last4', 'draft_day', 'loan_id', 'status'],
    sort: 'enrolled_on desc',
    filters: [],
    empty: {
      title: 'Autopay is off',
      description: 'Set it up from a loan, and each payment is drafted from your bank on the day you choose.',
      action: { label: 'Your loans', to: 'loans' },
    },
  }),

  'payoff-quotes': listView('Payoff quotes', 'payoff_quote', {
    icon: 'currency-dollar',
    show: ['loan_id', 'amount', 'good_through', 'requested_on', 'status'],
    sort: 'requested_on desc',
    filters: [],
    empty: { title: 'No payoff quotes', description: 'Ask for one from a loan: it says what pays the loan off, and until when.' },
  }),
} satisfies App['views'];
