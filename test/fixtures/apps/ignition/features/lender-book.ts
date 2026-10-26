import {
  action,
  card,
  current,
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

/* The lender's book: every dealership's applications and leads, read across
   tenants, and the lender's own review record beside them.

   Two things here are worth reading carefully.

   **The verbs live on the dealership's row, but they are the lender's.** The
   lender's four verbs on `loan_application`, a tenant-owned table — three from
   the application's machine (dealer-workspace.ts) and Revise below — are every
   one of them a platform command. So the very same application row
   offers different verbs depending on which realm the tab is in: inside a
   dealership it offers Withdraw, and on the lender's lease it offers Assign,
   Record review, Record decision and Revise. Neither realm is offered the
   other's, and the server refuses the other's independently of what is drawn.
   Each realm reads the row on a page of its own, because what sits beside it
   differs: the lender's activity is in the platform realm's schema only.

   **The lender's own detail is its own record.** `review_file` is a
   platform-owned row, one per application, holding the desk, the reviewer, the
   manager, the deadline and the notes. It exists because a dealer's row may not
   carry the lender's columns — ownership forbids it — and the happy consequence
   is that "what the dealership sees" needs no field ceiling: the reviewer and the
   notes are not in its realm's schema at all. */

export const lenderBook = defineFeature({
  id: 'lender-book',
  resources: {
    loan_application: {
      /* Assign, Record review and Record decision are the application's
         machine's verbs (dealer-workspace.ts). Assign is `targets: 'many'` so
         it may span dealerships all-or-nothing, with the audit recording each
         target's owning dealership — but not `bulk: true`. A tenant App's HTTP
         host takes one key per execution, so a selection in the browser would
         promise what the transport cannot carry; spanning several is for the
         deployment API. Revising changes the terms, not the state, so it is an
         action of its own in every open state. */
      actions: {
        reviseApplication: action('Revise application', {
          command: 'reviseApplication',
        }),
      },
    },
    application_review: {
      display: { status: { tone: { queued: 'neutral', in_progress: 'info', complete: 'good', canceled: 'neutral' } } },
    },
  },
  auth: {
    roles: {
      manager: { commands: ['assignReviewer', 'recordReview', 'recordDecision', 'reviseApplication'] },
      // A reviewer records what they found and nothing else: recording a review
      // is not a decision, and a reviewer cannot promote themselves into one.
      reviewer: { commands: ['recordReview'] },
      platform_admin: { commands: ['assignReviewer', 'recordDecision', 'reviseApplication'] },
    },
  },
  views: {
    'all-applications': listView('Applications', 'loan_application', {
      icon: 'file-text',
      realm: 'platform',
      // Eight columns including the owning dealership: keep each at its content
      // width and let the grid scroll rather than squeezing references.
      sizing: 'scroll',
      show: ['reference', 'tenant_id', 'applicant_ref', 'status', 'requested_amount', 'term_months', 'submitted_on', 'document_status'],
      filters: ['reference', 'tenant_id', 'status', 'submitted_on'],
      tabs: ['unassigned', 'under_review', 'awaiting_a_decision', 'decided', { label: 'All' }],
    }),
    'review-files': listView('Review files', 'review_file', {
      icon: 'clipboard-text',
      realm: 'platform',
      show: ['application_id.reference', 'dealer_id.name', 'desk_id.name', 'reviewer_id.name', 'manager_id.name', 'review_due_on'],
      filters: ['desk_id', 'reviewer_id'],
    }),
    // Read-only across dealerships: the lender watches what is coming without
    // working anyone's leads. No lead command is granted to a platform role.
    'all-leads': listView('Leads', 'lead', {
      icon: 'address-book',
      realm: 'platform',
      show: ['reference', 'tenant_id', 'vehicle_stock', 'requested_amount', 'submitted_on', 'status'],
      filters: ['tenant_id', 'status', 'submitted_on'],
    }),
    reviews: listView('Reviews', 'application_review', {
      icon: 'list-checks',
      realm: 'platform',
      show: ['application_id.reference', 'reviewer_id.name', 'kind', 'status', 'opened_on', 'completed_on'],
      filters: ['kind', 'status', 'reviewer_id'],
    }),
    decisions: listView('Decisions', 'loan_decision', {
      icon: 'shield-check',
      realm: 'platform',
      show: ['application_id.reference', 'outcome', 'decided_by.name', 'recorded_on'],
      filters: ['outcome', 'decided_by'],
    }),
    assignments: listView('Assignment history', 'assignment_history', {
      icon: 'clock',
      realm: 'platform',
      show: ['application_id.reference', 'assigned_to.name', 'assigned_by.name', 'assigned_on'],
    }),
    documents: listView('Document checklist', 'application_document', {
      icon: 'list-checks',
      realm: 'platform',
      show: ['application_id.reference', 'category', 'status', 'received_on'],
      filters: ['category', 'status'],
    }),
  },
  pages: {
    /* The same application row the dealership opens, on the lender's lease: a
       page of its own in the platform realm over the tenant-owned table. That
       is what lets it read the lender's activity beside the dealership's row —
       the dealership's page is in the tenant realm, where those tables are not
       in the schema at all. The head says whose it is; the filled verb is the
       one its state waits on (Assign, Record review or Record decision,
       whichever `when` holds), and Revise stays secondary. */
    'lender-application': page(
      'loan_application',
      [
        header({
          status: 'status',
          facts: [
            'tenant_id',
            'applicant_ref',
            { column: 'term_months', after: 'month' },
            { column: 'document_status', before: 'Documents' },
            'submitted_on',
          ],
        }),
        fields(['requested_amount', 'down_payment']),
        related('Documents', 'application_document', 'application_id', { show: ['category', 'received_on', 'status'] }),
        // Who was assigned, what was reviewed, what was decided: every stream
        // keys on `application_id`, so it is drawn here and nowhere else.
        timeline(
          'Activity',
          [
            stream('assignment_history', 'application_id', 'assigned_on', 'assigned_to.name', {
              detail: 'reason',
              author: 'assigned_by.name',
            }),
            stream('application_review', 'application_id', 'opened_on', 'kind', { detail: 'summary', author: 'reviewer_id.name' }),
            stream('loan_decision', 'application_id', 'recorded_on', 'outcome', { detail: 'record_note', author: 'decided_by.name' }),
          ],
          { limit: 20 },
        ),
        current('Review file', 'review_file', 'application_id', {
          show: ['desk_id', 'reviewer_id', 'review_due_on'],
          empty: { title: 'Not assigned', description: 'No reviewer holds this application yet.' },
        }),
        fields(['vehicle_id.stock_reference', 'vehicle_id.condition', 'vehicle_id.price'], { title: 'Vehicle', region: 'aside' }),
      ],
      { realm: 'platform' },
    ),
    /* The lender's record of one application: whose it is and when it is due in
       the head, the context the reviewer works from, and the application it
       reviews as a card beside it. */
    'review-file': page(
      'review_file',
      [
        header({ facts: ['dealer_id', 'desk_id', 'review_due_on'] }),
        fields(['review_context'], { title: 'Review context', columns: 1 }),
        fields(
          [
            'application_id.requested_amount',
            'application_id.down_payment',
            'application_id.term_months',
            'application_id.document_status',
          ],
          { title: 'The application', columns: 2 },
        ),
        card('Application', 'application_id', ['status', 'applicant_ref']),
        fields(['reviewer_id', 'manager_id', 'opened_on'], { title: 'File', region: 'aside' }),
        /* No timeline here, deliberately. The lender's activity — who was
         assigned, what was reviewed, what was decided — all keys on
         `application_id`, which leads to `loan_application` and not to this
         page's base. A stream has to point at the record it is drawn on, so the
         activity is on the lender's application page, and this page stays what
         it is: the lender's own file. */
      ],
      { realm: 'platform' },
    ),
    review: page(
      'application_review',
      [
        fields(['application_id', 'reviewer_id', 'kind', 'status', 'opened_on', 'completed_on'], { columns: 3 }),
        fields(['summary'], { title: 'Review record', columns: 1 }),
      ],
      { realm: 'platform' },
    ),
    decision: page(
      'loan_decision',
      [
        fields(['application_id', 'outcome', 'decided_by', 'recorded_on'], { columns: 2 }),
        fields(['record_note'], { title: 'Decision record', columns: 1 }),
      ],
      { realm: 'platform' },
    ),
  },
  nav: [
    navGroup(
      'lender-lending',
      'Lending',
      [
        'all-applications',
        'review-files',
        'all-leads',
        navGroup('lender-records', 'Review records', ['reviews', 'decisions', 'assignments', 'documents']),
      ],
      { realm: 'platform' },
    ),
  ],
} satisfies Feature);
