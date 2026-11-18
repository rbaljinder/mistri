/** What a record's AI line and unconfirmed marks say (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  proposals: { one: '{count} proposal: {labels}', other: '{count} proposals: {labels}' },
  review: 'Review',
  madeUnconfirmed: 'Made by {maker}, not yet confirmed',
  madeByJob: 'job {job}',
  confirm: 'Confirm',
  confirmField: 'Confirm {field}',
  unconfirmedField: '{field} was written by {maker} and not yet confirmed',
  confirmed: 'Confirmed.',
});
