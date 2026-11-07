/** What DashboardWindow says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  timeWindow: 'Time window',
  allTimeWindow: 'All time',
  defaultWindow: 'Default',
  windowRange: '{from} – {to}',
  pickWindow: 'Time window: {window}',
});
