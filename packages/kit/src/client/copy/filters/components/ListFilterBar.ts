/** What ListFilterBar says, in the filter rail room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  moreFilters: 'More filters: {map}',
  search: 'Search {listLabel}…',
  labelEquals: '{label} equals…',
  takesANumber: '{label} takes a number.',
  matchesAnywhereInTheAny: 'Matches anywhere in the {label}, any case. Start with = for an exact match.',
  showN: 'Show {n}',
  match: '{n} match',
});
