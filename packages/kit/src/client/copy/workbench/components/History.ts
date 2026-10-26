/** What History says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  justNow: 'just now',
  minutesAgo: '{minutes}m ago',
  hoursAgo: '{hours}h ago',
  daysAgo: '{days}d ago',
  nothingYetQueriesAppear: 'Nothing yet. Queries appear here once they run.',
  clearQueries: { one: 'Clear {count} query', other: 'Clear {count} queries' },
});
