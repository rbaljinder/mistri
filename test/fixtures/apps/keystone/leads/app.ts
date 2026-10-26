import { defineApp, expose, navGroup } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { applications } from './features/applications.ts';
import { apply } from './features/apply.ts';
import { desk } from './features/desk.ts';
import { inventory } from './features/inventory.ts';
import { leads } from './features/leads.ts';
import { support } from './features/support.ts';
import { todayFeature } from './features/today.ts';
import { dealerReads, dealerTables, lenderTables, supportReads } from './tables.ts';
import type { App, Resources } from './mistri-schema.d.ts';

/* Keystone for dealers: the lead desk and the deal desk of the Keystone suite
   (test/fixtures/apps/keystone/SUITE.md), and its one tenant App. Each dealer is a
   tenant; Keystone, the lender, is the platform realm above them.

   Why tenancy and not a `dealer_id` filter: a dealer's context cannot read
   another dealer's rows or any of the lender's, because the runtime composes
   the ownership predicate outside every query and leaves the lender's tables
   out of a dealer's catalog. Every trading dealer holds its own LD-1001 and
   DL-1001, so opening two dealers is how you see it.

   No role holds generic write. A table a command writes may change only
   through commands, and every change here is one: logging a contact writes
   the timeline and moves the lead, desking recomputes the deal and its grid,
   submitting writes the application and starts the decision clock. */

/** Every table, its owner, and at most what may be done to it. `write` is
    the commands' ceiling; no role is granted it. */
const resources = {
  program: { owner: 'global', recordLabel: 'name' },
  // 'write' only because a command's target sits inside the write ceiling:
  // a walk-in is recorded on the car. No command here changes a car.
  vehicle: { access: 'write', owner: 'tenant' },
  lead: { access: 'write', owner: 'tenant' },
  lead_activity: { access: 'write', owner: 'tenant' },
  applicant: { access: 'write', owner: 'tenant', audit: { redact: ['date_of_birth', 'ssn_last4', 'street', 'monthly_income'] } },
  deal: { access: 'write', owner: 'tenant' },
  deal_scenario: { access: 'write', owner: 'tenant' },
  trade_in: { access: 'write', owner: 'tenant' },
  loan_application: { access: 'write', owner: 'tenant' },
  stipulation: { access: 'write', owner: 'tenant' },
  dealer_user: { owner: 'tenant', recordLabel: 'name', hidden: ['dealer_account_id'] },
  vehicle_photo: { owner: 'tenant' },
  dealer: { owner: 'platform' },
  // The public apply form writes a triage submission when no dealer's address
  // placed it; the decision clock writes an alert.
  intake_submission: { access: 'write', owner: 'platform' },
  decision_alert: { access: 'write', owner: 'platform' },
} satisfies Resources;

/* The rest of the database: a tenant App's database may hold only its
   declared resources, so the tables no role here reads are declared too, as
   the lender's (or, for the dealer's website, the dealer's) and nothing more.
   They are outside the generated types, which hold what some role can read,
   so they are added to the typed block untyped. */
const undeclared = [...lenderTables, ...dealerTables].filter((table) => !(table in resources));
const everyTable = {
  ...resources,
  ...Object.fromEntries(
    undeclared.map((table) => [
      table,
      {
        owner: (dealerTables as readonly string[]).includes(table) ? 'tenant' : 'platform',
      },
    ]),
  ),
  /* Photos are bytes, and a tenant App serves no file resource yet (SUITE.md,
     G8), so the bytes are cut from every reader. Said outside the typed block:
     a hidden column is absent from the generated types, so the typed block
     cannot name it. */
  vehicle_photo: { ...resources.vehicle_photo, hidden: ['data', 'thumbnail'] },
  // What the dealer paid is its own figure and never the desk's to quote.
  vehicle: { ...resources.vehicle, hidden: ['cost'] },
} as typeof resources;

/* No role here carries a column ceiling. SUITE.md asks for them (the SSN's
   last four and the date of birth for the finance office, the dealer's cost
   and a trade's actual cash value for the managers), but in a tenant App a
   role's `fields` on any table a command reads refuses startup ("Command
   field authorization is not supported yet"), and every desk command reads
   the applicant and the car as parents of the rows it writes. So the dealer's
   cost is hidden from everyone here instead (the dealer's own App shows it),
   and the applicant's identity is read by every role that reads applicants
   (README, gaps). */

