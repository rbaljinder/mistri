import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { Days, DaysDay } from './behaviors/Days';
import { addMonths, dayAt, inMonth, localToday, monthOf } from './behaviors/days';
import { Button } from './Button';
import { words } from './words';

/* A day chosen from a month laid open: for a choice the reader makes by looking at the days, where each can say
   something of itself (how many visits are free, what a night costs) and some cannot be had. It is the Days
   behavior with a look, the same one a month calendar is built on, so the keyboard is the calendar's: arrows by
   day and week, Home and End, Page Up and Down, Enter to choose. A date typed or picked from a field is
   `DateField`. */

export type DayPickerProps = {
  /* What the day is for: `A day to visit`. */
  label: string;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (day: string) => void;
  defaultMonth?: string;
  today?: string;
  min?: string;
  max?: string;
  /* A day that cannot be chosen. */
  unavailable?: (day: string) => boolean;
  /* A line under a day's number: `3 free`. */
  note?: (day: string) => ReactNode;
  weekStart?: 0 | 1;
};

const say = (day: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(dayAt(day));

export function DayPicker({
  label,
  value: given,
  defaultValue = null,
  onValueChange,
  defaultMonth,
  today = localToday(),
  min,
  max,
  unavailable,
  note,
  weekStart = 1,
}: DayPickerProps) {
  const [own, setOwn] = useState(defaultValue);
  const value = given === undefined ? own : given;
  const [month, setMonth] = useState(defaultMonth ?? monthOf(value ?? today));
  const [cursor, setCursor] = useState(value ?? (monthOf(today) === month ? today : `${month}-01`));
  const turn = (by: number) => {
    const next = addMonths(month, by);
    setMonth(next);
    // The keyboard's day goes with the month, so the grid keeps a stop in the Tab order.
    setCursor(inMonth(cursor, next));
  };
  const choose = (day: string) => {
    if (given === undefined) setOwn(day);
    onValueChange?.(day);
  };
  const title = say(`${month}-01`, { month: 'long', year: 'numeric' });
  return (
    <div data-slot="day-picker">
      <header data-slot="day-picker-head">
        <h3 aria-live="polite">{title}</h3>
        <div>
          <Button
            size="sm"
            intent="quiet"
            aria-label={words.previousMonth}
            disabled={Boolean(min && monthOf(min) >= month)}
            onClick={() => turn(-1)}
          >
            <CaretLeft aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            intent="quiet"
            aria-label={words.nextMonth}
            disabled={Boolean(max && monthOf(max) <= month)}
            onClick={() => turn(1)}
          >
            <CaretRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <Days
        role="grid"
        aria-label={`${label}, ${title}`}
        value={cursor}
        month={month}
        weekStart={weekStart}
        today={today}
        min={min}
        max={max}
        unavailable={unavailable}
        press
        onValueChange={(day) => setCursor(day)}
        onMonthChange={(next) => setMonth(next)}
        onPick={(day) => choose(day)}
      >
        {({ weeks }) => (
          <>
            <div role="row" data-slot="day-picker-weekdays">
              {(weeks[0] ?? []).map((day) => (
                <span key={day} role="columnheader" aria-label={say(day, { weekday: 'long' })}>
                  {say(day, { weekday: 'narrow' })}
                </span>
              ))}
            </div>
            {weeks.map((week) => (
              <div role="row" key={week[0]} data-slot="day-picker-week">
                {week.map((day) => {
                  const open = !(min && day < min) && !(max && day > max) && !unavailable?.(day);
                  return (
                    <DaysDay
                      key={day}
                      value={day}
                      aria-selected={day === value}
                      data-picked={day === value ? '' : undefined}
                      data-taken={open ? undefined : ''}
                    >
                      {/* The day in full, for a reader who does not see the grid; its number and its note are the
                          same thing said short. */}
                      <span data-kind="visually-hidden" data-slot="day-picker-said">
                        {[
                          say(day, { weekday: 'long', month: 'long', day: 'numeric' }),
                          day === value ? words.dayChosen : open ? '' : words.dayTaken,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                      <b aria-hidden="true">{Number(day.slice(8))}</b>
                      {note && open && <small>{note(day)}</small>}
                    </DaysDay>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </Days>
    </div>
  );
}
