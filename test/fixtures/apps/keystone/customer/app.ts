import { defineApp } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { pages } from './pages/index.ts';
import type { App } from './mistri-schema.d.ts';

import { resources } from './resources.ts';
import { views } from './views.ts';

/* Keystone's loan servicing, for the people who borrowed: what is due and
   when, what is left, what was paid, the papers, autopay and a payoff quote.
   Every row a borrower reads is their own, and that is the row policy's job
   (policy.ts, loaded with --policy), not a filter here: it finds the
   borrower's customer row from the verified account and scopes every table
   to it. A borrower changes only how to reach them; everything else happens
   through the four commands (commands.ts), each with a receipt. */
const borrowing = ['makePayment', 'requestPayoffQuote', 'enrollAutopay', 'cancelAutopay'] as const;

export default defineApp({
  id: 'customer',
  name: 'Keystone Customer Portal',
  sources: { keystone: { connection: 'keystone' } },
  resources,
  auth: {
    rows: 'policy',
    // Servicing adds a borrower at funding (Manage accounts); nobody signs themselves up to someone else's loan.
    providers: ['email'],
    defaultRole: 'borrower',
    me: { from: 'customer', column: 'email' },
    roles: {
      borrower: {
        label: 'Borrower',
        read: true,
        write: ['customer'],
        commands: borrowing,
        fields: {
          loan: {
            read: [
              'id',
              'loan_number',
              'customer_id',
              'dealer_id',
              'vehicle_description',
              'vin',
              'principal',
              'apr',
              'term_months',
              'payment_amount',
              'funded_on',
              'first_due_on',
              'maturity_on',
              'principal_balance',
              'interest_paid',
              'next_due_on',
              'amount_due',
              'days_past_due',
              'status',
              'paid_off_on',
              'charged_off_on',
              'version',
            ],
          },
        },
      },
      /* Keystone's servicing desk, here only to invite borrowers. The policy
         admits no borrower's rows to it: a servicer reads loans in the
         lender's App, never through a borrower's window. */
      admin: { label: 'Admin', read: true },
    },
  },
  views,
  pages,
  home: 'home',
  nav: ['home', 'loans', 'payments', 'schedule', 'documents', 'autopay'],
  ui: {
    appSwitcher,
    logo: 'key',
    theme: { preset: 'sage' },
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false, breadcrumbs: false },
    footer: {
      text: 'Keystone Auto Finance is a demonstration. No credit is offered and no money moves.',
      links: [
        { label: 'Call us: (800) 555-0142', href: 'tel:+18005550142' },
        { label: 'Privacy', href: 'https://example.invalid/privacy' },
      ],
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
    export: false,
  },
} satisfies App);
