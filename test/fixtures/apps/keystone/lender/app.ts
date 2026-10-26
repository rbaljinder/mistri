import { defineApp } from '@mistriwork/mistri/app';
import { appSwitcher } from '../navigation.ts';
import { delinquency, home } from './dashboards.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages/index.ts';
import { resources } from './resources.ts';
import type { App } from './mistri-schema.d.ts';

import { views } from './views.ts';

/* Keystone Auto Finance's own App: the staff who underwrite what the dealers
   submit, fund what is approved, service the loans and look after the
   dealers. Everyone signed in is the lender, so every row is everyone's
   (`rows: 'all'`) and the work is divided by role, by what each role may run
   and by the columns a role may not read. Nothing but the rate sheet is an
   edit: every decision is a command with a receipt. */

/* Who may read the bureau and the applicant's identity: the people who decide.
   Everyone else reads the file without the bureau's answer, the applicant
   without a birth date or SSN, and a dealer without the address its apply
   form is published under, which is the administrator's to rotate. */
const FILE_WITHOUT_BUREAU = [
  'id',
  'application_id',
  'dealer_id',
  'underwriter_id',
  'assigned_at',
  'decided_by',
  'decision_due_at',
  'version',
] as const;
const APPLICANT_WITHOUT_IDENTITY = [
  'id',
  'dealer_id',
  'lead_id',
  'role',
  'first_name',
  'last_name',
  'email',
  'phone',
  'street',
  'city',
  'state',
  'zip',
  'housing',
  'monthly_housing',
  'years_at_address',
  'employer',
  'job_title',
  'employment_type',
  'years_employed',
  'monthly_income',
  'created_at',
] as const;
const DEALER_WITHOUT_ADDRESS = [
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
  'relationship_manager_id',
  'reserve_pct',
  'monthly_goal',
  'joined_on',
  'on_hold_reason',
  'version',
] as const;

const underwriting = [
  'assignUnderwriter',
  'requestCreditCheck',
  'requestStipulation',
  'clearStipulation',
  'waiveStipulation',
  'decideApplication',
] as const;
const funding = ['receiveContract', 'auditFunding', 'fundLoan', 'clearStipulation'] as const;
const servicing = ['postPayment', 'returnPayment', 'waiveLateFee', 'recordServicingNote'] as const;
const relationships = ['logDealerVisit', 'setDealerStatus', 'closeIntakeSubmission'] as const;

export default defineApp({
  id: 'lender',
  name: 'Keystone',
  sources: { keystone: { connection: 'keystone' } },
  resources,
  auth: {
    providers: ['email'],
    defaultRole: 'servicing',
    // A signed-in account is the staff row with its email: "Mine" on the queue, the visits and the dealers.
    me: { from: 'lender_user', column: 'email' },
    roles: {
      // The administrator runs the floor but does not decide credit: separation of duties.
      admin: {
        label: 'Admin',
        read: true,
        commands: [...funding, ...servicing, ...relationships, 'rotateIntakeAddress'],
        operations: ['workflows'],
        actions: { intake_submission: ['markFollowedUp'] },
        fields: { underwriting_file: { read: FILE_WITHOUT_BUREAU }, applicant: { read: APPLICANT_WITHOUT_IDENTITY } },
      },
      credit_manager: {
        label: 'Credit manager',
        read: true,
        write: ['program'],
        commands: [...underwriting, 'closeIntakeSubmission'],
        operations: ['workflows'],
        fields: { dealer: { read: DEALER_WITHOUT_ADDRESS } },
      },
      underwriter: { label: 'Underwriter', read: true, commands: underwriting, fields: { dealer: { read: DEALER_WITHOUT_ADDRESS } } },
      funder: {
        label: 'Funder',
        read: true,
        commands: funding,
        fields: {
          underwriting_file: { read: FILE_WITHOUT_BUREAU },
          applicant: { read: APPLICANT_WITHOUT_IDENTITY },
          dealer: { read: DEALER_WITHOUT_ADDRESS },
        },
      },
      servicing: {
        label: 'Servicing',
        read: true,
        commands: servicing,
        fields: {
          underwriting_file: { read: FILE_WITHOUT_BUREAU },
          applicant: { read: APPLICANT_WITHOUT_IDENTITY },
          dealer: { read: DEALER_WITHOUT_ADDRESS },
        },
      },
      // Held only by service principals (server/jobs.ts), so `service: true`: no account holds either, and no page is
      // offered to them. `integration` is the credit provider's callback; `automation` is what the credit decision
      // workflow (server/credit-decision.ts) does by itself.
      integration: { label: 'Integration', service: true, read: true, commands: ['recordCreditResult'] },
      automation: {
        label: 'Automation',
        service: true,
        read: true,
        commands: ['approveApplication', 'referToUnderwriter', 'remindUnderwriter'],
      },
      relationship_manager: {
        label: 'Relationship manager',
        read: true,
        commands: relationships,
        actions: { intake_submission: ['markFollowedUp'] },
        fields: {
          underwriting_file: { read: FILE_WITHOUT_BUREAU },
          applicant: { read: APPLICANT_WITHOUT_IDENTITY },
          dealer: { read: DEALER_WITHOUT_ADDRESS },
        },
      },
    },
  },
  views: { ...views, home, delinquency },
  pages,
  // Each desk starts where its work is.
  home: [
    { view: 'queue', roles: ['underwriter'] },
    { view: 'funding-queue', roles: ['funder'] },
    { view: 'delinquency', roles: ['servicing'] },
    { view: 'dealers', roles: ['relationship_manager'] },
    { view: 'home' },
  ],
  nav: navigation,
  ui: {
    appSwitcher,
    logo: 'bank',
    // Mono and compact: a dense operations floor, where queues are read row after row.
    theme: { preset: 'mono' },
    shell: {
      placement: 'side',
      rail: true,
      counts: true,
      sidebar: { density: 'compact', footer: { title: 'Keystone Auto Finance', description: 'Harrisburg · Pittsburgh · Philadelphia' } },
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    currency: 'USD',
    footer: { text: 'A demonstration lender. Every applicant, loan and figure is synthetic; no credit is offered.' },
  },
} satisfies App);
