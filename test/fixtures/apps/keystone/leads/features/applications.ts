import {
  action,
  appLink,
  card,
  count,
  defineFeature,
  fields,
  header,
  history,
  listView,
  note,
  page,
  related,
} from '@mistriwork/mistri/app';
import type { lender } from '../../suite-contract.d.ts';
import type { Feature } from '../mistri-schema.d.ts';
import { applicationStatus, dollars, months, perMonth, rate, stipulationStatus } from '../vocab.ts';

/* Withdrawal races with Keystone's decision on the same `version`: whichever
   commits first makes the other stale rather than overwriting it. */

/** Where an application stands with Keystone, in order. Countered, declined
    and withdrawn are ways off the road, said by their tones. */

export const withdrawAction = action('Withdraw application', { command: 'withdrawApplication' });
export const applications = defineFeature({
  id: 'applications',
  resources: {
    loan_application: {
      segments: {
        with_keystone: { query: 'status = submitted or status = in_review', label: 'With Keystone' },
        conditioned: 'status = conditioned',
        approved: 'status = approved or status = countered',
        declined: 'status = declined',
        funded: 'status = funded',
      },
      noun: 'application',
      recordLabel: '{reference} · {applicant_id.first_name} {applicant_id.last_name}',
      labels: {
        reference: 'Application',
        applicant_id: 'Applicant',
        co_applicant_id: 'Co-applicant',
        deal_id: 'Deal',
        vehicle_id: 'Vehicle',
        program_id: 'Program',
        requested_amount: 'Requested',
        requested_term: 'Term asked',
        down_payment: 'Down',
        ltv_pct: 'LTV',
        dti_pct: 'DTI',
        pti_pct: 'PTI',
        submitted_at: 'Submitted',
        decided_at: 'Decided',
        approved_apr: 'Approved APR',
        'applicant_id.first_name': 'First name',
        'applicant_id.last_name': 'Last name',
        'vehicle_id.model': 'Vehicle',
        'applicant_id.phone': 'Phone',
        'applicant_id.email': 'Email',
        'co_applicant_id.last_name': 'Co-applicant',
        decline_reason: 'Declined for',
        withdrawn_reason: 'Withdrawn because',
        dealer_note: 'Note to Keystone',
      },
      display: {
        status: applicationStatus,
        requested_amount: dollars,
        down_payment: dollars,
        vehicle_value: dollars,
        approved_amount: dollars,
        approved_payment: perMonth,
        approved_apr: rate,
        ltv_pct: rate,
        dti_pct: rate,
        pti_pct: rate,
        requested_term: months,
        approved_term: months,
        submitted_at: { format: 'relative' },
        decided_at: { format: 'relative' },
      },
      rollups: {
        stipulations_open: count('stipulation', { whose: 'application_id', query: 'status = requested' }),
      },
      actions: {
        withdrawApplication: withdrawAction,
      },
    },
    stipulation: {
      recordLabel: '{kind} for {application_id.reference}',
      labels: { application_id: 'Application', requested_at: 'Asked', received_at: 'Received', cleared_at: 'Cleared' },
      display: {
        status: stipulationStatus,
        requested_at: { format: 'relative' },
        received_at: { format: 'relative' },
        cleared_at: { format: 'relative' },
      },
      actions: {
        markStipulationReceived: action('Mark received', { command: 'markStipulationReceived' }),
      },
    },
  },
  views: {
    applications: listView('Applications', 'loan_application', {
      icon: 'file-text',
      show: [
        'reference',
        'applicant_id.first_name',
        'applicant_id.last_name',
        'vehicle_id.model',
        'requested_amount',
        'submitted_at',
        'status',
      ],
      filters: ['program_id', 'decline_reason', 'submitted_at'],
      sort: 'submitted_at desc',
      tabs: [
        { segment: 'with_keystone', sort: 'submitted_at' },
        { segment: 'conditioned', sort: 'submitted_at' },
        { segment: 'approved', sort: 'decided_at desc' },
        { segment: 'declined', sort: 'decided_at desc' },
        { segment: 'funded', sort: 'decided_at desc' },
        { label: 'All' },
      ],
    }),
    stipulations: listView('Stipulations due', 'stipulation', {
      icon: 'list-checks',
      query: 'status = requested',
      sort: 'requested_at',
      show: ['kind', 'application_id.reference', 'requested_at', 'status'],
      filters: ['kind', 'requested_at'],
      rowActions: true,
      empty: { title: 'Nothing to collect', description: 'When Keystone approves with conditions, what it asks for lands here.' },
    }),
  },
  pages: {
    /* The application as Keystone answered it: its road, the terms asked and
       the terms approved, the conditions to collect, and beside them the deal
       and the car. The lender's own file is not here: a dealer's realm has
       no such table. Withdrawing is the dealer's last word, never its next
       step, so no verb here is filled. */
    application: page('loan_application', [
      header({
        status: 'status',
        facts: ['program_id', { column: 'submitted_at', before: 'Submitted' }, { column: 'decided_at', before: 'Decided' }],
        destructive: ['withdrawApplication'],
      }),
      note('Continue in the lender workspace if your account has access.', {
        action: {
          label: 'Open in Lender',
          to: appLink<typeof lender>({ app: 'lender', kind: 'record', resource: 'loan_application', key: { id: { column: 'id' } } }),
        },
      }),
      fields(['requested_amount', 'requested_term', 'ltv_pct']),
      fields(['approved_amount', 'approved_apr', 'approved_term', 'approved_payment'], {
        title: 'Approved terms',
        presentation: 'table',
        columns: 2,
        when: 'status = approved or status = countered or status = funded',
      }),
      fields(['decline_reason'], { title: "Keystone's answer", presentation: 'table', when: 'status = declined' }),
      fields(['withdrawn_reason'], { title: 'Withdrawn', presentation: 'table', when: 'status = withdrawn' }),
      related('Stipulations', 'stipulation', 'application_id', {
        show: ['kind', 'requested_at', 'status'],
        empty: { title: 'No conditions', description: 'Keystone has asked for nothing on this application.' },
      }),
      fields(['down_payment', 'vehicle_value', 'pti_pct', 'dti_pct', 'dealer_note'], {
        title: 'What was submitted',
        presentation: 'table',
        columns: 2,
      }),
      card('Deal', 'deal_id', ['monthly_payment', 'amount_financed']),
      fields(['vehicle_id.model', 'vehicle_id.trim', 'vehicle_id.stock_number', 'vehicle_id.list_price'], {
        title: 'Vehicle',
        region: 'aside',
      }),
      fields(['applicant_id.phone', 'applicant_id.email', 'co_applicant_id.last_name'], { title: 'Applicant', region: 'aside' }),
      history(),
    ]),
  },
} satisfies Feature);
