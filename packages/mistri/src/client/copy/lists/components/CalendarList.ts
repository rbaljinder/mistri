/** What CalendarList says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  movedTitleToAt: 'Moved “{title}” to {at}',
  dragToAnotherDay: 'Drag to another day, or press Alt and an arrow key',
  loadingTheMonth: 'Loading the month…',
  more: '{hidden} more on {day}',
  moreHidden: '+{count} more',
  calendar: 'Calendar',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  nothingOnTheCalendar: 'Nothing on the calendar this month.',
  spanDays: '{label}, {days}',
  showingTheFirstThisMonth: 'Showing the first {max} this month; narrow the list to see the rest.',
});
