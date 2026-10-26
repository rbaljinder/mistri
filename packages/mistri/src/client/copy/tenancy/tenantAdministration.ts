/** What tenantAdministration says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  administrationAccessCouldNotBeVerified: 'Administration access could not be verified. Refresh access and review the current information.',
  theChangeWasNot: 'The change was not applied. Refresh the authorized list and review a new change.',
  theChangeIsUnconfirmed: 'The change is unconfirmed. Keep this attempt and check its status before making another change.',
  administrationAccessCouldNotBeLoaded: 'Administration access could not be loaded. Retry when the connection is available.',
  theAuthorizedTenantList: 'The authorized tenant list could not be loaded. Check access and refresh.',
  theAuthorizedMembershipList: 'The authorized membership list could not be loaded. Refresh the tenant list before continuing.',
  theChangeIsUnconfirmedCheck: 'The change is unconfirmed. Check this attempt’s status; do not submit it again.',
  changeConfirmedTheReceipt: 'Change confirmed. The receipt describes the accepted change; the list below is refreshed separately.',
  accessRefreshedCheckTheRetained: 'Access refreshed. Check the retained attempt’s status.',
  accessRefreshedLoadTheAuthorized: 'Access refreshed. Load the authorized tenant list.',
  assistantUsageCouldNotBeLoaded: 'The assistant’s usage could not be loaded. Refresh access and try again.',
  decisionUsageCouldNotBeLoaded: 'The decisions’ usage could not be loaded. Refresh access and try again.',
  theImportCouldNotBeRead: 'What the import would change could not be read. Refresh the tenant list and try again.',
});
