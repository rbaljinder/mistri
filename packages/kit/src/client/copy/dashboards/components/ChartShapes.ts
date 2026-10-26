/** What ChartShapes says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  scatterSummary: { one: '{count} dot: {x} across, {y} up', other: '{count} dots: {x} across, {y} up' },
  heatSummary: '{rows} by {columns}; highest {highest} at {where}',
  low: 'Low',
  high: 'High',
  waterfallSummary: '{count} changes to a total of {total}',
  total: 'Total',
  treemapSummary: { one: '{count} group; largest {largest}', other: '{count} groups; largest {largest}' },
  others: 'Others',
});
