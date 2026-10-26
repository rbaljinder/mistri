/**
 * Keystone Desk's tenant policy: dealers are tenants, Keystone the platform
 * above them. Server-only, loaded with `--policy`, never imported by the App.
 *
 * - Ownership: `dealer_id` on the twelve dealer tables, `program` global and
 *   read-only, the lender's eighteen tables platform. It agrees with each
 *   resource's `owner` in app.ts, and startup refuses the App if it does not.
 * - Rows: a dealer reads its own working tables (the runtime composes the
 *   tenant predicate outside these, so they widen nothing); Keystone's
 *   support reads every dealer's pipeline and its own triage and alerts.
 * - Administration and invitations, delegated to the dealer's owner.
 * - Support: dealer support enters one dealer as its viewer.
 * - Intake: the profile column a published apply link names.
 */
import { defineAppTenantPolicy, type AppTenantPolicy } from '@mistriwork/mistri/policy';

const DAY = 24 * 60 * 60 * 1000;
const tenant = { kind: 'tenant', column: 'dealer_id' } as const;
const platform = { kind: 'platform' } as const;

const dealerRows = Object.freeze({
  vehicle: true,
  vehicle_photo: true,
  lead: true,
  lead_activity: true,
  applicant: true,
  deal: true,
  trade_in: true,
  deal_scenario: true,
  loan_application: true,
  stipulation: true,
  dealer_user: true,
  program: true,
});

/** Keystone's support reads every dealer's pipeline (no tenant predicate),
    the dealer profiles, its triage and the late-decision alerts. A declared
    table this does not name is denied, which is how the lender's
    underwriting, funding and servicing stay out of this App altogether. */
const keystoneRows = Object.freeze({
  dealer: true,
  intake_submission: true,
  decision_alert: true,
  lead: true,
  lead_activity: true,
  deal: true,
  deal_scenario: true,
  trade_in: true,
  loan_application: true,
  stipulation: true,
  vehicle: true,
  dealer_user: true,
  program: true,
});

/* The dealer's owner runs its own people: grants, changes and revokes
   memberships at its dealer, never its own. `operators` is empty on purpose:
   the point of delegation is that the dealer does it, not Keystone. */
const administration = {
  id: 'keystone-dealer-people',
  version: '1',
  maxMembershipLifetimeMs: 365 * DAY,
  operators: [],
  delegates: [
    {
      role: 'owner',
      operations: ['grantMembership', 'replaceMembership', 'revokeMembership'],
      roles: ['owner', 'sales_manager', 'finance_manager', 'salesperson', 'viewer'],
    },
  ],
} satisfies NonNullable<AppTenantPolicy['administration']>;

/* Invitations by email, with a one-time token the owner hands over. Whoever
   holds the token claims it, so an invitation never makes another owner. */
const invitations = {
  id: 'keystone-dealer-invitations',
  version: '1',
  maxMembershipLifetimeMs: 365 * DAY,
  maxRedemptionLifetimeMs: 7 * DAY,
  maxPendingPerTenant: 25,
  operators: [],
  delegates: [
    {
      role: 'owner',
      operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'],
      roles: ['sales_manager', 'finance_manager', 'salesperson', 'viewer'],
    },
  ],
} satisfies NonNullable<AppTenantPolicy['invitations']>;

/* Dealer support enters a dealer as its viewer: an audited, read-only look
   at that dealer's own screens, thirty minutes at most. Never as anyone who
   can change a deal. */
const support = {
  id: 'keystone-dealer-support',
  version: '1',
  grants: [{ platformRole: 'dealer_support', tenants: 'all' as const, dealerRoles: ['viewer'] }],
} satisfies NonNullable<AppTenantPolicy['support']>;

/* One extractor per registered command, naming every row a result draws on
   beyond its target. Every result here is identifiers, a reference, a figure
   or fixed words about its own target, so each attests `[]`. */
const none = () => [];
const resultReferences = {
  logContact: none,
  takeApplication: none,
  startDeal: none,
  markLeadLost: none,
  recordWalkIn: none,
  structureDeal: none,
  addTradeIn: none,
  selectScenario: none,
  submitToLender: none,
  markContracted: none,
  markStipulationReceived: none,
  withdrawApplication: none,
  flagLateDecision: none,
  startApplication: none,
  saveApplicant: none,
  saveVehicle: none,
  saveCoApplicant: none,
  submitApplication: none,
} satisfies NonNullable<AppTenantPolicy['resultReferences']>;

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: 'leads',
  storeId: 'keystone-dealers',
  ownership: {
    dealer_site: tenant,
    dealer_user: tenant,
    vehicle: tenant,
    vehicle_photo: tenant,
    lead: tenant,
    lead_activity: tenant,
    applicant: tenant,
    deal: tenant,
    trade_in: tenant,
    deal_scenario: tenant,
    loan_application: tenant,
    stipulation: tenant,
    program: { kind: 'global', access: 'read-only' },
    dealer: platform,
    lender_user: platform,
    dealer_visit: platform,
    underwriting_file: platform,
    underwriting_note: platform,
    decision_alert: platform,
    funding: platform,
    intake_submission: platform,
    customer: platform,
    loan: platform,
    installment: platform,
    payment: platform,
    autopay: platform,
    payoff_quote: platform,
    loan_document: platform,
    servicing_note: platform,
    prequalification: platform,
    saved_vehicle: platform,
  },
  resolveRows: () => dealerRows,
  resolveMembershipRows: () => dealerRows,
  resolvePlatformRows: () => keystoneRows,
  administration,
  invitations,
  support,
  intake: { address: 'intake_address' },
  resultReferences,
});
