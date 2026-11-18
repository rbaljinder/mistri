/** What the For review room says (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  title: 'For review',
  count: '{count} waiting',
  nothing: 'Nothing waits for review.',
  nothingDetail: 'What {ai} proposes, and what it wrote that no one has confirmed yet, is listed here.',
  loading: 'Loading what waits for review…',
  approve: 'Approve',
  approveAll: 'Approve all',
  dismiss: 'Dismiss',
  dismissAll: 'Dismiss all',
  change: 'Change…',
  confirm: 'Confirm',
  unconfirmed: 'Unconfirmed',
  unconfirmedDetail: 'Not yet confirmed by a person',
  wholeRecord: 'The whole record',
  byJob: 'job {job}',
  approved: 'Approved.',
  dismissed: 'Dismissed.',
  confirmed: 'Confirmed.',
  newRecord: 'New record',
});
