import { defineApp, expose } from '@mistriwork/mistri/app';
import type { App, Tables } from './mistri-schema.d.ts';
import { applicantDirectory } from './features/applicant-directory.ts';
import { dealerRegistry } from './features/dealer-registry.ts';
import { dealerWorkspace } from './features/dealer-workspace.ts';
import { intakeTriage } from './features/intake-triage.ts';
import { lenderBook } from './features/lender-book.ts';
import { lenderDesks } from './features/lender-desks.ts';
import { lenderStaff } from './features/lender-staff.ts';
import { publicSite } from './features/public-site.ts';
import { reviewClock } from './features/review-clock.ts';

/* Ignition: a lender's platform above its dealerships.
 *
 * Each dealership is a **tenant** and the lender is the **platform** realm above
 * them all. That shape is declared in three places which must agree, and startup
 * refuses the App if they do not: `auth.rows: 'tenant'` with `auth.tenancy`, an
 * `owner` on every resource, and a `realm` on every role, root menu group and
 * realm-specific view, page and command reference. The server-only
 * `tenant-policy.ts` beside this file says the same thing in deployment terms —
 * which column owns a row, what each realm may read.
 *
 * What that buys, and why it is not a `dealer_id` filter: a dealership's context
 * cannot read another's rows or any of the lender's, and not because a view
 * omits them. The runtime composes the ownership predicate outside every caller
 * filter, holds the platform's tables false before either row policy runs, and
 * leaves them out of the tenant's visible catalog and schema altogether. The
 * three dealerships hold the same `L-2001` and `AL-1001` on purpose, so
 * isolation is something this sample demonstrates rather than asserts.
 *
 * No role holds generic write. Every change is a named command in exactly one
 * realm: a dealership works its own leads and withdraws its own application, the
 * lender assigns, reviews, decides and revises, and neither realm can run the
 * other's. The platform realm could not hold `write` in any case — by
 * declaration it changes records only through its commands.
 */
const lending = [
  'dealer',
  'review_desk',
  'lender_staff',
  'review_file',
  'application_review',
  'loan_decision',
  'assignment_history',
  'review_alert',
  'intake_submission',
  'intake_co_applicant',
  'lead',
  'lead_co_applicant',
  'loan_application',
  'application_document',
  'vehicle',
  'vehicle_model',
] as const satisfies readonly (keyof Tables)[];

/** Every table a dealership's own roles read: its five owned tables and the
 * shared model catalogue. Naming them is presentation — a tenant role's
 * `read: true` stops at the lender's tables whatever this says — but naming
 * them says out loud what a dealership's realm consists of. */
const dealerTables = [
  'lead',
  'lead_co_applicant',
  'loan_application',
  'application_document',
  'vehicle',
  'vehicle_model',
] as const satisfies readonly (keyof Tables)[];

