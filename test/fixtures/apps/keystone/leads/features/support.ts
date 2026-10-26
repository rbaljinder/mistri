import {
  breakdown,
  card,
  count,
  defineFeature,
  fields,
  header,
  listView,
  navGroup,
  page,
  related,
  stream,
  timeline,
} from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { dealerStatus } from '../vocab.ts';

/* Keystone's dealer support, in the platform realm: every dealer's pipeline
   read across tenants, the apply forms no dealer's address placed, and the
   decisions Keystone owes late.

   It reads and does not work. A platform role changes rows only through
   platform commands, and the lender's desks live in the lender App, so
   nothing here offers a verb; when support needs to see a dealer's own
   screens it enters the dealer as that dealer's viewer, a short, audited
   support session (server/tenant-policy.ts). The views and pages are the
   platform's own, so they may say whose each row is (`dealer_id`), which a
   dealer's realm never shows. */
export const support = defineFeature({
  id: 'support',
  resources: {
    dealer: {
      segments: {
        trading: 'status = active',
        on_hold: 'status = on_hold',
        onboarding: 'status = prospect',
      },
      recordLabel: 'name',
      labels: { reserve_pct: 'Reserve', on_hold_reason: 'On hold because', joined_on: 'Joined' },
      display: { status: dealerStatus, reserve_pct: { format: 'percent' }, monthly_goal: { unit: 'deals' } },
      rollups: {
        new_leads: count('lead', { whose: 'dealer_id', query: 'status = new' }),
        on_desk: count('deal', { whose: 'dealer_id', query: 'status = structuring' }),
        waiting: count('loan_application', { whose: 'dealer_id', query: 'status = submitted or status = in_review' }),
      },
    },
    intake_submission: {
      segments: {
        open: 'status = open',
        followed_up: 'status = followed_up',
        closed: 'status = closed',
      },
      noun: 'submission',
      recordLabel: '{first_name} {last_name}',
      labels: { reference: 'Receipt', dealer_hint: 'Named a dealer', vehicle_interest: 'Looking for', created_at: 'Received' },
      display: {
        status: { tone: { open: 'warn', followed_up: 'info', closed: 'neutral', '*': 'neutral' } },
        monthly_income: { format: 'money' },
        created_at: { format: 'relative' },
      },
    },
    decision_alert: {
      recordLabel: 'application_id.reference',
      labels: {
        application_id: 'Application',
        dealer_id: 'Dealer',
        due_at: 'Answer was due',
        raised_at: 'Flagged',
        resolved_at: 'Resolved',
      },
      display: { due_at: { format: 'relative' }, raised_at: { format: 'relative' } },
    },
  },
  views: {
    dealers: listView('Dealers', 'dealer', {
      icon: 'storefront',
      realm: 'platform',
      show: ['name', 'city', 'tier', 'new_leads', 'on_desk', 'waiting', 'status'],
      filters: ['status', 'tier', 'kind', 'state'],
      sort: 'name',
      tabs: ['trading', 'on_hold', 'onboarding', { label: 'All' }],
    }),
    pipeline: listView('Every pipeline', 'lead', {
      icon: 'kanban',
      realm: 'platform',
      show: ['reference', 'dealer_id', 'first_name', 'last_name', 'created_at', 'status'],
      filters: ['dealer_id', 'status', 'source', 'created_at'],
      sort: 'created_at desc',
      /* A dealer's own lists leave its apply-form drafts out; the platform's
         do not, so the drafts are said out loud here. */
      query: 'status != draft',
      tabs: ['open', { label: 'All' }],
    }),
    triage: listView('Triage', 'intake_submission', {
      icon: 'tray',
      realm: 'platform',
      show: ['reference', 'first_name', 'last_name', 'dealer_hint', 'created_at', 'status'],
      filters: ['status', 'created_at'],
      sort: 'created_at desc',
      tabs: ['open', 'followed_up', 'closed', { label: 'All' }],
      empty: { title: 'Nothing to place', description: "Apply forms that no dealer's link placed land here. The lender App closes them." },
    }),
    'late-decisions': listView('Late decisions', 'decision_alert', {
      icon: 'hourglass',
      realm: 'platform',
      query: 'resolved_at is empty',
      sort: 'due_at',
      show: ['application_id', 'dealer_id', 'application_id.status', 'due_at', 'raised_at'],
      filters: ['dealer_id', 'due_at'],
      empty: {
        title: 'No decision is late',
        description: 'The decision clock flags an application Keystone has not answered within four business hours.',
      },
    }),
  },
  pages: {
    /* One dealer as support sees it: how it stands with Keystone in the head,
       its pipeline as figures and tabs. */
    dealer: page(
      'dealer',
      [
        header({ status: 'status', facts: ['city', 'state', 'tier', 'franchise_make'] }),
        fields(['new_leads', 'on_desk', 'waiting'], { columns: 3 }),
        breakdown('Leads by stage', 'lead', 'status', { whose: 'dealer_id', query: 'status != draft' }),
        related('Leads', 'lead', 'dealer_id', {
          show: ['reference', 'first_name', 'last_name', 'status'],
          query: 'status != draft',
          sort: 'created_at desc',
          limit: 25,
        }),
        related('Deals', 'deal', 'dealer_id', {
          show: ['reference', 'lead_id.last_name', 'amount_financed', 'status'],
          sort: 'updated_at desc',
          limit: 25,
        }),
        related('Applications', 'loan_application', 'dealer_id', {
          show: ['reference', 'requested_amount', 'status'],
          sort: 'submitted_at desc',
          limit: 25,
        }),
        related('Late decisions', 'decision_alert', 'dealer_id', { show: ['application_id', 'due_at', 'raised_at'], empty: 'hide' }),
        fields(['phone', 'email', 'kind', 'monthly_goal', 'reserve_pct', 'joined_on', 'on_hold_reason'], {
          title: 'Dealer',
          region: 'aside',
        }),
      ],
      { listTabs: true, realm: 'platform' },
    ),
    /* A dealer's lead, on Keystone's lease: the same row the dealer opens,
       read across the tenant boundary, with its timeline. No verb: the lead
       is the dealer's to work. */
    'support-lead': page(
      'lead',
      [
        header({ status: 'status', facts: ['dealer_id', 'reference', 'source', 'created_at'] }),
        timeline('Activity', [stream('lead_activity', 'lead_id', 'created_at', 'kind', { detail: 'body' })], { limit: 30 }),
        related('Deals', 'deal', 'lead_id', { show: ['reference', 'amount_financed', 'monthly_payment', 'status'], empty: 'hide' }),
        card('Vehicle', 'vehicle_id', ['list_price']),
        fields(['first_name', 'last_name', 'salesperson_id.name', 'next_follow_up_on', 'last_contact_at'], {
          title: 'Lead',
          region: 'aside',
        }),
      ],
      { realm: 'platform' },
    ),
    'triage-submission': page(
      'intake_submission',
      [
        header({ status: 'status', facts: ['reference', 'dealer_hint', 'created_at'] }),
        fields(['email', 'phone', 'street', 'city', 'state', 'zip'], { title: 'Applicant', presentation: 'table', columns: 2 }),
        fields(['employer', 'monthly_income', 'vehicle_interest'], { title: 'What they told us', presentation: 'table', columns: 2 }),
        fields(['outcome_note', 'closed_at'], { title: 'How it was closed', presentation: 'table', when: 'status = closed' }),
      ],
      { realm: 'platform' },
    ),
  },
  nav: [
    navGroup('keystone-support', 'Keystone', ['dealers', 'pipeline', 'triage', 'late-decisions'], { realm: 'platform', icon: 'headset' }),
  ],
} satisfies Feature);
