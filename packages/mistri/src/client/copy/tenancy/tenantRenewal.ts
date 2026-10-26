/** What tenantRenewal says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  chooseATenantBefore: 'Choose a tenant before renewing.',
  tenantRenewalInterrupted: 'Tenant renewal interrupted.',
  tenantRenewalIsUnavailable: 'Tenant renewal is unavailable.',
  tenantLeaseIsUnavailable: 'Tenant lease is unavailable.',
  tenantRenewalNeedsACurrent: 'Tenant renewal needs a current check.',
  theRecoveredLeaseHasExpired: 'The recovered lease has expired. Check again.',
});
