/** What PageMetrics says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisMetricHasNoView: 'This metric has no view definition.',
  thisRecordHasNoToCount: 'This record has no {of} to count through.',
  thisMetricCouldNotBeRead: 'This metric could not be read.',
  openTheThisCounted: 'Open the {from} this counted',
  thisCountCannotBeReopened: '{from} — this count cannot be reopened as a query',
  thisSectionHasNo: 'This section has no breakdown definition.',
  noIsSetSo: 'No {reference} is set, so there is nothing to count.',
  theseGroupsCouldNotBeRead: 'These groups could not be read.',
  nothingToCountYet: 'Nothing to count yet.',
  noForThisRecord: 'No {from} for this record.',
  openWhere: 'Open {from} where {by} = {row}',
  andSmallerGroups: { one: 'and {count} smaller group', other: 'and {count} smaller groups' },
  thisChartHasNoBreakdown: 'This chart has no breakdown definition.',
  noIsSetSoThere: 'No {reference} is set, so there is nothing to draw.',
  thisChartCouldNotBeRead: 'This chart could not be read.',
  nothingToDrawYet: 'Nothing to draw yet.',
});
