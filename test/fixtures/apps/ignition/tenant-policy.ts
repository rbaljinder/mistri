/**
 * Ignition's server-only tenant policy: the dealers are tenants, the lender is
 * the platform above them. Loaded with `--policy`, never imported by the App
 * graph — it is trusted server code, and nothing in it is serializable.
 *
 * What it declares, and why each part has to be here rather than in app.ts:
 *
 * - **Ownership** for every logical resource, agreeing exactly with the
 *   `owner` each resource block states. The DSL says the word; this says the
 *   column, which is deployment truth and not something a browser payload
 *   should ever carry.
 * - **The row scopes.** A dealer's context reads its own rows — the runtime
 *   composes the tenant predicate outside anything named here, so these
 *   callbacks widen nothing — and the platform's reads across every dealer,
 *   plus the applicants database by qualified name.
 * - **Administration and invitations**, with `delegates`, so a dealer admin
 *   runs its own dealership's people without the lender doing it for them.
 * - **Intake**, naming the profile column that places a public submission.
 * - **Support**, which platform roles may enter which dealer, as whom.
 * - **resultReferences**, one trusted extractor per signed-in command.
 */
import { defineAppTenantPolicy, type AppTenantPolicy } from '@mistriwork/mistri/policy';

const DAY = 24 * 60 * 60 * 1000;

/** Every table a dealer's own context reads: its five owned tables and the
 * shared model catalogue. The platform's tables are absent, and two
 * independent layers keep them so — the read scope holds them false before
 * this runs, and they are left out of a tenant's visible resources. */
const dealerRows = Object.freeze({
  lead: true,
  lead_co_applicant: true,
  loan_application: true,
  application_document: true,
  vehicle: true,
  vehicle_model: true,
});

/** Every table the lender's context reads: its own, every dealer's (with no
 * tenant predicate), the model catalogue, and the applicants database by
 * qualified name. A declared table this does not name is denied, global or
 * not, which is why `vehicle_model` is named here too. */
const lenderRows = Object.freeze({
  dealer: true,
  review_desk: true,
  lender_staff: true,
  review_file: true,
  application_review: true,
  loan_decision: true,
  assignment_history: true,
  review_alert: true,
  intake_submission: true,
  intake_co_applicant: true,
  lead: true,
  lead_co_applicant: true,
  loan_application: true,
  application_document: true,
  vehicle: true,
  vehicle_model: true,
  'applicants.applicant': true,
  'applicants.residence': true,
  'applicants.contact': true,
  'applicants.employment': true,
});

/* A dealer admin administers its own dealership, within the ceiling below and
   never on its own membership — read from the tenant store inside the same
   transaction as the change, so an admin demoted at that moment either waits
   for the change or refuses it. `operators` is empty on purpose: this sample
   has no lender operator managing dealer people by account id, because the
   whole point of delegation is that the dealer does it. */
const administration = {
  id: 'ignition-dealer-management',
  version: '1',
  maxMembershipLifetimeMs: 180 * DAY,
  operators: [],
  delegates: [
    {
      role: 'dealer_admin',
      operations: ['grantMembership', 'replaceMembership', 'revokeMembership'],
      roles: ['dealer_admin', 'dealer_staff', 'dealer_viewer'],
    },
  ],
} satisfies NonNullable<AppTenantPolicy['administration']>;

/* The same delegation for invitations, so a dealer admin invites a colleague
   by email and hands over the one-time token. The invited address is not
   verified: whoever holds the token claims it, which is why the ceiling here
   is narrower than administration's — an invitation never makes another admin. */
const invitations = {
  id: 'ignition-dealer-invitations',
  version: '1',
  maxMembershipLifetimeMs: 180 * DAY,
  maxRedemptionLifetimeMs: 7 * DAY,
  maxPendingPerTenant: 25,
  operators: [],
  delegates: [
    {
      role: 'dealer_admin',
      operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'],
      roles: ['dealer_staff', 'dealer_viewer'],
    },
  ],
} satisfies NonNullable<AppTenantPolicy['invitations']>;

/* Who may enter a dealer, and as whom. A grant is matched whole and roles are
   never unioned: a reviewer looks at one dealership as its own viewer, and
   nothing more. The timing — a sign-in under five minutes old, thirty minutes
   at most, never renewed — is fixed in code, not here.

   `platform_admin` is deliberately absent: the lender's administrator manages
   the platform, and reading a dealer's own screens is the desk's work. Support
   is the audited exception, so the fewer roles hold it the better. */
const support = {
  id: 'ignition-lender-support',
  version: '1',
  grants: [
    { platformRole: 'reviewer', tenants: 'all' as const, dealerRoles: ['dealer_viewer'] },
    { platformRole: 'manager', tenants: 'all' as const, dealerRoles: ['dealer_viewer', 'dealer_staff'] },
  ],
} satisfies NonNullable<AppTenantPolicy['support']>;

/**
 * One trusted synchronous extractor per registered command, naming every
 * non-target row the result depends on. The map must match the commands
 * registry exactly — every id in it, and no id that is not — so the public
 * form's commands are here too: each is registered, so each needs an entry,
 * and `[]` is the attestation that a public result names no record.
 *
 * Each of these returns `[]` because every Ignition command's result is its
 * target's own identifiers and fixed words — an id, a revision, a sentence —
 * and never another row's content. Returning `[]` attests exactly that.
 */
const resultReferences = {
  qualifyLead: () => [],
  disqualifyLead: () => [],
  convertLead: () => [],
  withdrawApplication: () => [],
  assignReviewer: () => [],
  recordReview: () => [],
  recordDecision: () => [],
  reviseApplication: () => [],
  flagOverdueReview: () => [],
  rotateIntakeAddress: () => [],
  closeIntakeSubmission: () => [],
  // Public, and registered, so each is named here like any other: the form's
  // five steps and its submit.
  startFinancing: () => [],
  saveFinancingAddress: () => [],
  saveFinancingIncome: () => [],
  saveFinancingLoan: () => [],
  saveFinancingCoApplicants: () => [],
  applyForFinancing: () => [],
} satisfies NonNullable<AppTenantPolicy['resultReferences']>;

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: 'ignition',
  storeId: 'ignition-tenants',
  ownership: {
    // The dealer's own rows, by the ownership column the runtime injects.
    lead: { kind: 'tenant', column: 'tenant_id' },
    lead_co_applicant: { kind: 'tenant', column: 'tenant_id' },
    loan_application: { kind: 'tenant', column: 'tenant_id' },
    application_document: { kind: 'tenant', column: 'tenant_id' },
    vehicle: { kind: 'tenant', column: 'tenant_id' },
    // Shared reference data every dealer reads and none owns.
    vehicle_model: { kind: 'global', access: 'read-only' },
    // The lender's own. `dealer` is the tenancy profile, one row per dealer,
    // and the one platform table a dealer's row may point at — through its
    // ownership column and nothing else.
    dealer: { kind: 'platform' },
    review_desk: { kind: 'platform' },
    lender_staff: { kind: 'platform' },
    review_file: { kind: 'platform' },
    application_review: { kind: 'platform' },
    loan_decision: { kind: 'platform' },
    assignment_history: { kind: 'platform' },
    review_alert: { kind: 'platform' },
    intake_submission: { kind: 'platform' },
    intake_co_applicant: { kind: 'platform' },
  },
  resolveRows: () => dealerRows,
  resolveMembershipRows: () => dealerRows,
  resolvePlatformRows: () => lenderRows,
  administration,
  invitations,
  support,
  intake: { address: 'intake_address' },
  resultReferences,
});
