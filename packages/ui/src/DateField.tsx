/**
 * The themed calendar field: editable ISO text beside a calendar popover,
 * for a date, or with `withTime` for a date and a wall-clock time. The text
 * is the value — typed drafts survive, the calendar only ever writes the
 * date part — and nothing here converts a value through an instant. The
 * arithmetic and the bounds are datePickerModel.ts's; the popover and the
 * month's grid, with its keys, are UI SDK's. Its words and the calendar
 * button's icon are props: the kit lends its catalog's and its icon.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AriaAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Button } from '@ui-sdk/react/button';
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
import { Input } from '@ui-sdk/react/input';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import {
  clampDate,
  dateBounds,
  dateFormat,
  dateParts,
  dateTimeWithinBounds,
  dateWithinBounds,
  FIRST_DATE,
  isPickerDate,
  isPickerDateTime,
  LAST_DATE,
  splitDateTime,
  todayInZone,
  withDate,
} from './internal/datePickerModel.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** What a date field says. A `format` is the locale's numeric date pattern ("MM/DD/YYYY"). */
export interface DateFieldWords {
  /** How a wall-clock time is written in the box ("HH:MM"). A date and a time are typed as the locale's date, then this:
      the one format the box shows, the placeholder says and the hint reads. */
  timePattern: string;
  /** The box's complaint at a date and time it cannot take, given the format it takes. */
  enterDateAndTime: (format: string) => string;
  /** The box's complaint at a date it cannot take. */
  enterDate: (format: string) => string;
  /** The hint read with the box: its format, for a date and a time. */
  dateAndTimeFormat: (format: string) => string;
  /** The hint read with the box: its format, for a date. */
  dateFormat: (format: string) => string;
  /** The hint's second sentence: the key that opens the calendar. */
  openWithKeys: string;
  /** The calendar button's name, with the field's label when it has one. */
  chooseDate: (label?: string) => string;
  /** The calendar's name, with the field's label when it has one. */
  calendar: (label?: string) => string;
  previousMonth: string;
  nextMonth: string;
  clear: string;
  today: string;
  /** The clock's name beside a date and a time, with the field's label when it has one. Absent, no clock is drawn. */
  time?: (label?: string) => string;
}

/** How a locale writes a numeric date: the order of its parts and its separator ("MM/DD/YYYY" in en-US). */
function dateMask(locale: string | undefined): { order: string[]; sep: string; hint: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = dateFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC', calendar: 'gregory' }).formatToParts(
      Date.UTC(2006, 10, 22),
    );
  } catch {
    parts = [];
  }
  const order = parts.filter((part) => ['year', 'month', 'day'].includes(part.type)).map((part) => part.type);
  if (order.length !== 3) return { order: ['year', 'month', 'day'], sep: '-', hint: 'YYYY-MM-DD' };
  const sep = parts.find((part) => part.type === 'literal')?.value.trim() || '/';
  const word: Record<string, string> = { year: 'YYYY', month: 'MM', day: 'DD' };
  return { order, sep, hint: order.map((type) => word[type]).join(sep) };
}

/** An ISO date as the locale writes it in a box. */
function localeText(iso: string, mask: { order: string[]; sep: string }): string {
  const { year, month, day } = dateParts(iso);
  const of: Record<string, string> = {
    year: String(year).padStart(4, '0'),
    month: String(month).padStart(2, '0'),
    day: String(day).padStart(2, '0'),
  };
  return mask.order.map((type) => of[type]).join(mask.sep);
}

const isoDate = (text: string): boolean => isPickerDate(text);

/** A date and a time as the box shows them: the locale's date, then the time as it is stored. */
function localeDateTime(iso: string, mask: { order: string[]; sep: string }): string {
  const parts = splitDateTime(iso);
  return parts ? `${localeText(parts.date, mask)} ${parts.time}` : iso;
}

/** What was typed as a date and a time, read in the locale's order (or ISO) as `YYYY-MM-DD HH:MM`, else undefined: a draft
    stays text. */
