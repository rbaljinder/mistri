/** What PageHistory says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  anAgent: 'An agent',
  aPublicForm: 'A public form',
  theWorkbench: 'The Workbench',
  theApi: 'The API',
  theSystem: 'The system',
  someone: 'Someone',
  created: 'Created',
  edited: 'Edited',
  changesToThisRecord: 'Changes to this record appear here.',
  /* The feed is this record's own edits. Beside a list of its payments or notes, "No changes recorded yet" read as
     if nothing had happened to it: the words say what the card holds and where the rest is. */
  noChangesRecordedYet: 'No edits since this record was added.',
  eachChangeToThisRecord: 'An edit to this record is listed here with who made it. What was added about it is in its own lists.',
  showEarlierChanges: 'Show earlier changes',
  changed: 'changed',
  to: 'to',
  keptShortenedInTheHistory: 'Kept shortened in the history',
  shortened: '(shortened)',
});
