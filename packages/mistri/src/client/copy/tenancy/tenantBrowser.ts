/** What tenantBrowser says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  platform: 'Platform',
  tenantRenewalIsUnavailable: 'Tenant renewal is unavailable.',
  /* What the App calls a tenant (`auth.tenancy.label`), lower case; "tenant" where it names none (tenancyNoun.ts). */
  tenant: 'tenant',
  enterTenant: 'Enter {name}',
  supportVisits: 'Support visits',
  supportSessions: 'Support sessions',
  tenantAccessCouldNotBeChecked: 'Tenant access could not be checked. Try again or contact your administrator.',
  theSelectionWasNotConfirmed: 'The selection was not confirmed. Check access before choosing again.',
  chooseATenantBeforeMounting: 'Choose a tenant before mounting its control.',
  tenantAccessCouldNotBe: 'Tenant access could not be checked. Try again.',
  thePreviousContextIsInactive: 'The previous context is inactive. Reload to verify access and choose a tenant.',
  theTenantSelectionIsStill: 'The tenant selection is still unconfirmed. Check again; no previous data has been restored.',
  theTenantSwitchWasNotConfirmed: 'The tenant switch was not confirmed. Check again to recover the server’s selection.',
});
