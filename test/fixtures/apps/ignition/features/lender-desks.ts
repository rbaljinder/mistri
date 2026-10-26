import { breakdown, chart, dashboard, defineFeature, metric, navGroup, rows } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { reviewFileColumns } from './review-file-columns.ts';

/* The lender's three desks: the portfolio across every dealership, the
   reviewer's own queue, and the manager's.

   Everything here is the **platform realm**, which is what makes a cross-dealer
   figure possible at all: the platform reads tenant-owned rows across every
   dealership with no tenant predicate, and sees each row's ownership column, so
   "by dealer" is a real breakdown rather than a join a dealership could do. None
   of these rooms exists in a dealer's menu, and the server refuses them on a
   dealer's lease independently of what is drawn.

   A dashboard here reads both realms' tables at once — a dealership's
   applications beside the lender's own review files and decisions — because the
   platform owns the second set and is allowed the first. */

const active = 'status != approved and status != declined and status != withdrawn';

/* The portfolio. The stacked bars are the point of the room: one bar per
   dealership, divided by the stage its applications are in, so the shape of one
   dealer's book against another's is the thing you see first. The target on the
   approvals metric is the lender's own goal for the snapshot, drawn as a meter
   under the figure — a number with nothing to measure it against is just a
   number. */
const portfolio = dashboard('Portfolio', [
  metric('Applications in flight', 'loan_application', { query: active, width: 'third' }),
  metric('Requested financing', 'loan_application', { query: active, measure: 'sum requested_amount', width: 'third' }),
  metric('Approved in this snapshot', 'loan_application', { query: 'status = approved', width: 'third', target: 12 }),
  chart('Book by dealer and stage', 'loan_application', 'tenant_id, status', { shape: 'stacked', width: 'half', to: 'all-applications' }),
  breakdown('Requested financing by dealer', 'loan_application', 'tenant_id', {
    measure: 'sum requested_amount',
    width: 'half',
    to: 'all-applications',
  }),
  rows('Dealerships', 'dealer', {
    sort: 'name',
    show: ['name', 'region', 'status'],
    limit: 8,
    width: 'half',
  }),
  rows('Applicants to verify', 'applicants.applicant', {
    query: 'verification_status != verified',
    sort: 'created_on',
    show: ['name', 'verification_status'],
    limit: 6,
    width: 'half',
  }),
]);

/* The reviewer's desk: the files on them, oldest deadline first. The deadline is
   dressed `relative` ("in 3 days", "64 days ago"), which is what a reviewer
   wants from a date column; the date itself stays in the tooltip. */
const reviewerDesk = dashboard('Reviewer desk', [
  metric('Open review files', 'review_file', { width: 'third' }),
  metric('Applications in review', 'loan_application', { query: 'status = in_review', width: 'third' }),
  metric('Documents pending', 'loan_application', { query: 'status = documents_pending', width: 'third' }),
  rows('Review files by deadline', 'review_file', {
    sort: 'review_due_on',
    show: [reviewFileColumns.application, reviewFileColumns.dealer, reviewFileColumns.reviewer, reviewFileColumns.deadline],
    limit: 10,
  }),
  rows('Reviews recorded', 'application_review', {
    sort: 'opened_on desc',
    show: ['application_id.reference', 'reviewer_id.name', 'status'],
    limit: 8,
    width: 'half',
  }),
  rows('Documents needing revision', 'application_document', {
    query: 'status = needs_revision',
    show: ['application_id.reference', 'category', 'notes'],
    limit: 8,
    width: 'half',
  }),
]);

/* The manager's desk: what waits on a decision, and what waits on an
   assignment. The unassigned queue spans dealerships on purpose — assignReviewer
   takes a selection across them, all of it or none. */
const managerDesk = dashboard('Manager desk', [
  metric('Awaiting a decision', 'loan_application', { query: 'status = manager_review', width: 'third' }),
  metric('Unassigned submissions', 'loan_application', { query: 'status = submitted', width: 'third' }),
  metric('Decisions recorded', 'loan_decision', { width: 'third' }),
  rows('Awaiting a decision', 'loan_application', {
    query: 'status = manager_review',
    sort: 'submitted_on',
    show: ['reference', 'tenant_id', 'applicant_ref', 'requested_amount', 'status'],
    limit: 8,
  }),
  breakdown('Open files by reviewer', 'review_file', 'reviewer_id.name', { width: 'half' }),
  chart('Recorded outcomes', 'loan_decision', 'outcome', { shape: 'donut', width: 'half' }),
]);

export const lenderDesks = defineFeature({
  id: 'lender-desks',
  resources: {
    // The lender's own vocabularies, declared where its desks show them.
    // A file is named for the application it reviews; its head says whose.
    review_file: { recordLabel: 'application_id.reference', display: { review_due_on: { format: 'relative' } } },
    loan_decision: { display: { outcome: { tone: { approved: 'good', declined: 'bad' } } } },
    dealer: { display: { status: { tone: { active: 'good', suspended: 'warn' } } } },
  },
  views: {
    portfolio: { ...portfolio, icon: 'chart-pie', realm: 'platform' },
    'reviewer-desk': { ...reviewerDesk, icon: 'clipboard-text', realm: 'platform' },
    'manager-desk': { ...managerDesk, icon: 'gauge', realm: 'platform' },
  },
  nav: [navGroup('lender-desk-rooms', 'Desks', ['portfolio', 'reviewer-desk', 'manager-desk'], { realm: 'platform' })],
} satisfies Feature);
