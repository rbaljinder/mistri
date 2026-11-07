/** How a command ended, in words: the outcome model's titles, bodies and next steps, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  done: 'Done',
  sending: 'Sending…',
  checking: 'Checking the result…',
  queued: 'Queued',
  approval: 'Awaiting approval',
  refused: 'Not done',
  unknown: 'Result not confirmed',
  doneBody: 'The change is saved.',
  queuedBody: 'It is in line and runs shortly. Nothing more is needed from you.',
  approvalBody: 'It goes ahead once someone who may approve it does.',
  unknownBody: 'The answer did not arrive, so it may or may not have gone through.',
  unknownNext: 'Check again before sending it a second time: a check reads what was kept and never sends twice.',
  untrackedNext: 'This action keeps no receipt to check by. Look at the record before you try again.',
  nextField: 'Change {field} and send again.',
  nextInput: 'Correct the answers and send again.',
  nextStale: 'Refresh and review what changed, then send again.',
  nextIneligible: 'It is no longer in a state this applies to. Refresh to see where it stands.',
  nextForbidden: 'Your role may not do this. Ask someone who may.',
  nextNotFound: 'It is no longer there. Refresh to see what is.',
  nextWait: 'Wait a moment and send again.',
  nextDuplicate: 'One like it already exists. Find that one instead of making another.',
  nextDefault: 'Nothing was changed. Review and send again.',
});
