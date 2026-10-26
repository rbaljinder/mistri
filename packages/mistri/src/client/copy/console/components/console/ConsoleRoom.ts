/** The Feature flags room: its head, scope choice and list (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  title: 'Feature flags',
  signIn: 'Sign in to open Console.',
  loadingApps: 'Loading Apps…',
  noTargets: 'No authorized targets.',
  environment: 'Environment',
  scope: 'Scope',
  chooseScope: 'Choose a scope',
  scopeHint: 'Each scope keeps its own controls. Choose where to inspect and manage this App’s flags.',
  loadingFlags: 'Loading flags…',
  searchFlags: 'Search flags',
  searchPlaceholder: 'Search flags',
  noneFiltered: 'No flag matches these filters.',
  flagCount: '{shown} of {total}',
  clearSearch: 'Clear search',
  noFlags: 'No flags available in this scope.',
  noMatches: 'No flags match your search.',
  flags: 'Flags',
  flagDetails: 'Flag details',
});
