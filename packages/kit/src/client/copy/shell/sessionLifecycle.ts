/** What sessionLifecycle says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  sessionCheckInterrupted: 'Session check interrupted.',
  sessionVerificationIsUnavailable: 'Session verification is unavailable.',
  tenantContextVerificationIsUnavailable: 'Tenant context verification is unavailable.',
});
