/** What DateField says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  enterADateAndTime: 'Enter a date and time as YYYY-MM-DD HH:MM within the allowed range.',
  enterADateInYyyy: 'Enter a date as {format} within the allowed range.',
  yyyyMmDdHh: 'YYYY-MM-DD HH:MM',
  dateAndTimeFormat: 'Date and time format: YYYY-MM-DD HH:MM.',
  dateFormatIs: 'Date format: {format}.',
  altAndDownArrow: 'Alt and Down arrow opens the calendar.',
  chooseDateFor: 'Choose date for {label}',
  chooseDate: 'Choose date',
  calendar: 'Calendar for {label}',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
});
