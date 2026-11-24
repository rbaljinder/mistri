/**
 * On-demand calendar grid for `DateField`, split out of the initial client bundle and warmed on focus or hover so the
 * popover mounts with its day cells synchronously ready for initial focus.
 */
import { useLayoutEffect, useMemo, type RefObject } from 'react';
import {
  Calendar,
  CalendarDay,
  CalendarGrid,
  CalendarHeading,
  CalendarNext,
  CalendarPrevious,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
  createCalendarController,
} from '@ui-sdk/react/calendar';
import { changeDetails, type ChangeDetails } from '../changeDetails.js';
import { FIRST_DATE, isPickerDate, LAST_DATE } from './datePickerModel.js';
import { told } from './told.js';

function Caret({ to }: { to: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={to === 'left' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface DateFieldCalendarProps {
  datePart: string;
  seeded: string;
  bounds: { min: string; max: string };
  locale?: string;
  timezone?: string;
  today: string;
  firstDay: number;
  previousMonth: string;
  nextMonth: string;
  popupRef: RefObject<HTMLDivElement | null>;
  onChoose: (date: string, details: ChangeDetails<'day-press'>) => void;
}

export function DateFieldCalendar({
  datePart,
  seeded,
  bounds,
  locale,
  timezone,
  today,
  firstDay,
  previousMonth,
  nextMonth,
  popupRef,
  onChoose,
}: DateFieldCalendarProps) {
  const month = useMemo(() => createCalendarController(), []);

  useLayoutEffect(() => {
    if (month.getMonth() !== seeded.slice(0, 7)) month.setMonth(seeded.slice(0, 7));
    if (popupRef.current?.querySelector('[data-slot="calendar-day"]:focus')) month.focus(seeded);
  }, [seeded, bounds.min, bounds.max]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Calendar
      controller={month}
      value={isPickerDate(datePart) ? datePart : null}
      defaultMonth={seeded.slice(0, 7)}
      min={bounds.min === FIRST_DATE ? undefined : bounds.min}
      max={bounds.max === LAST_DATE ? undefined : bounds.max}
      locale={locale}
      timeZone={timezone}
      today={today}
      weekStartsOn={firstDay}
      onValueChange={(next, details) => {
        if (typeof next === 'string') onChoose(next, told('day-press', details));
      }}
    >
      <CalendarPrevious aria-label={previousMonth}>
        <Caret to="left" />
      </CalendarPrevious>
      <CalendarHeading />
      <CalendarNext aria-label={nextMonth}>
        <Caret to="right" />
      </CalendarNext>
      <CalendarGrid>
        <CalendarWeekdays>{(index) => <CalendarWeekday index={index} />}</CalendarWeekdays>
        <CalendarWeeks>
          {(cell) =>
            cell.date === datePart ? (
              /* The day already chosen is no change to UI SDK's calendar, and is still an answer here: the
                 reader opened the calendar, saw the day was right, and said so. */
              <CalendarDay
                value={cell.date}
                onClick={(event) => onChoose(cell.date, changeDetails('day-press', event))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onChoose(cell.date, changeDetails('day-press', event));
                }}
              />
            ) : (
              <CalendarDay value={cell.date} />
            )
          }
        </CalendarWeeks>
      </CalendarGrid>
    </Calendar>
  );
}
