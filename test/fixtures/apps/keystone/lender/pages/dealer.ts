import { card, chart, fields, header, history, note, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* A dealer as its relationship manager reads it: standing and tier in the
   head; what it has sent and what has funded in the figures, and the money
   month by month; the visits, its applications, its loans and its people as
   tabs; and beside them the terms of the relationship and, for an
   administrator only, the address its apply form is published under. */
export const dealerPages = {
  dealer: page(
    'dealer',
    [
      header({
        status: 'status',
        facts: ['tier', 'city', 'relationship_manager_id', { column: 'last_visit', before: 'Last visit' }],
        primary: 'logDealerVisit',
      }),
      // A dealer on hold says why, first: every other App leaves it out of its lists until it is lifted.
      fields(['on_hold_reason'], { title: 'On hold', columns: 1, when: 'status = on_hold' }),
      fields(['applications', 'approved', 'funded_volume']),
      chart('Funded by month', 'funding', 'month funded_on', {
        whose: 'dealer_id',
        query: 'status = funded and funded_on = last 12 months',
        measure: 'sum amount',
        shape: 'bar',
        height: 180,
      }),
      timeline(
        'Visits',
        [stream('dealer_visit', 'dealer_id', 'happened_on', 'summary', { detail: 'next_step', author: 'lender_user_id.name' })],
        { limit: 12, tab: 'Visits' },
      ),
      related('Applications', 'loan_application', 'dealer_id', {
        show: ['reference', 'applicant_id', 'requested_amount', 'status'],
        sort: 'submitted_at desc',
        limit: 15,
        tab: 'Applications',
      }),
      related('Loans', 'loan', 'dealer_id', {
        show: ['loan_number', 'customer_id', 'principal_balance', 'status'],
        sort: 'funded_on desc',
        limit: 15,
        tab: 'Loans',
      }),
      related('People', 'dealer_user', 'dealer_id', {
        show: ['name', 'role', 'email', 'status'],
        sort: 'name',
        tab: 'People',
      }),
      fields(['monthly_goal', 'funded_this_month', 'book', 'delinquent_loans', 'listings', 'reserve_pct'], {
        title: 'Relationship',
        region: 'aside',
      }),
      fields(['legal_name', 'kind', 'franchise_make', 'street', 'phone', 'email', 'joined_on'], { title: 'Dealership', region: 'aside' }),
      history(undefined, { limit: 6 }),
    ],
    { listTabs: true },
  ),

  visit: page('dealer_visit', [
    header({ facts: ['dealer_id', 'lender_user_id', { column: 'happened_on', before: 'On' }] }),
    fields(['summary', 'next_step'], { title: 'What was said', columns: 1 }),
    card('Dealer', 'dealer_id', ['status', 'relationship_manager_id']),
  ]),

  'triage-submission': page('intake_submission', [
    header({
      status: 'status',
      facts: ['dealer_hint', 'vehicle_interest', { column: 'created_at', before: 'Arrived' }],
      destructive: ['closeIntakeSubmission'],
    }),
    note(
      'An apply form no dealer could take: a missing or unknown address, or a dealer on hold. Find the applicant a dealer, then close it with what became of them.',
    ),
    fields(['first_name', 'last_name', 'email', 'phone', 'street', 'city', 'state', 'zip'], {
      title: 'Applicant',
      presentation: 'table',
      columns: 2,
    }),
    fields(['employer', 'monthly_income'], { title: 'Work and income', presentation: 'table', columns: 2 }),
    fields(['outcome_note', 'closed_at'], { title: 'Outcome', region: 'aside', when: 'status = closed' }),
    fields(['reference', 'created_at'], { title: 'Submission', region: 'aside' }),
  ]),
} satisfies Pages;
