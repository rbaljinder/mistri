/** What a decision's suggestion says at a record's field (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  almostCertain: 'almost certain',
  veryLikely: 'very likely',
  likely: 'likely',
  possible: 'possible',
  suggestion: 'Suggested: {value}, {confidence}',
  accept: 'Accept',
  more: 'More about the suggestion {value}',
  change: 'Change…',
  dismiss: 'Dismiss',
  whyThis: 'Why this?',
  whyTitle: 'Why {value}?',
  asked: 'Asked',
  inputs: 'What it was given',
  notYours: 'not shown to you',
  answeredBy: 'Answered by',
  sure: 'How sure',
  when: 'When',
  close: 'Close',
  couldNotSettle: 'The suggestion could not be updated. Try again.',
  reading: 'Reading…',
});