const selling = ['logContact', 'takeApplication', 'startDeal', 'markLeadLost', 'recordWalkIn', 'addTradeIn'] as const;
const desking = [...selling, 'structureDeal', 'selectScenario', 'markStipulationReceived'] as const;
// Separation of duties: only the finance office and the owner speak to Keystone.
const financing = [...desking, 'submitToLender', 'markContracted', 'withdrawApplication'] as const;

export default defineApp({
  id: 'leads',
  name: 'Keystone Desk',
  sources: { keystone: { connection: 'keystone' } },
  resources: everyTable,
  auth: {
    providers: ['email'],
    // A sign-in grants nothing until a membership does: the dealer's owner
    // invites its people, Keystone's operators grant its own.
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Keystone' } },
    roles: {
      owner: { label: 'Owner', realm: 'tenant', read: dealerReads, commands: financing },
      finance_manager: { label: 'Finance manager', realm: 'tenant', read: dealerReads, commands: financing },
      sales_manager: { label: 'Sales manager', realm: 'tenant', read: dealerReads, commands: desking },
      salesperson: { label: 'Salesperson', realm: 'tenant', read: dealerReads, commands: selling },
      viewer: { label: 'Viewer', realm: 'tenant', read: dealerReads },
      // Keystone's dealer support: every dealer's pipeline, triage and late
      // decisions, and a support session into one dealer as its viewer.
      dealer_support: {
        label: 'Dealer support',
        realm: 'platform',
        read: supportReads,
        fields: {
          dealer: {
            read: [
              'id',
              'name',
              'legal_name',
              'kind',
              'franchise_make',
              'status',
              'tier',
              'street',
              'city',
              'state',
              'zip',
              'phone',
              'email',
              'reserve_pct',
              'monthly_goal',
              'joined_on',
              'on_hold_reason',
              'version',
            ],
          },
        },
      },
      // Held only by the decision clock's service principal (server/jobs.ts).
      automation: { label: 'Automation', realm: 'platform', read: ['loan_application', 'decision_alert'], commands: ['flagLateDecision'] },
    },
  },
  features: [todayFeature, leads, desk, applications, inventory, support, apply],
  home: [{ view: 'welcome', signedOut: true }, { view: 'dealers', roles: ['dealer_support'] }, { view: 'today' }],
  nav: [
    'today',
    navGroup('selling', 'Leads', ['new-leads', 'leads'], { icon: 'address-book', realm: 'tenant' }),
    navGroup('financing', 'Deals', ['deals', 'applications', 'stipulations'], { icon: 'handshake', realm: 'tenant' }),
    'inventory',
    { feature: 'support' },
  ],
  /* A dealer's own systems (its CRM, its website) read its leads, deals,
     applications and cars and can log a contact or start a deal. A token is
     one dealer's, so no field says whose; nothing of Keystone's is here. */
  api: {
    version: 1,
    roles: ['owner', 'sales_manager', 'finance_manager'],
    description: "A Keystone dealer's own leads, deals, applications and inventory.",
    resources: {
      lead: expose([
        'id',
        'reference',
        'source',
        'status',
        'first_name',
        'last_name',
        'email',
        'phone',
        'vehicle_id',
        'created_at',
        'next_follow_up_on',
        'version',
      ]),
      deal: expose([
        'id',
        'reference',
        'lead_id',
        'vehicle_id',
        'status',
        'sale_price',
        'amount_financed',
        'term_months',
        'apr',
        'monthly_payment',
        'version',
      ]),
      loan_application: expose([
        'id',
        'reference',
        'deal_id',
        'status',
        'requested_amount',
        'approved_amount',
        'approved_apr',
        'approved_term',
        'submitted_at',
        'decided_at',
        'version',
      ]),
      vehicle: expose(['id', 'stock_number', 'vin', 'year', 'make', 'model', 'trim', 'mileage', 'list_price', 'status']),
    },
    commands: ['logContact', 'startDeal'],
  },
  ui: {
    appSwitcher,
    logo: 'handshake',
    theme: { preset: 'lumen' },
    shell: { placement: 'side', rail: true, counts: true },
    footer: { text: 'Keystone Auto Finance is fictional. No rate, offer or decision here is real.' },
    currency: 'USD',
    locale: 'en-US',
    timezone: 'America/New_York',
  },
} satisfies App);
