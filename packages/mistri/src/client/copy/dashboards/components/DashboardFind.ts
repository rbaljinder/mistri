/** What DashboardFind says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  searchPlaceholder: 'Search…',
  nothingMatches: 'Nothing matches “{term}”.',
  results: { one: '{count} result', other: '{count} results' },
});
