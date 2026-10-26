/**
 * The themed calendar field (@mistriwork/ui's DateField), saying the catalog's
 * words and drawing the kit's calendar icon.
 */
import { DateField as Field, type DateFieldProps, type DateFieldWords } from '@mistriwork/ui/DateField.js';
import { Icon } from './Icon.js';
import { say } from '../copy/forms/components/DateField.js';

/* Read when a field draws, so a catalog worn later is the one said. */
const words = (): DateFieldWords => ({
  dateTimePattern: say('yyyyMmDdHh'),
  enterDateAndTime: say('enterADateAndTime'),
  enterDate: (format) => say('enterADateInYyyy', { format }),
  dateAndTimeFormat: say('dateAndTimeFormat'),
  dateFormat: (format) => say('dateFormatIs', { format }),
  openWithKeys: say('altAndDownArrow'),
  chooseDate: (label) => (label ? say('chooseDateFor', { label }) : say('chooseDate')),
  calendar: (label) => (label ? say('calendar', { label }) : say('chooseDate')),
  previousMonth: say('previousMonth'),
  nextMonth: say('nextMonth'),
  clear: say('common.clear'),
  today: say('common.today'),
});

/** A date field, or a date and a wall-clock time. No input is parsed as an instant or shifted by a timezone. */
export function DateField(props: Omit<DateFieldProps, 'words' | 'calendarIcon'>) {
  return <Field {...props} words={words()} calendarIcon={<Icon name="calendar-blank" size={18} />} />;
}
