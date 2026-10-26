import { card, current, fields, header, history, page, related, stream, timeline } from '@mistriwork/mistri/app';
import type { Pages } from '../mistri-schema.d.ts';

/* The road an application travels at the lender. Conditioned is a stop on
   it (conditions asked before the answer); countered, declined and withdrawn
   are ways off it, said by their tones. */

/* An application as the underwriter works it: whose it is and when the
   answer is owed in the head; the figures the decision turns on; the deal the
   dealer structured, the conditions asked of it and the file's notes as
   tabs; and beside them the lender's file (who holds it, the bureau's
   answer), the ratios, what was decided and who changed what. The filled
   verb is the one its state waits on: Assign, then Decide, then nothing. */
export const applicationPages = {
  application: page(
    'loan_application',
    [
      header({
        status: 'status',
        facts: ['dealer_id', 'program_id', { column: 'decision_due', before: 'Decision due' }],
        primary: 'decideApplication',
      }),
      fields(['requested_amount', 'down_payment', 'open_stips']),
      fields(
        [
          'deal_id.sale_price',
          'deal_id.cash_down',
          'deal_id.trade_allowance',
          'deal_id.sales_tax',
          'deal_id.service_contract',
          'deal_id.gap',
          'deal_id.amount_financed',
          'deal_id.term_months',
          'deal_id.apr',
          'deal_id.monthly_payment',
        ],
        {
          title: 'The deal',
          presentation: 'table',
          columns: 2,
          tab: 'The deal',
        },
      ),
      fields(['dealer_note'], { title: 'From the dealer', columns: 1, tab: 'The deal', when: 'dealer_note is not empty' }),
      related('Conditions', 'stipulation', 'application_id', {
        show: ['kind', 'requested_at', 'status'],
        sort: 'requested_at',
        tab: 'Conditions',
        empty: { title: 'No conditions asked', description: 'Request condition asks the dealer for a document before the loan funds.' },
      }),
      timeline(
        'Notes',
        [
          stream('underwriting_note', 'application_id', 'created_at', 'body', { author: 'author_id.name' }),
          stream('decision_alert', 'application_id', 'raised_at', 'due_at', { query: 'resolved_at is empty' }),
        ],
        { limit: 20, tab: 'Notes' },
      ),
      card('Applicant', 'applicant_id', ['employer', 'monthly_income']),
      fields(['co_applicant_id'], { title: 'Co-applicant', region: 'aside', when: 'co_applicant_id is not empty' }),
      current('Underwriting file', 'underwriting_file', 'application_id', {
        // The bureau's answer is on the file itself, for the roles that may read it.
        show: ['underwriter_id', 'assigned_at', 'decision_due_at'],
        empty: { title: 'Not assigned yet', description: 'Assign an underwriter to pull the bureau and open the file.' },
      }),
      fields(['ltv_pct', 'dti_pct', 'pti_pct', 'requested_term', 'vehicle_value', 'vehicle_id', 'submitted_at'], {
        title: 'Underwriting',
        region: 'aside',
      }),
      fields(['approved_amount', 'approved_apr', 'approved_term', 'approved_payment', 'decided_at'], {
        title: 'Approved terms',
        region: 'aside',
        when: 'status in (approved, countered, funded)',
      }),
      fields(['decline_reason', 'decided_at'], { title: 'Declined', region: 'aside', when: 'status = declined' }),
      fields(['withdrawn_reason'], { title: 'Withdrawn', region: 'aside', when: 'status = withdrawn' }),
      history(),
    ],
    { listTabs: true },
  ),

  /* The lender's own file on one application: the bureau's answer in full.
     Only underwriters and credit managers read its bureau columns. */
  'underwriting-file': page('underwriting_file', [
    header({ facts: ['underwriter_id', 'bureau', { column: 'decision_due_at', before: 'Decision due' }] }),
    fields(['score', 'revolving_utilization_pct', 'monthly_debt']),
    fields(['open_tradelines', 'auto_tradelines', 'delinquencies_24m', 'public_records', 'inquiries_6m', 'pulled_at'], {
      title: 'Credit report',
      presentation: 'table',
      columns: 2,
    }),
    card('Application', 'application_id', ['status', 'requested_amount']),
    fields(['assigned_at', 'decided_by', 'dealer_id'], { title: 'File', region: 'aside' }),
  ]),

  condition: page('stipulation', [
    header({ status: 'status', facts: ['dealer_id', { column: 'requested_at', before: 'Asked' }] }),
    fields(['note'], { title: 'Note', columns: 1, when: 'note is not empty' }),
    related(
      'Other conditions on this application',
      'stipulation',
      { same: ['application_id'] },
      {
        show: ['kind', 'requested_at', 'status'],
        empty: 'hide',
      },
    ),
    card('Application', 'application_id', ['status', 'requested_amount']),
    fields(['kind', 'requested_at', 'received_at', 'cleared_at'], { title: 'Condition', region: 'aside' }),
    history(undefined, { limit: 6 }),
  ]),
} satisfies Pages;
