import {
  count,
  dashboard,
  defineFeature,
  fields,
  header,
  listView,
  machine,
  metric,
  navGroup,
  page,
  queue,
  related,
  rows,
} from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* One dealership, as its own people see it: the leads that came in, the
   applications they became, and the cars on the lot.

   Everything here is the **tenant realm**, and everything a dealership sees is
   its own. That is not this file's doing: the runtime composes the ownership
   predicate outside every query, and the lender's tables are absent from a
   dealer's catalog altogether. So no view here needs a filter to stay inside
   its dealership, and none of the lender's columns can appear even by mistake —
   the reviewer, the desk and the review notes are not in this realm's schema.
   What a dealership reads about the lender's progress is exactly what its own
   application row says: a status, and in the end an outcome.

   The three dealerships hold the same references — `L-2001`, `AL-1001` — so
   opening one dealership and then another is how the sample shows isolation. */

const leadStatus = { tone: { new: 'neutral', qualified: 'info', converted: 'good', disqualified: 'bad' } } as const;
const applicationStatus = {
  tone: {
    submitted: 'neutral',
    documents_pending: 'warn',
    in_review: 'info',
    manager_review: 'warn',
    approved: 'good',
    declined: 'bad',
    withdrawn: 'neutral',
  },
  values: { documents_pending: 'Documents', manager_review: 'With a manager' },
} as const;

/* The closing verbs, held here so a page's header names the verb itself. */
const disqualify = { to: 'disqualified', label: 'Disqualify' } as const;
const withdraw = { to: 'withdrawn', label: 'Withdraw application' } as const;

/* How a lead moves: saved step by step as a draft by the public form, sent on
   by its submit, then qualified and converted by the dealership, or
   disqualified on the way. Each verb is a command; the graph is where each
   runs from, the order of the buttons, and the only status changes the
   server takes from anyone. */
const leadMachine = machine('status', {
  draft: { on: { applyForFinancing: 'new' } },
  new: { on: { qualifyLead: 'qualified', disqualifyLead: disqualify } },
  qualified: { on: { convertLead: { to: 'converted', label: 'Convert to application' }, disqualifyLead: disqualify } },
  converted: { final: true },
  disqualified: { final: true },
});

/* The application's gate, in order. Both realms draw it on their own page of
   the same row: the dealership to see where its application stands, the lender
   to see what it is to do next. The lender's verbs are platform commands and
   the dealership's is its own, so each realm is offered its own buttons from
   the one graph. A review may ask for documents first; declined and withdrawn
   are exits. */
const applicationMachine = machine('status', {
  submitted: { on: { assignReviewer: 'in_review', withdrawApplication: withdraw } },
  in_review: { on: { recordReview: ['manager_review', 'documents_pending'], withdrawApplication: withdraw } },
  documents_pending: { on: { recordReview: ['manager_review', 'documents_pending'], withdrawApplication: withdraw } },
  manager_review: { on: { recordDecision: ['approved', 'declined'], withdrawApplication: withdraw } },
  approved: { final: true },
  declined: { final: true },
  withdrawn: { final: true },
});

/* The dealer's own front page: what came in, what is in flight, what closed.
   No figure here is the lender's — a dealership cannot count another's. */
const home = dashboard('Dealership', [
  metric('New leads', 'lead', { query: 'status = new', width: 'third' }),
  metric('Applications in flight', 'loan_application', {
    query: 'status != approved and status != declined and status != withdrawn',
    width: 'third',
  }),
  metric('Approved', 'loan_application', { query: 'status = approved', width: 'third' }),
  rows('Leads to work', 'lead', {
    query: 'status = new or status = qualified',
    sort: 'submitted_on',
    // Half the width beside the menu holds who and where they stand. The car
    // and the amount are on the lead, one click away.
    show: ['reference', 'applicant_name', 'status'],
    limit: 8,
    width: 'half',
  }),
  rows('Applications awaiting the lender', 'loan_application', {
    query: 'status != approved and status != declined and status != withdrawn',
    sort: 'submitted_on',
    show: ['reference', 'status'],
    limit: 8,
    width: 'half',
  }),
]);

