/** What SupportSessions says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  supportSessions: 'Support sessions',
  closeSupportSessions: 'Close support sessions',
  everySession:
    'Every support session into every tenant: who entered, which tenant, when, why, and what they read or changed. Each tenant sees its own visits without the operator’s email.',
  loading: 'Loading support sessions…',
  failed: 'The support sessions could not be read. Check your access and try again.',
  none: 'No one has entered a tenant under support.',
  into: 'Into {tenant}',
  newest: 'The newest {count} sessions. Older ones are kept in the audit record.',
});