function readDateTime(text: string, mask: { order: string[] }): string | undefined {
  const typed = text.trim();
  if (isPickerDateTime(text)) return text;
  const split = typed.match(/^(\S+)[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  if (!split) return undefined;
  const date = readDate(split[1]!, mask);
  const time = /^\d:/.test(split[2]!) ? `0${split[2]}` : split[2]!;
  const iso = date && `${date} ${time}`;
  return iso && isPickerDateTime(iso) ? iso : undefined;
}

/** What was typed, read as a whole date in the locale's order (or ISO), else undefined: a draft stays text. */
function readDate(text: string, mask: { order: string[] }): string | undefined {
  if (isoDate(text)) return text;
  const numbers = text.trim().match(/^(\d{1,4})\D(\d{1,2})\D(\d{1,4})$/);
  if (!numbers) return undefined;
  const at: Record<string, string> = {};
  mask.order.forEach((type, index) => (at[type] = numbers[index + 1]!));
  if (at.year!.length !== 4) return undefined;
  const iso = `${at.year}-${at.month!.padStart(2, '0')}-${at.day!.padStart(2, '0')}`;
  return isPickerDate(iso) ? iso : undefined;
}

export interface DateFieldProps {
  id: string;
  words: DateFieldWords;
  /** Drawn in the calendar button. */
  calendarIcon: ReactNode;
  value: string;
  /** Typed text is preserved, including an incomplete date; callers validate on commit. `day-press` is a day (or Clear,
      or Today) chosen in the calendar. */
  onChange: (value: string, details: ChangeDetails<'input-change' | 'day-press'>) => void;
  /** Composite blur: never fired while focus moves between the input and calendar. */
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  locale?: string;
  timezone?: string;
  /** The moment the calendar's today is counted from: the App's clock where it runs as of another day; the real time when absent. */
  now?: Date;
  firstDay?: number;
  className?: string;
  name?: string;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  /** A date and a wall-clock time (`YYYY-MM-DD HH:MM`, as the box says it; the `T` a datetime-local control writes is read too): the calendar
      picks the date and keeps the time typed. `min` and `max` then bound the whole value. */
  withTime?: boolean;
  /** The calendar is drawn in a portal; an owner that watches focus (an autosaving field) is told where. */
  popupRef?: (node: HTMLDivElement | null) => void;
  /** A popover's words (`trigger-press`, `outside-press`, `escape-key` …), `day-press` when a choice closed it, `open-key` for Alt+ArrowDown, and `disabled` when the
      field was disabled or its bounds stopped agreeing while it was open. */
  onOpenChange?: (open: boolean, details: ChangeDetails<DateFieldOpenReason>) => void;
  'aria-label'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

export type DateFieldOpenReason =
  | 'trigger-hover'
  | 'trigger-focus'
  | 'trigger-press'
  | 'outside-press'
  | 'escape-key'
  | 'close-press'
  | 'focus-out'
  | 'imperative-action'
  | 'implicit'
  | 'day-press'
  | 'open-key'
  | 'disabled';

/* What UI SDK's popover says of an open or a close, in the words this field says them. */
const OPENS = new Set<string>(['trigger-hover', 'trigger-press', 'outside-press', 'escape-key', 'close-press', 'focus-out']);
const openReason = (said: string | undefined): DateFieldOpenReason =>
  said === 'imperative' ? 'imperative-action' : said && OPENS.has(said) ? (said as DateFieldOpenReason) : 'implicit';

/* The month's two arrows. */
function Caret({ to }: { to: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={to === 'left' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A date field, or a date and a wall-clock time. No input is parsed as an instant or shifted by a timezone. The box
    and the calendar are one field to whoever listens for its blur: `onBlur` is not said while the keyboard goes
    between them, and is said once when it leaves both. */
function DefaultDateField({
  id,
  words,
  calendarIcon,
  value,
  onChange,
  onBlur,
  onKeyDown,
  disabled,
  required,
  min,
  max,
  locale,
  timezone,
  now,
  firstDay = 1,
  className,
  name,
  inputRef,
  placeholder,
  withTime = false,
  popupRef,
  onOpenChange,
  'aria-label': label,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: DateFieldProps) {
  // The calendar only ever sees the date; a wall time's clock stays in the box.
  const datePart = withTime ? (splitDateTime(value)?.date ?? value.slice(0, 10)) : value;
  /* A range's two ends may for a moment be half typed or the wrong way round. The text stays editable, and the
     calendar is shut until they agree. */
  const configuredBounds = useMemo(() => {
    try {
      return dateBounds(withTime ? min?.slice(0, 10) : min, withTime ? max?.slice(0, 10) : max);
    } catch {
      return null;
    }
  }, [min, max, withTime]);
  const bounds = configuredBounds ?? dateBounds();
  const today = todayInZone(now ?? new Date(), timezone);
  const seed = () => clampDate(isPickerDate(datePart) ? datePart : today, bounds);
  const [open, setOpenState] = useState(false);
  const openCallback = useRef(onOpenChange);
  const blurCallback = useRef(onBlur);
  useLayoutEffect(() => {
    openCallback.current = onOpenChange;
    blurCallback.current = onBlur;
  });
  const setOpen = (next: boolean, details: ChangeDetails<DateFieldOpenReason>) => {
    setOpenState(next);
    openCallback.current?.(next, details);
  };
  const group = useRef<HTMLSpanElement>(null);
  /* A calendar opened inside a dialog is drawn inside it, so the dialog's focus trap and its stacking keep it as
     their own; elsewhere it goes where every popup here does (internal/popups.ts). */
  const container = useDialogContainer(group);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => input.current!, []);
  const popup = useRef<HTMLDivElement | null>(null);
  const setPopup = useCallback(
    (node: HTMLDivElement | null) => {
      popup.current = node;
      popupRef?.(node);
    },
    [popupRef],
  );
  const month = useMemo(() => createCalendarController(), []);
  const ownedFocus = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const hint = useId();
  /* A date alone is shown as the locale writes it and kept as ISO; what is being typed stays as typed until the
     field is left, so a half-typed date is never rewritten under the caret. A date with a time stays ISO text. */
  const mask = useMemo(() => dateMask(locale), [locale]);
  const [draft, setDraft] = useState<string | null>(null);
  const read = (text: string) => (withTime ? readDateTime(text, mask) : readDate(text, mask));
  const shown =
    draft ??
    (withTime ? (isPickerDateTime(value) ? localeDateTime(value, mask) : value) : isPickerDate(value) ? localeText(value, mask) : value);
  /* One format, the locale's, for the box, its placeholder and the hint a screen reader hears. */
  const pattern = withTime ? `${mask.hint} ${words.timePattern}` : mask.hint;
  useEffect(() => {
    if (draft !== null && value !== (read(draft) ?? draft)) setDraft(null);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad =
    !configuredBounds ||
    (value !== '' &&
      (withTime
        ? !isPickerDateTime(value) || !dateWithinBounds(datePart, bounds) || !dateTimeWithinBounds(value, min, max)
        : !dateWithinBounds(value, bounds)));
  useEffect(() => {
    input.current?.setCustomValidity(!bad ? '' : withTime ? words.enterDateAndTime(pattern) : words.enterDate(pattern));
  }, [bad, withTime, pattern]); // eslint-disable-line react-hooks/exhaustive-deps
  /* While the calendar is open and what bounds it moves under it, the month in view goes to where a day can still
     be chosen, and the keyboard goes with it where it was on a day. */
  useLayoutEffect(() => {
    if (!open) return;
    if (!configuredBounds || disabled) {
      setOpen(false, changeDetails('disabled'));
      return;
    }
    const next = seed();
    if (month.getMonth() !== next.slice(0, 7)) month.setMonth(next.slice(0, 7));
    if (popup.current?.querySelector('[data-slot="calendar-day"]:focus')) month.focus(next);
  }, [value, min, max, disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const within = (node: Node | null) => Boolean(node && (group.current?.contains(node) || popup.current?.contains(node)));
  const commitBlur = () => {
    if (!ownedFocus.current) return;
    ownedFocus.current = false;
    setDraft(null);
    blurCallback.current?.();
  };
  const checkBlur = () => {
    clearTimeout(blurTimer.current);
    // The focus a closing popup hands back lands a moment later; the field is left only if it is not there then.
    blurTimer.current = setTimeout(() => {
      if (!within(document.activeElement)) commitBlur();
    }, 0);
  };
  const leave = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.relatedTarget) return checkBlur();
    clearTimeout(blurTimer.current);
    // A pointer's focus leaves before the click it lands with: the draft is published now, so a button pressed
    // outside (a filter's Apply) reads the new value.
    if (!within(event.relatedTarget)) commitBlur();
  };
  const changeOpen = (next: boolean, details: ChangeDetails<DateFieldOpenReason>) => {
    setOpen(next, details);
    if (!next) checkBlur();
  };
  const returnToTrigger = () => {
    const target = trigger.current;
    if (target?.isConnected && (!container || (container.isConnected && !container.hasAttribute('data-closed')))) {
      target.focus({ preventScroll: true });
    }
  };
  const choose = (date: string, details: ChangeDetails<'day-press'>) => {
    setDraft(null);
    // The keyboard goes back to the button before the day it was on is taken away, and before the caller hears the
    // value: an enclosing dialog would see the focus fall to the page, and a caller may unmount the field.
    returnToTrigger();
    onChange(withTime && date ? withDate(value, date) : date, details);
    changeOpen(false, details);
  };
  const shut = disabled || !configuredBounds;
  return (
    <span
      ref={group}
      data-slot="date-field"
      data-kind={withTime ? 'with-time' : undefined}
      // The caller's class is a box's, and the box here is the text and its button together.
      className={className}
      onFocus={() => {
        ownedFocus.current = true;
      }}
      onBlur={leave}
    >
      <Input
        id={id}
        ref={input}
        name={name}
        type="text"
        value={shown}
        placeholder={placeholder ?? pattern}
        disabled={disabled}
        required={required}
        autoComplete="off"
        spellCheck={false}
        aria-required={required}
        aria-label={label}
        aria-invalid={invalid || bad || undefined}
        aria-describedby={[describedBy, hint].filter(Boolean).join(' ')}
        /* React's own change, not UI SDK's `onValueChange`: that one hears the `input` event alone, and a value
           put in the box without one (a browser's autofill, a script that sets it and says `change`) would be
           shown and never reported. */
        onChange={(event) => {
          const text = event.target.value;
          const said = changeDetails('input-change', event);
          setDraft(text);
          onChange(read(text) ?? text, said);
        }}
        onKeyDown={(event) => {
          if (event.altKey && event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            if (configuredBounds && !disabled) changeOpen(true, changeDetails('open-key', event));
          } else onKeyDown?.(event);
        }}
      />
      {/* A date and a time has a clock of its own beside the text: the platform's time control, which a phone answers
          with its wheel and a keyboard with its arrows, so nobody has to type "HH:MM" from a hint. It writes the
          text's time and keeps its date; with no date yet it starts on today's. */}
      {withTime && words.time && (
        <input
          type="time"
          data-slot="date-field-time"
          aria-label={words.time(label || undefined)}
          disabled={disabled}
          value={(splitDateTime(value)?.time ?? '').slice(0, 5)}
          onChange={(event) => {
            const clock = event.target.value;
            if (!clock) return;
            const day = isPickerDate(datePart) ? datePart : today;
            onChange(`${day} ${clock}`, changeDetails('input-change', event));
          }}
        />
      )}
      {/* Read with the box and not seen: how a date is typed, and the key that opens the calendar. */}
      <span id={hint} data-slot="date-field-hint" data-kind="visually-hidden">
        {withTime ? words.dateAndTimeFormat(pattern) : words.dateFormat(pattern)} {words.openWithKeys}
      </span>
      <Popover
        open={open && !shut}
        onOpenChange={(next, details) => {
          // Escape hands the keyboard back to the button; a press elsewhere leaves it where the press put it.
          if (!next && details.reason === 'escape-key') returnToTrigger();
          changeOpen(next, told(openReason(details.reason), details));
        }}
      >
        <PopoverTrigger ref={trigger} aria-label={words.chooseDate(label || undefined)} disabled={shut} data-variant="quiet">
          {calendarIcon}
        </PopoverTrigger>
        <PopoverContent
          ref={setPopup}
          aria-label={words.calendar(label || undefined)}
          data-kind="calendar"
          align="end"
          sideOffset={6}
          container={container ?? popupContainer()}
          // The keyboard starts on the day, not on the month's arrows, and where it goes on a close is said above.
          initialFocus={() => popup.current?.querySelector<HTMLElement>('[data-slot="calendar-day"][tabindex="0"]')}
          finalFocus="none"
          // The calendar is called what the caller's words call it. UI SDK names a popover by its button, which
          // here would say "Choose a date" for the dialog too, so the name it adds is taken off what it draws.
          render={(drawn) => <div {...drawn} aria-labelledby={undefined} />}
        >
          <Calendar
            controller={month}
            value={isPickerDate(datePart) ? datePart : null}
            defaultMonth={seed().slice(0, 7)}
            min={bounds.min === FIRST_DATE ? undefined : bounds.min}
            max={bounds.max === LAST_DATE ? undefined : bounds.max}
            locale={locale}
            timeZone={timezone}
            today={today}
            weekStartsOn={firstDay}
            onValueChange={(next, details) => {
              if (typeof next === 'string') choose(next, told('day-press', details));
            }}
          >
            <CalendarPrevious aria-label={words.previousMonth}>
              <Caret to="left" />
            </CalendarPrevious>
            <CalendarHeading />
            <CalendarNext aria-label={words.nextMonth}>
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
                      onClick={(event) => choose(cell.date, changeDetails('day-press', event))}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        choose(cell.date, changeDetails('day-press', event));
                      }}
                    />
                  ) : (
                    <CalendarDay value={cell.date} />
                  )
                }
              </CalendarWeeks>
            </CalendarGrid>
          </Calendar>
          <div data-slot="action-bar">
            <Button data-variant="quiet" data-size="sm" onClick={(event) => choose('', changeDetails('day-press', event))}>
              {words.clear}
            </Button>
            <Button
              data-variant="quiet"
              data-size="sm"
              disabled={!dateWithinBounds(today, bounds)}
              onClick={(event) => choose(today, changeDetails('day-press', event))}
            >
              {words.today}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const DateField = slotted('DateField', DefaultDateField, { onChange: [1, 'input-change'], onOpenChange: [1, 'implicit'] });
