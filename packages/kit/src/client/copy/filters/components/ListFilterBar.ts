/** What ListFilterBar says, in the filter rail room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  // Starts with the button's visible word (WCAG 2.5.3, label in name): {filter} is the word it shows.
  moreFilters: '{filter}: {map}',
  search: 'Search {listLabel}…',
  labelEquals: '{label} equals…',
  takesANumber: '{label} takes a number.',
  matchesAnywhereInTheAny: 'Matches anywhere in the {label}, any case. Start with = for an exact match.',
  showN: 'Show {n}',
  match: '{n} match',
});
