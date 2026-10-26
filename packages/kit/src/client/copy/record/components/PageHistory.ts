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
  noChangesRecordedYet: 'No changes recorded yet.',
  eachChangeToThisRecord: 'Each change to this record from now on is listed here, with who made it.',
  showEarlierChanges: 'Show earlier changes',
  changed: 'changed',
  to: 'to',
  keptShortenedInTheHistory: 'Kept shortened in the history',
  shortened: '(shortened)',
});
