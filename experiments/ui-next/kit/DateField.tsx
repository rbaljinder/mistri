import { CalendarBlank, CaretLeft, CaretRight } from '@phosphor-icons/react';
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
} from '@ui-sdk/react/calendar';
import { Button } from '@ui-sdk/react/button';
import { Input } from '@ui-sdk/react/input';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { useState } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import { told } from './told';

const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/;

/* How a locale writes a numeric date: the order of its parts and its separator ("MM/DD/YYYY" in en-US). */
function dateMask(locale: string | undefined): { order: string[]; sep: string; hint: string } {
  let parts: Intl.DateTimeFormatPart[] = [];
  try {
    parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
      calendar: 'gregory',
    }).formatToParts(Date.UTC(2006, 10, 22));
  } catch {
    // An unknown locale reads as none: ISO order.
  }
  const order = parts.filter((part) => ['year', 'month', 'day'].includes(part.type)).map((part) => part.type);
  if (order.length !== 3) return { order: ['year', 'month', 'day'], sep: '-', hint: 'YYYY-MM-DD' };
  const sep = parts.find((part) => part.type === 'literal')?.value.trim() || '/';
  const word: Record<string, string> = { year: 'YYYY', month: 'MM', day: 'DD' };
  return { order, sep, hint: order.map((type) => word[type]).join(sep) };
}

/* An ISO day as the locale writes it in a box. */
function localeText(iso: string, mask: { order: string[]; sep: string }): string {
  const [year, month, day] = iso.split('-');
  const of: Record<string, string | undefined> = { year, month, day };
  return mask.order.map((type) => of[type]).join(mask.sep);
}

const real = (iso: string): boolean => {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
};

/* What was typed, read as a whole day in the locale's order (or ISO), else undefined: a draft stays text. */
function readDate(text: string, mask: { order: string[] }): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return real(text) ? text : undefined;
  const numbers = text.trim().match(/^(\d{1,4})\D(\d{1,2})\D(\d{1,4})$/);
  if (!numbers) return undefined;
  const at: Record<string, string> = {};
  mask.order.forEach((type, index) => (at[type] = numbers[index + 1]!));
  if (at.year!.length !== 4) return undefined;
  const iso = `${at.year}-${at.month!.padStart(2, '0')}-${at.day!.padStart(2, '0')}`;
  return real(iso) ? iso : undefined;
}

/* Editable text beside a calendar. The text is the value: a whole day is kept as ISO and shown as the locale
   writes it, a typed draft survives as it was typed, the calendar only ever writes the date part and keeps a time
   already typed, and nothing here converts a value through an instant. With `withTime` the box says the value as
   it is (`YYYY-MM-DD HH:MM`). What mistri's own field does that this does not yet: bound a date and its time
   together, and say the format as a hint to a screen reader. */
export const DateField: UiKitSlots['DateField'] = (props) => {
  const { words } = props;
  const [open, setOpen] = useState(false);
  const label = props['aria-label'];
  const [, day, time] = DAY.exec(props.value.trim()) ?? [];
  const pick = (next: string) => {
    props.onChange(props.withTime && next ? `${next} ${time ?? '00:00'}` : next, told('day-press', undefined));
    setOpen(false);
  };
  const mask = dateMask(props.locale);
  const shown = !props.withTime && day && !time ? localeText(day, mask) : props.value;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: props.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    props.now ?? new Date(),
  );
  return (
    <div data-slot="date-field" className={props.className}>
      <Input
        id={props.id}
        ref={props.inputRef}
        name={props.name}
        value={shown}
        placeholder={props.placeholder ?? (props.withTime ? words.dateTimePattern : mask.hint)}
        disabled={props.disabled}
        required={props.required}
        autoComplete="off"
        aria-label={label}
        aria-invalid={props['aria-invalid']}
        aria-describedby={props['aria-describedby']}
        onValueChange={(value, details) => {
          const typed = String(value);
          props.onChange(props.withTime ? typed : (readDate(typed, mask) ?? typed), told('input-change', details));
        }}
        onBlur={props.onBlur}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.altKey && event.key === 'ArrowDown' && !props.disabled) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          setOpen(next);
          props.onOpenChange?.(next, told('implicit', details));
        }}
      >
        <PopoverTrigger aria-label={words.chooseDate(label)} disabled={props.disabled} data-variant="quiet">
          {props.calendarIcon ?? <CalendarBlank aria-hidden="true" />}
        </PopoverTrigger>
        <PopoverContent ref={props.popupRef} aria-label={words.calendar(label)} data-kind="calendar" align="end" sideOffset={6}>
          <Calendar
            value={day ?? null}
            min={props.min?.slice(0, 10)}
            max={props.max?.slice(0, 10)}
            locale={props.locale}
            timeZone={props.timezone}
            today={today}
            weekStartsOn={props.firstDay}
            onValueChange={(next) => typeof next === 'string' && pick(next)}
          >
            <CalendarPrevious aria-label={words.previousMonth}>
              <CaretLeft aria-hidden="true" />
            </CalendarPrevious>
            <CalendarHeading />
            <CalendarNext aria-label={words.nextMonth}>
              <CaretRight aria-hidden="true" />
            </CalendarNext>
            <CalendarGrid>
              <CalendarWeekdays>{(index) => <CalendarWeekday index={index} />}</CalendarWeekdays>
              <CalendarWeeks>{(cell) => <CalendarDay value={cell.date} />}</CalendarWeeks>
            </CalendarGrid>
          </Calendar>
          <div data-slot="action-bar">
            <Button data-variant="quiet" data-size="sm" onClick={() => pick('')}>
              {words.clear}
            </Button>
            <Button data-variant="quiet" data-size="sm" onClick={() => pick(today)}>
              {words.today}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
