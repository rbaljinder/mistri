/** What Chart says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  notEnoughPointsToDraw: 'Not enough points to draw a line.',
  target: 'Target {goal}',
  nothingToDraw: 'Nothing to draw.',
  nothingToDivide: 'Nothing to divide.',
  inAll: '{whole} in all — {map}',
  nothingToStack: 'Nothing to stack.',
  others: 'others ({restCount})',
  targetLabel: 'Target',
  lineSummary: { one: '{count} point, from {from} to {to}; peak {peak}', other: '{count} points, from {from} to {to}; peak {peak}' },
  barsSummary: { one: '{count} bar; highest {highest}; {last} {value}', other: '{count} bars; highest {highest}; {last} {value}' },
  barsBySeries: '{count} bars by {series}',
  targetAfter: '; target {goal}',
  showSeries: 'Show',
  allSeries: 'All series',
  linesSummary: { one: '{count} line over {points} points: {names}', other: '{count} lines over {points} points: {names}' },
});
