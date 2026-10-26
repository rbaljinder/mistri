import { defineAppTenantPolicy } from '@mistriwork/mistri/policy';

const HOUR = 60 * 60 * 1000,
  DAY = 24 * HOUR;
const everyClinicTable = { patient: true, appointment: true, payment: true, service: true, visit_request: true, notice: true };

/* The operator who creates and suspends clinics in Manage tenants is a native account, named by id: a deployment
   writes its own. The fixture reads it from the environment, so a test can make the account first. */
const operator = process.env.CLINIC_OPERATOR_ID || 'no-operator-configured';

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: 'clinic',
  storeId: 'clinic-tenants',
  ownership: {
    clinic: { kind: 'platform' },
    triage: { kind: 'platform' },
    patient: { kind: 'tenant', column: 'clinic_id' },
    appointment: { kind: 'tenant', column: 'clinic_id' },
    payment: { kind: 'tenant', column: 'clinic_id' },
    service: { kind: 'tenant', column: 'clinic_id' },
    visit_request: { kind: 'tenant', column: 'clinic_id' },
    notice: { kind: 'tenant', column: 'clinic_id' },
  },
  resolveMembershipRows: () => everyClinicTable,
  resolveRows: () => everyClinicTable,
  resolvePlatformRows: () => ({ clinic: true, triage: true, ...everyClinicTable }),
  // What each command's result names: a payment it made, and nothing for the two that answer only a message.
  resultReferences: {
    recordPayment: (result) => [{ table: 'payment', key: { id: (result as { payment: string }).payment } }],
    postNotice: () => [],
    requestVisit: () => [],
  },
  administration: {
    id: 'clinic-administration',
    version: '1',
    maxMembershipLifetimeMs: 366 * DAY,
    operators: [
      { accountId: operator, tenants: ['north', 'south', 'east'], operations: ['createTenant', 'setTenantStatus'], roles: [] },
      {
        accountId: operator,
        tenants: ['north', 'south', 'east'],
        operations: ['grantMembership', 'revokeMembership'],
        roles: ['owner', 'reception'],
      },
    ],
    // A clinic's owner manages its reception staff and its sandboxes; never another clinic, never an owner.
    delegates: [
      { role: 'owner', operations: ['grantMembership', 'revokeMembership', 'cloneTenant', 'importTenant'], roles: ['reception'] },
    ],
  },
  invitations: {
    id: 'clinic-invitations',
    version: '1',
    maxMembershipLifetimeMs: 366 * DAY,
    maxRedemptionLifetimeMs: 7 * DAY,
    maxPendingPerTenant: 20,
    operators: [],
    delegates: [{ role: 'owner', operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'], roles: ['reception'] }],
  },
  support: { id: 'clinic-support', version: '1', grants: [{ platformRole: 'operator', tenants: 'all', dealerRoles: ['reception'] }] },
  intake: { address: 'intake_address' },
  public: { address: 'public_address' },
  resolvePublicRows: () => ({ service: { groups: [[{ column: 'published', op: '=', value: 1 }]] } }),
});
