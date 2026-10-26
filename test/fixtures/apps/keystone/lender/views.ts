import { listView, queue } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';

/* Every list a lender's desk opens. navigation.ts arranges them by the work
   (underwriting, funding, the portfolio, the dealers, the settings); column
   captions are the resources' (resources.ts), so a view names columns and
   paths only. Queues come first in each group: they are where the day is
   spent. */

const OPEN = 'status in (submitted, in_review, conditioned)';

export const views = {
  /* ---------- underwriting ---------- */

  // The underwriters' inbox: what the lender owes a dealer an answer on, the soonest due first.
  queue: listView('Queue', 'loan_application', {
    icon: 'tray',
    query: OPEN,
    presentation: queue('reference', {
      lines: ['applicant_id', 'dealer_id.name'],
      properties: ['requested_amount', 'ltv_pct', 'decision_due'],
      badge: 'status',
      openLabel: 'Open application',
    }),
    tabs: [
      { segment: 'unassigned', sort: 'submitted_at' },
      { segment: 'in_review', sort: 'decision_due' },
      { segment: 'conditioned', sort: 'decision_due' },
      { label: 'All open', sort: 'decision_due' },
    ],
    filters: ['dealer_id', 'program_id'],
    actions: ['assignUnderwriter'],
    empty: { title: 'Nothing waiting on underwriting', description: 'Applications the dealers submit arrive here until they are decided.' },
  }),
  /* An underwriter's own open files. `me` cannot reach the queue's rows (the underwriter is on the lender's file, not the
     dealer's application, and a rollup's condition cannot say `me`), so this list is over the files themselves. */
  'my-files': listView('My files', 'underwriting_file', {
    icon: 'folder',
    query: 'underwriter_id = me and decided_by is empty',
    // A grid, not a queue: a queue's primary is drawn as the stored value, and this one is the application's key.
    show: ['application_id', 'dealer_id', 'assigned_at', 'decision_due_at'],
    sort: 'decision_due_at',
    empty: { title: 'No files of yours are open', description: 'Applications assigned to you wait here until you decide them.' },
  }),
  applications: listView('Applications', 'loan_application', {
    icon: 'file-text',
    show: ['reference', 'applicant_id', 'dealer_id.name', 'requested_amount', 'ltv_pct', 'submitted_at', 'status'],
    tabs: [
      { segment: 'open', sort: 'submitted_at' },
      { segment: 'approved', sort: 'decided_at desc' },
      { segment: 'funded', sort: 'decided_at desc' },
      { segment: 'declined', sort: 'decided_at desc' },
      { segment: 'withdrawn', sort: 'submitted_at desc' },
      { label: 'All', sort: 'submitted_at desc' },
    ],
    filters: ['status', 'dealer_id', 'program_id', 'submitted_at', 'requested_amount'],
    density: 'compact',
  }),
  stipulations: listView('Conditions', 'stipulation', {
    icon: 'list-checks',
    show: ['application_id', 'kind', 'dealer_id.name', 'requested_at', 'status'],
    tabs: [
      { segment: 'to_clear', sort: 'received_at' },
      { segment: 'with_the_dealer', sort: 'requested_at' },
      { segment: 'cleared', sort: 'cleared_at desc' },
      { label: 'All', sort: 'requested_at desc' },
    ],
    filters: ['kind', 'dealer_id', 'status'],
    rowActions: true,
    density: 'compact',
    empty: {
      title: 'No conditions here',
      description: 'Conditions an underwriter asks of a dealer are listed here until they are cleared.',
    },
  }),
  // The decision clock's alerts, read on the applications they are about: open one and decide it.
  'late-decisions': listView('Late decisions', 'loan_application', {
    icon: 'hourglass',
    query: 'open_alerts > 0',
    show: ['reference', 'applicant_id', 'dealer_id.name', 'decision_due', 'status'],
    sort: 'decision_due',
    filters: ['dealer_id'],
    empty: { title: 'Every answer is on time', description: 'An application the lender has not answered by its deadline is listed here.' },
  }),

  /* ---------- funding ---------- */

  'funding-queue': listView('Funding queue', 'funding', {
    icon: 'bank',
    query: 'status != funded',
    show: ['application_id', 'dealer_id.name', 'amount', 'contract_received_on', 'status'],
    tabs: [
      // A contract the dealer has signed and marked contracted, not yet in the lender's hands.
      'to_receive',
      { segment: 'in_audit', sort: 'contract_received_on' },
      { segment: 'ready_to_fund', sort: 'contract_received_on' },
      'rejected',
      'with_the_dealer',
      { label: 'All' },
    ],
    filters: ['dealer_id'],
    totals: ['amount'],
    rowActions: true,
    empty: {
      title: 'Nothing to fund here',
      description: 'An approved application waits here from its approval until its money reaches the dealer.',
    },
  }),
  funded: listView('Funded', 'funding', {
    icon: 'currency-dollar',
    query: 'status = funded',
    show: ['application_id', 'dealer_id.name', 'funded_on', 'amount', 'dealer_reserve'],
    sort: 'funded_on desc',
    filters: ['dealer_id', 'funded_on'],
    totals: ['amount', 'dealer_reserve'],
    density: 'compact',
  }),

  /* ---------- the portfolio ---------- */

  loans: listView('Loans', 'loan', {
    icon: 'car',
    show: ['loan_number', 'customer_id', 'dealer_id.name', 'principal_balance', 'next_due_on', 'days_past_due', 'status'],
    tabs: [
      { segment: 'active', sort: 'loan_number' },
      { segment: 'past_due', sort: 'days_past_due desc' },
      { segment: 'paid_off', sort: 'paid_off_on desc' },
      { segment: 'charged_off', sort: 'charged_off_on desc' },
      { label: 'All', sort: 'funded_on desc' },
    ],
    filters: ['status', 'dealer_id', 'funded_on', 'principal_balance'],
    totals: ['principal_balance'],
    density: 'compact',
  }),
  // The collectors' worklist, by how far behind: the buckets every lender dashboard counts in.
  collections: listView('Collections', 'loan', {
    icon: 'phone',
    query: 'days_past_due > 0 and status in (past_due, delinquent)',
    show: ['loan_number', 'customer_id', 'customer_id.phone', 'amount_due', 'last_paid_on', 'days_past_due'],
    tabs: [
      { segment: 'segment_1_29_days', sort: 'days_past_due desc' },
      { segment: 'segment_30_59_days', sort: 'days_past_due desc' },
      { segment: 'segment_60_89_days', sort: 'days_past_due desc' },
      { segment: 'segment_90_days', sort: 'days_past_due desc' },
      { label: 'All', sort: 'days_past_due desc' },
    ],
    filters: ['dealer_id'],
    totals: ['amount_due'],
    rowActions: true,
    empty: { title: 'Nobody is behind in this bucket', description: 'Loans with an installment past due are listed by how many days.' },
  }),
  payments: listView('Payments', 'payment', {
    icon: 'receipt',
    show: ['reference', 'loan_id', 'received_on', 'amount', 'method', 'late_fee', 'status'],
    tabs: [
      { segment: 'pending', sort: 'received_on' },
      { segment: 'returned', sort: 'received_on desc' },
      { segment: 'posted', sort: 'received_on desc' },
      { label: 'All', sort: 'received_on desc' },
    ],
    filters: ['method', 'channel', 'received_on', 'status'],
    totals: ['amount'],
    density: 'compact',
  }),
  // A payment carries no revision, so posting runs on its loan: every pending payment of each selected loan, at once.
  posting: listView('Payments to post', 'loan', {
    icon: 'check-circle',
    query: 'pending_payments > 0',
    presentation: queue('loan_number', {
      lines: ['customer_id'],
      properties: ['pending_payments', 'amount_due', 'days_past_due'],
      badge: 'status',
      openLabel: 'Open loan',
    }),
    sort: 'days_past_due desc',
    actions: ['postPayment'],
    empty: { title: 'Every payment is posted', description: 'Payments borrowers make online wait here until servicing posts them.' },
  }),
  'payoff-quotes': listView('Payoff quotes', 'payoff_quote', {
    icon: 'clipboard-text',
    show: ['loan_id', 'loan_id.customer_id', 'requested_on', 'good_through', 'amount', 'per_diem', 'status'],
    tabs: [
      { segment: 'issued', sort: 'good_through' },
      { segment: 'paid', sort: 'requested_on desc' },
      { segment: 'expired', sort: 'requested_on desc' },
      { label: 'All', sort: 'requested_on desc' },
    ],
    filters: ['requested_via', 'requested_on'],
    density: 'compact',
  }),
  customers: listView('Customers', 'customer', {
    icon: 'users',
    show: ['last_name', 'first_name', 'city', 'state', 'loans', 'balance', 'customer_since'],
    sort: 'last_name',
    filters: ['state', 'preferred_contact', 'customer_since'],
    density: 'compact',
  }),

  /* ---------- the dealers ---------- */

  dealers: listView('Dealers', 'dealer', {
    icon: 'storefront',
    show: ['name', 'tier', 'relationship_manager_id.name', 'applications', 'funded_volume', 'book', 'status'],
    tabs: [
      { segment: 'mine', sort: 'name' },
      { segment: 'active', sort: 'name' },
      { segment: 'on_hold', sort: 'name' },
      { segment: 'prospects', sort: 'name' },
      { label: 'All', sort: 'name' },
    ],
    filters: ['tier', 'state', 'kind', 'relationship_manager_id'],
  }),
  visits: listView('Visits', 'dealer_visit', {
    icon: 'handshake',
    show: ['happened_on', 'dealer_id.name', 'kind', 'summary', 'lender_user_id.name'],
    tabs: [
      { segment: 'mine', sort: 'happened_on desc' },
      { label: 'All', sort: 'happened_on desc' },
    ],
    filters: ['dealer_id', 'kind', 'lender_user_id', 'happened_on'],
    density: 'compact',
  }),
  // Apply forms no dealer could take: the lender finds the applicant a home, or closes the file.
  triage: listView('Triage', 'intake_submission', {
    icon: 'envelope',
    show: ['reference', 'first_name', 'last_name', 'dealer_hint', 'vehicle_interest', 'created_at', 'status'],
    tabs: [
      { segment: 'open', sort: 'created_at' },
      { segment: 'followed_up', sort: 'created_at' },
      { segment: 'closed', sort: 'closed_at desc' },
      { label: 'All', sort: 'created_at desc' },
    ],
    rowActions: true,
    empty: { title: 'Nothing to triage', description: 'An apply form the server could not place with a dealer arrives here.' },
  }),

  /* ---------- settings ---------- */

  programs: listView('Programs', 'program', {
    icon: 'tag',
    show: ['name', 'tier', 'min_score', 'base_apr', 'max_term', 'max_amount', 'advertised'],
    // The rate sheet is the one thing edited by hand here, and only by a credit manager.
    editable: ['base_apr', 'max_amount', 'advertised'],
    tabs: [
      { segment: 'active_programs', sort: 'min_score desc' },
      { segment: 'retired', sort: 'name' },
      { label: 'All', sort: 'name' },
    ],
    filters: ['tier'],
  }),
  staff: listView('Staff', 'lender_user', {
    icon: 'user-circle',
    show: ['name', 'role', 'email', 'open_files', 'dealers', 'hired_on'],
    tabs: [
      { segment: 'active_users', sort: 'name' },
      { segment: 'underwriting', sort: 'name' },
      { label: 'All', sort: 'name' },
    ],
    filters: ['role'],
  }),
} satisfies Views;
