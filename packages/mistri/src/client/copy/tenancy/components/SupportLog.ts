/** What SupportLog says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  timedOut: 'timed out',
  accessRevoked: 'access revoked',
  tenantClosed: 'tenant closed',
  replacedByANewer: 'replaced by a newer session',
  n1MoreColumnWas: '1 more column was changed',
  moreColumnsWereChanged: '{withheldCount} more columns were changed',
  thatYourAccessDoes: 'that your access does not cover.',
  dotAs: ' · as',
  hereNow: 'here now',
  reasonColon: 'Reason:',
  n1Read: '1 read',
  n1Change: '1 change',
  theSupportLogCould: 'The support log could not be read. Check your access and try again.',
  supportVisits: 'Support visits',
  closeSupportVisits: 'Close support visits',
  everyTimeSupportEntered:
    'Every time support entered this tenant: who came in, when, why, and what they read or changed. Access is arranged by your agreement; this is the record of it being used.',
  loadingSupportVisits: 'Loading support visits…',
  noOneHasEntered: 'No one has entered this tenant under support.',
  theNewestVisitsOlder: 'The newest {sessionsCount} visits. Older visits are kept in the audit record.',
  reads: '{reads} reads',
  changes: '{changesCount} changes',
});
