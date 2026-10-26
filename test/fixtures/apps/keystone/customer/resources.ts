import { action, count, sum } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What the servicing App says about each table, once. Every row here is the
   signed-in borrower's own: policy.ts scopes customer, loan and everything
   under a loan by customer_id, and the dealer by the loans' dealers. The
   words are a borrower's, not a servicer's: "Amount due", "Paid on",
   "Bought from". The vocabularies and tones are SUITE.md's, copied. */

const usd = { format: 'money' } as const;

export const turnOffAutopayAction = action('Turn off autopay', { command: 'cancelAutopay' });
export const makePaymentAction = action('Make a payment', { command: 'makePayment' });
export const resources = {
  customer: {
    // The one row a borrower may change: how to reach them. The rest is the lender's record.
    access: 'write',
    settings: 'Your profile',
    noun: { one: 'profile', many: 'profiles' },
    recordLabel: '{first_name} {last_name}',
    // The applicant and account links are the lender's bookkeeping: outside the ceiling, never served.
    fields: {
      read: [
        'id',
        'first_name',
        'last_name',
        'email',
        'phone',
        'street',
        'city',
        'state',
        'zip',
        'paperless',
        'preferred_contact',
        'customer_since',
        'version',
      ],
      write: ['phone', 'street', 'city', 'state', 'zip', 'paperless', 'preferred_contact'],
    },
    display: { preferred_contact: { values: { phone: 'Phone call', text: 'Text message' } } },
    labels: {
      zip: 'ZIP code',
      paperless: 'Paperless statements',
      preferred_contact: 'Best way to reach you',
    },
  },

  loan: {
    // 'write' is the commands' ceiling (a command's target is in its footprint); no role saves a loan.
    access: 'write',
    recordLabel: 'vehicle_description',
    noun: 'loan',
    /* The application behind the loan is the dealer's and the lender's, not
       the borrower's to walk: the borrower role's field rule (app.ts) leaves
       it out. A ceiling here would be the tidier place, but a command's
       target may carry no resource-level field rule yet. */
    rollups: {
      paid_to_date: sum('payment', 'amount', { whose: 'loan_id', query: 'status = posted' }),
      payments_left: count('installment', { whose: 'loan_id', query: 'status = upcoming or status = due or status = past_due' }),
      payments_made: count('installment', { whose: 'loan_id', query: 'status = paid' }),
    },
    display: {
      principal: usd,
      principal_balance: usd,
      interest_paid: usd,
      amount_due: usd,
      paid_to_date: usd,
      payment_amount: { format: 'money', unit: '/mo' },
      apr: { format: 'percent' },
      term_months: { unit: 'months' },
      days_past_due: { unit: 'days late' },
      status: { tone: { past_due: 'warn', delinquent: 'bad', charged_off: 'bad', paid_off: 'neutral', '*': 'neutral' } },
    },
    labels: {
      vehicle_description: 'Vehicle',
      vin: 'VIN',
      principal: 'Amount financed',
      apr: 'APR',
      term_months: 'Term',
      payment_amount: 'Monthly payment',
      funded_on: 'Loan date',
      first_due_on: 'First payment',
      maturity_on: 'Final payment',
      principal_balance: 'Balance',
      next_due_on: 'Next payment due',
      days_past_due: 'Past due',
      paid_off_on: 'Paid off',
      charged_off_on: 'Charged off',
      paid_to_date: 'Paid so far',
      customer_id: 'Borrower',
    },
    actions: {
      makePayment: makePaymentAction,
      enrollAutopay: action('Set up autopay', { command: 'enrollAutopay' }),
      requestPayoffQuote: action('Get a payoff quote', { command: 'requestPayoffQuote' }),
    },
  },

  installment: {
    segments: {
      coming_up: 'status = upcoming or status = due or status = past_due',
      paid: 'status = paid',
    },
    recordLabel: 'Payment {number} · {loan_id.loan_number}',
    noun: 'scheduled payment',
    display: {
      amount: usd,
      principal: usd,
      interest: usd,
      status: { tone: { due: 'info', past_due: 'bad', paid: 'good', '*': 'neutral' } },
    },
    labels: {
      number: 'Payment',
      due_on: 'Due',
      principal: 'To principal',
    },
  },

  payment: {
    segments: {
      pending: 'status = pending',
      returned: 'status = returned',
    },
    access: 'write',
    noun: 'payment',
    display: {
      amount: usd,
      principal: usd,
      interest: usd,
      late_fee: usd,
      method: { values: { ach: 'Bank account', card: 'Debit card' } },
      channel: { values: { customer_portal: 'Online', phone: 'By phone', mail: 'By mail' } },
      status: { tone: { pending: 'info', returned: 'bad', '*': 'neutral' } },
    },
    labels: {
      reference: 'Confirmation',
      received_on: 'Date',
      principal: 'To principal',
      method: 'Paid from',
      channel: 'How',
      returned_reason: 'Why it was returned',
    },
  },

  autopay: {
    access: 'write',
    recordLabel: '{bank_name} ····{account_last4}',
    noun: 'autopay',
    display: {
      draft_day: { unit: 'of the month' },
      status: { tone: { active: 'good', paused: 'warn', '*': 'neutral' } },
    },
    labels: {
      bank_name: 'Bank',
      account_type: 'Account',
      account_last4: 'Account ending',
      draft_day: 'Drafts on day',
      enrolled_on: 'Since',
      cancelled_on: 'Turned off',
    },
    actions: {
      cancelAutopay: turnOffAutopayAction,
    },
  },

  payoff_quote: {
    access: 'write',
    recordLabel: '{loan_id.loan_number} payoff, good through {good_through}',
    noun: 'payoff quote',
    display: {
      amount: usd,
      per_diem: { format: 'money', unit: '/day' },
      requested_via: { values: { customer_portal: 'Online', phone: 'By phone', dealer: 'Through the dealer' } },
      status: { tone: { issued: 'info', paid: 'good', '*': 'neutral' } },
      good_through: { format: 'relative' },
    },
    labels: {
      requested_on: 'Requested',
      amount: 'Payoff amount',
      per_diem: 'Interest per day',
      requested_via: 'Asked',
    },
  },

  loan_document: {
    noun: 'document',
    // Download only: uploads are off under a row policy, and a borrower sends nothing here.
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
    display: {
      kind: {
        values: {
          truth_in_lending: 'Truth in Lending disclosure',
          welcome_letter: 'Welcome letter',
          payoff_letter: 'Payoff letter',
          title_release: 'Title release',
        },
      },
    },
    labels: {
      title: 'Document',
      issued_on: 'Issued',
      file_name: 'File',
      byte_size: 'Size',
    },
  },

  // Named on a loan, so a borrower knows who sold the car and how to reach them.
  dealer: {
    fields: { read: ['id', 'name', 'street', 'city', 'state', 'zip', 'phone', 'email'] },
    labels: { name: 'Dealer', zip: 'ZIP code' },
  },
} satisfies Resources;