export const dealerWorkspace = defineFeature({
  id: 'dealer-workspace',
  resources: {
    // Each row is named by what a person says of it, not by its composite id.
    lead: {
      segments: {
        open: 'status = new or status = qualified',
        /* `converted` and `disqualified` are the machine's states, which a query already reads as words. */
        converted_leads: { query: 'status = converted', label: 'Converted' },
        disqualified_leads: { query: 'status = disqualified', label: 'Disqualified' },
      },
      recordLabel: 'applicant_name',
      display: {
        requested_amount: { format: 'money' },
        down_payment: { format: 'money' },
        annual_income: { format: 'money' },
        status: leadStatus,
      },
      /* Qualify is `targets: 'many'`, but deliberately not `bulk: true`: a
         tenant App's HTTP host takes one key per execution, so offering a
         selection in the browser would promise something the transport cannot
         carry. The command still spans several records all-or-nothing when it
         is driven through the deployment API. */
      machine: leadMachine,
    },
    loan_application: {
      segments: {
        in_flight: 'status != approved and status != declined and status != withdrawn',
        decided: 'status = approved or status = declined',
        /* The lender's queue (lender-book.ts). `in_review` is a state of the machine, so its tab is `under_review`. */
        unassigned: 'status = submitted',
        under_review: { query: 'status = in_review or status = documents_pending', label: 'In review' },
        awaiting_a_decision: 'status = manager_review',
      },
      recordLabel: 'reference',
      display: {
        requested_amount: { format: 'money' },
        down_payment: { format: 'money' },
        status: applicationStatus,
        document_status: { tone: { not_started: 'neutral', incomplete: 'warn', complete: 'good' } },
      },
      machine: applicationMachine,
    },
    application_document: {
      recordLabel: 'category',
      display: { status: { tone: { requested: 'neutral', received: 'info', reviewed: 'good', needs_revision: 'warn' } } },
    },
    vehicle: {
      recordLabel: 'stock_reference',
      /* How many of the dealership's applications finance this car: counted in
         the dealership's own context, as every read of a tenant is, so it is
         the dealer's number and never another's (tenant-rollups.test.ts). */
      rollups: { applications: count('loan_application', { whose: 'vehicle_id' }) },
      display: {
        price: { format: 'money' },
        mileage: { unit: 'mi' },
        // The car's id is the lot's tag: a code to scan on its page, its text wherever a list shows it. (The stock
        // reference names the record, so the header already says it and a fields section leaves it out.)
        id: { format: 'qr' },
        status: { tone: { available: 'good', financed: 'info', sold: 'neutral' } },
      },
    },
  },
  auth: {
    roles: {
      dealer_admin: { commands: ['qualifyLead', 'disqualifyLead', 'convertLead', 'withdrawApplication'] },
      // Staff work leads but do not qualify them: separating who confirms a
      // deal from who handles it is the point of having two roles. They hold no
      // generic write either, so every change they make is an audited command.
      dealer_staff: { commands: ['disqualifyLead', 'convertLead'] },
    },
  },
  views: {
    'dealer-home': { ...home, icon: 'house', realm: 'tenant' },
    leads: listView('Leads', 'lead', {
      icon: 'address-book',
      realm: 'tenant',
      show: ['reference', 'applicant_name', 'vehicle_stock', 'requested_amount', 'term_months', 'submitted_on', 'status'],
      filters: ['reference', 'vehicle_stock', 'status', 'submitted_on'],
      tabs: ['open', 'converted_leads', 'disqualified_leads', { label: 'All' }],
    }),
    // The queue offers Qualify, the one lead action marked `bulk`.
    'new-leads': listView('New leads', 'lead', {
      icon: 'user',
      realm: 'tenant',
      query: 'status = new',
      presentation: queue('reference', { lines: ['applicant_name', 'requested_amount'] }),
    }),
    applications: listView('Applications', 'loan_application', {
      icon: 'file-text',
      realm: 'tenant',
      show: ['reference', 'applicant_ref', 'requested_amount', 'term_months', 'submitted_on', 'status', 'document_status'],
      filters: ['reference', 'status', 'submitted_on'],
      tabs: ['in_flight', 'decided', { label: 'All' }],
    }),
    inventory: listView('Inventory', 'vehicle', {
      icon: 'car',
      realm: 'tenant',
      show: ['stock_reference', 'model_id.make', 'model_id.model', 'condition', 'mileage', 'price', 'status'],
      filters: ['stock_reference', 'condition', 'status'],
    }),
  },
  pages: {
    /* A lead opens on who it is and where it stands: its state beside the name,
       the reference, the car and the day it came in under it. The forward verb
       for its state (Qualify, then Convert) is the filled one; Disqualify is a
       closing word, so it is named destructive and drawn last and quiet. */
    lead: page('lead', [
      header({ status: 'status', facts: ['reference', 'vehicle_stock', 'submitted_on'], destructive: ['disqualifyLead'] }),
      // The machine's road stands over the summary as a stepper, so a lead's
      // place in the dealer's gate is visible at a glance.
      fields(['requested_amount', 'down_payment', 'term_months'], { columns: 3 }),
      fields(['applicant_email', 'applicant_phone', 'employer', 'annual_income'], { title: 'Applicant', columns: 2 }),
      // Where the applicant lives, as they saved it step by step on the public form.
      fields(['address_line', 'city', 'state', 'postal_code'], { title: 'Address', columns: 2 }),
      related('Co-applicants', 'lead_co_applicant', 'lead_id', { show: ['position', 'name', 'email'] }),
      fields(['qualified_by', 'qualified_on', 'disqualified_reason'], { title: 'Decision', columns: 2 }),
      related('Application', 'loan_application', 'lead_id', {
        show: ['reference', 'status', 'requested_amount', 'submitted_on'],
        when: 'status = converted',
      }),
    ]),
    /* The application record, as the dealership reads it: its state and the
       applicant it names in the head, the terms and the gate under it, the
       document checklist below, and the car it finances beside it, so the row a
       dealer refers to on the phone is always in view. Withdrawing is the
       dealership's last word on an application, never its next step, so no verb
       here is filled. The lender's own file is not here: a dealer's realm has no
       such table. */
    application: page('loan_application', [
      header({
        status: 'status',
        facts: [
          'applicant_ref',
          { column: 'term_months', after: 'month' },
          { column: 'document_status', before: 'Documents' },
          'submitted_on',
        ],
        destructive: ['withdrawApplication'],
      }),
      // Two figures share a row beside the aside and the menu; the term and the
      // checklist's state are facts in the head.
      fields(['requested_amount', 'down_payment']),
      fields(['withdrawn_reason'], { title: 'Withdrawal', columns: 1, when: 'status = withdrawn' }),
      related('Documents', 'application_document', 'application_id', { show: ['category', 'received_on', 'status'] }),
      // The vehicle is the application's own reference, not a list of children,
      // so it is said along that key beside the page rather than as a related section.
      fields(['vehicle_id.stock_reference', 'vehicle_id.condition', 'vehicle_id.mileage', 'vehicle_id.price'], {
        title: 'Vehicle',
        region: 'aside',
      }),
      /* No lender activity here, and it is not an omission. This page is in the
         tenant realm, where reading `assignment_history` is refused outright
         (appTenancy.ts): the realm boundary is not a projection that happens to
         come back empty for a dealership, it is a declaration the App is not
         allowed to make. The lender reads the same application on a page of its
         own, in its own realm (`lender-application` in lender-book.ts), with the
         reviews, decisions and assignments beside it; a dealership sees the one
         thing it is told: its application's status. */
    ]),
    vehicle: page('vehicle', [
      header({
        status: 'status',
        facts: ['model_id.make', 'model_id', 'condition', 'mileage', 'price', { column: 'applications', after: 'application' }],
      }),
      fields(['id'], { title: 'Lot tag', columns: 1 }),
      related('Applications', 'loan_application', 'vehicle_id', {
        show: ['reference', 'applicant_ref', 'requested_amount', 'status'],
      }),
    ]),
  },
  nav: [navGroup('dealership-work', 'Work', ['dealer-home', 'leads', 'new-leads', 'applications', 'inventory'], { realm: 'tenant' })],
} satisfies Feature);