export default defineApp({
  id: 'ignition',
  name: 'Ignition',
  sources: {
    // The App's own database: every dealership's rows and the lender's, one
    // tenant store, one command journal.
    lending: { connection: 'loans', default: true },
    // The lender's customer file, in a database of its own that only the
    // platform realm ever reads. A dealership's context is built without it.
    applicants: { connection: 'applicants', realm: 'platform' },
  },
  /* Every resource, who owns its rows, and at most what may be done to it.
     `write` is the commands' ceiling, not a grant: no role holds generic write,
     so Save, New and Delete are off for everyone and each change goes through a
     named command in its own realm and its own transaction.

     `audit` says what a support session's write trail keeps of a row it changed.
     A column named in `redact` is recorded as a keyed hash instead of its value,
     in a change and in a delete's before image alike, so a dealership can verify
     exactly what an operator did without the audit becoming a second copy of its
     applicants' details. The rule sits on the resource because it is a fact
     about the rows rather than about one writer.

     What is named, and what is not. Named: an applicant's name, email and phone,
     and every free-text column a person's circumstances end up in — why a lead
     was disqualified, why an application was withdrawn, what a reviewer found,
     what a decision noted, what triage did next. Not named, on purpose:
     references, amounts, terms, dates and statuses. Those are the deal, and they
     are what an operator is audited *against* — a trail that redacted them would
     satisfy nobody reading it. Three writable tables name nothing because they
     hold nothing personal: a desk allocation's reason, an alert's two dates, and
     the dealership's own business facts. */
  resources: {
    // The lender's own. `dealer` is the tenancy profile, one row per tenant, and
    // the only platform table a dealership's row may point at — through its
    // ownership column and nothing else.
    dealer: { noun: 'dealership', access: 'write', owner: 'platform' },
    review_desk: { owner: 'platform' },
    lender_staff: { noun: 'staff', owner: 'platform' },
    review_file: { access: 'write', owner: 'platform', audit: { redact: ['review_context'] } },
    application_review: { noun: 'review', access: 'write', owner: 'platform', audit: { redact: ['summary'] } },
    loan_decision: { noun: 'decision', access: 'write', owner: 'platform', audit: { redact: ['record_note'] } },
    assignment_history: { access: 'write', owner: 'platform' },
    review_alert: { access: 'write', owner: 'platform' },
    // The applicant typed `dealer_hint` themselves, and `outcome_note` is what
    // the lender did about a person it then followed up. Where they live and
    // what they earn are theirs too, and so are their co-applicants.
    intake_submission: {
      noun: 'submission',
      access: 'write',
      owner: 'platform',
      audit: {
        redact: [
          'applicant_name',
          'applicant_email',
          'applicant_phone',
          'address_line',
          'city',
          'state',
          'postal_code',
          'employer',
          'annual_income',
          'dealer_hint',
          'outcome_note',
        ],
      },
    },
    intake_co_applicant: { access: 'write', owner: 'platform', audit: { redact: ['name', 'email'] } },
    // The dealership's own — and the two tables a support session actually
    // writes, so their rules are the ones a dealer's log is read against.
    lead: {
      access: 'write',
      owner: 'tenant',
      audit: {
        redact: [
          'applicant_name',
          'applicant_email',
          'applicant_phone',
          'address_line',
          'city',
          'state',
          'postal_code',
          'employer',
          'annual_income',
          'disqualified_reason',
        ],
      },
    },
    lead_co_applicant: { access: 'write', owner: 'tenant', audit: { redact: ['name', 'email'] } },
    loan_application: { noun: 'application', access: 'write', owner: 'tenant', audit: { redact: ['withdrawn_reason'] } },
    application_document: { owner: 'tenant' },
    vehicle: { owner: 'tenant' },
    // Shared reference data every dealership reads and none owns.
    // A model year is a name, said as written (2024), never as a quantity (2,024).
    vehicle_model: { owner: 'global', recordLabel: 'model', display: { model_year: { format: 'year' } } },
    // The platform-only source, read only, by qualified name.
    'applicants.applicant': { owner: 'platform' },
    'applicants.residence': { owner: 'platform' },
    'applicants.contact': { owner: 'platform' },
    'applicants.employment': { owner: 'platform' },
  },
  auth: {
    providers: ['email'],
    // Membership decides authority: a native sign-in grants nothing until a
    // dealer admin or the lender's own maintenance grants a membership.
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    /* Each membership admits its own realm's roles only, and the two sets never
       union. A dealership's three roles differ by what they may decide; the
       lender's four by whose work they are. Each role's commands come with the
       feature that offers them. */
    roles: {
      dealer_admin: { realm: 'tenant', read: dealerTables, write: false },
      dealer_staff: { realm: 'tenant', read: dealerTables, write: false },
      dealer_viewer: { realm: 'tenant', read: dealerTables, write: false },
      // `read: true` is the platform realm's ceiling: every dealership's rows,
      // the lender's own, and the applicants database.
      platform_admin: { realm: 'platform', read: true, operations: ['readiness'] },
      manager: { realm: 'platform', read: true, operations: ['readiness'] },
      // Narrowed by the applicant directory's column ceilings.
      reviewer: { realm: 'platform', read: true },
      // Held only by the review clock's service principal (jobs.ts). Its command
      // is a platform command, so the role is the platform's too; its reads and
      // that one command come with the review clock.
      automation: { realm: 'platform' },
    },
  },
  features: [
    publicSite,
    dealerWorkspace,
    lenderDesks,
    lenderBook,
    reviewClock,
    intakeTriage,
    dealerRegistry,
    lenderStaff,
    applicantDirectory,
  ],
  /* Signed out, the lender's front page. Signed in, where someone starts
     follows the roles their membership admitted, which is the same thing as the
     realm they are in: only a platform membership can hold `manager`, and only
     a dealership's can hold `dealer_staff`. The server picks the rule from the
     verified membership, and a rule's view must be one those roles can read.
     The list ends unconditionally, because a rule list that can match nobody
     would leave a visitor with no home at all: the lender's own people match
     the portfolio first, and everyone else opens on their dealership. */
  home: [
    { view: 'welcome', signedOut: true },
    { view: 'portfolio', roles: ['platform_admin', 'manager', 'reviewer'] },
    { view: 'dealer-home' },
  ],
  /* The menu is arrangement only: each feature brings its own group, already
     saying which realm it serves. A tab in one realm never draws the other's
     entries, and the server refuses the other's rooms independently of what is
     drawn. The public views are in no menu. */
  nav: [
    { feature: 'dealer-workspace' },
    { feature: 'lender-desks' },
    { feature: 'lender-book' },
    { feature: 'review-clock' },
    { feature: 'intake-triage' },
    { feature: 'dealer-registry' },
    { feature: 'lender-staff' },
    { feature: 'applicant-directory' },
  ],
  /* An App API for the dealership's own data: the rooms above, answered to a
     program instead of a person.

     What it exposes, and what it never does. A dealership's own four tables,
     read only, with the fields named one by one — the contract takes read fields
     alone, generic writes are not part of it, and a filter or a sort has to be a
     field that is listed. Two of the dealership's own commands, so a dealer's
     system can qualify and convert without anyone in a browser. And nothing of
     the lender's: no `applicants.*` resource, because that source is the
     platform realm's alone; no platform-realm view; no platform command. Each of
     those three is refused by name when the App is read, so this block is held
     to the dealership's own surface rather than trusted to stay there.

     A token is one dealership's, which is why the roles are the two that hold a
     dealership's commands. `tenant_id` is deliberately not among the fields: a
     token is already scoped to one dealership, so the column would say only what
     the token already said.

     The two commands are the lead's own: qualify and convert, so a dealer's
     system can work its leads without a person in a browser. `disqualifyLead`
     is not among them deliberately — it takes a reason a person writes, and a
     lead closed by an integration with no reason is worse than one left open.
     Nor is `withdrawApplication`: withdrawal is the dealership's last word on an
     application under the lender's review, and this sample keeps it to someone
     who can see what they are withdrawing. */
  api: {
    version: 1,
    roles: ['dealer_admin', 'dealer_staff'],
    description: "A dealership's own leads, applications, documents and inventory.",
    resources: {
      lead: expose([
        'id',
        'reference',
        'applicant_name',
        'applicant_email',
        'vehicle_stock',
        'requested_amount',
        'down_payment',
        'term_months',
        'submitted_on',
        'status',
        'version',
      ]),
      loan_application: expose([
        'id',
        'reference',
        'applicant_ref',
        'status',
        'requested_amount',
        'down_payment',
        'term_months',
        'submitted_on',
        'document_status',
        'version',
      ]),
      application_document: expose(['id', 'application_id', 'category', 'status', 'received_on']),
      vehicle: expose(['id', 'stock_reference', 'condition', 'mileage', 'price', 'status']),
    },
    commands: ['qualifyLead', 'convertLead'],
  },
  ui: {
    logo: 'lightning',
    shell: { placement: 'side', rail: true },
    currency: 'USD',
    locale: 'en-US',
    export: false,
    footer: { text: 'Ignition is a fictional lender. No rate, offer or decision on this page is real.' },
  },
} satisfies App);

export { lending };
