/** What appChrome says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  tenantAccessEnded: 'Tenant access ended',
  businessDataHasBeen:
    'Business data has been closed. You can finish account administration, then reload to verify access and choose a tenant.',
  reloadAndChooseATenant: 'Reload and choose a tenant',
  tenantApplicationIdentityIsInvalid: 'Tenant application identity is invalid.',
});
