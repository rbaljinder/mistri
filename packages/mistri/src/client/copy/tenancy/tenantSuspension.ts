/** What tenantSuspension says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  checkAgain: 'Check again',
  tenantAccessPaused: 'Tenant access paused',
  yourDraftsAreKept:
    'Your drafts are kept in this tab. Verify access to continue. Any unconfirmed changes still need their result checked.',
  youAreOfflineReconnect: 'You are offline. Reconnect, then check again.',
  verifyingTenantAccess: 'Verifying tenant access…',
  accessCouldNotBeConfirmed: 'Access could not be confirmed. We will retry shortly, or you can check again.',
});
