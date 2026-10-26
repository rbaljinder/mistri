/** What DashboardActivity says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  new: 'New {noun}',
  to: 'to',
  noChangesMatch: 'No changes {said} match “{search}”.',
  noChanges: 'No changes {said}.',
  showFewer: 'Show fewer',
  showMore: 'Show {entriesCount} more',
  period: 'Period of {title}',
  theActivity: 'the activity',
  searchActivity: 'Search activity',
  edited: '{headingOf} edited',
  fieldsChanged: { one: '{count} field changed', other: '{count} fields changed' },
  changeNoun: 'change',
  changesNoun: 'changes',
});
