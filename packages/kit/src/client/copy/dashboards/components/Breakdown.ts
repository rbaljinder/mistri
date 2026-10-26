/** What Breakdown says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  ms: '{ms} ms',
  thisBreakdownAsADashboard: 'This breakdown as a dashboard section, for an app’s sections list',
  sectionCopiedPasteItInto: 'Section copied. Paste it into a dashboard’s "sections".',
  copyThisIntoADashboards: 'Copy this into a dashboard’s "sections"',
  section: 'Section',
  copyAsAppSection: 'Copy as app section',
  exportedGroups: { one: 'Exported {count} group.', other: 'Exported {count} groups.' },
  thatLineNoLonger: 'That line no longer groups.',
  thisPageGroups: { one: 'this page ({count} group)', other: 'this page ({count} groups)' },
  allGroups: 'all groups ({capped})',
  downloadTheseGroups: 'Download these groups',
  export: 'Export',
  fetching: 'Fetching…',
  nothingToGroupNoRows: 'Nothing to group — no rows matched.',
  sort: 'Sort by {name}',
  openTheRowsThisGroup: 'Open the rows this group counts',
  previous: '← Previous',
  groups: { one: '{count} group', other: '{count} groups' },
  aMeasure: '{measure} — a measure',
  grouped: '{path} — grouped by',
  shownOfTotal: '{shown} of {total}',
});
