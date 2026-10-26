/** What filterRailModel says, in the filter rail room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisWeek: 'This week',
  last7Days: 'Last 7 days',
  last30Days: 'Last 30 days',
  overdue: 'Overdue',
  next7Days: 'Next 7 days',
  noDate: 'No date',
  starts: 'Starts with',
  matchesAPattern: 'Matches a pattern',
  isEmpty: 'Is empty',
  isNotEmpty: 'Is not empty',
});
