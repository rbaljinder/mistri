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
import { useFieldControl } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import type { DateFieldCalendarProps } from './internal/DateFieldCalendar.js';
import {
  clampDate,
  dateBounds,
  dateFormat,
  dateParts,
  dateTimeWithinBounds,
  dateWithinBounds,
  isPickerDate,
  isPickerDateTime,
  splitDateTime,
  todayInZone,
  withDate,
} from './internal/datePickerModel.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

let CalendarBody: ((props: DateFieldCalendarProps) => ReactNode) | undefined;
let calendarLoad: Promise<(props: DateFieldCalendarProps) => ReactNode> | undefined;
/* A load that failed (a deploy replaced the chunk, the network dropped) is forgotten, so the next press asks again:
   kept, the rejected promise would answer every later open and the calendar could never be shown in this visit. */
const warmCalendar = () =>
  (calendarLoad ??= import('./internal/DateFieldCalendar.js').then(
    (mod) => (CalendarBody = mod.DateFieldCalendar),
    (cause: unknown) => {
      calendarLoad = undefined;
      throw cause;
    },
  ));
/* Warming ahead of a press is a courtesy; its failure is the next open's to retry, not an unhandled rejection. */
const prewarmCalendar = () => void warmCalendar().catch(() => undefined);

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
  const split = typed.match(/^(.+?)[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  if (!split) return undefined;
  const date = readDate(split[1]!, mask);
  const time = /^\d:/.test(split[2]!) ? `0${split[2]}` : split[2]!;
  const iso = date && `${date} ${time}`;
  return iso && isPickerDateTime(iso) ? iso : undefined;
}

/** What was typed, read as a whole date in the locale's order (or ISO), else undefined: a draft stays text. */
function readDate(text: string, mask: { order: string[] }): string | undefined {
  if (isoDate(text)) return text;
  const numbers = text.trim().match(/^(\d{1,4})\s*\D\s*(\d{1,2})\s*\D\s*(\d{1,4})$/);
  if (!numbers) return undefined;
  const at: Record<string, string> = {};
  mask.order.forEach((type, index) => (at[type] = numbers[index + 1]!));
  if (at.year!.length !== 4) return undefined;
  const iso = `${at.year}-${at.month!.padStart(2, '0')}-${at.day!.padStart(2, '0')}`;
  return isPickerDate(iso) ? iso : undefined;
}

/** Props for the `DateField` ISO date and wall-clock date-time picker control. */
export interface DateFieldProps {
  id: string;
  words: DateFieldWords;
  /** Drawn in the calendar button. */
  calendarIcon: ReactNode;
  value: string;
  /** Typed text is preserved, including an incomplete date; callers validate on commit. `day-press` is a day (or Clear,
      or Today) chosen in the calendar. */
  onValueChange?: (value: string, details: ChangeDetails<'input-change' | 'day-press'>) => void;
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
  ref?: Ref<HTMLInputElement>;
  placeholder?: string;
  /** A date and a wall-clock time (`YYYY-MM-DD HH:MM`, as the box says it; the `T` a datetime-local control writes is read too): the calendar
      picks the date and keeps the time typed. `min` and `max` then bound the whole value. */
  withTime?: boolean;
  /** The calendar is drawn in a portal; an owner that watches focus (an autosaving field) is told where. */
  popupRef?: (node: HTMLDivElement | null) => void;
  /** A popover's words (`trigger-press`, `outside-press`, `escape-key` …), `day-press` when a choice closed it, `open-key` for Alt+ArrowDown, and `disabled` when the
      field was disabled or its bounds stopped agreeing while it was open. */
  onOpenChange?: (open: boolean, details: ChangeDetails<DateFieldOpenReason>) => void;
  ariaLabel?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

/** Reasons reported to `DateField`'s `onOpenChange` callback. */
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

/** A date field, or a date and a wall-clock time. No input is parsed as an instant or shifted by a timezone. */
function DefaultDateField(props: DateFieldProps) {
  const {
    id,
    words,
    calendarIcon,
    value,
    onValueChange,
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
    ref,
    placeholder,
    withTime = false,
    popupRef,
    onOpenChange,
    ariaLabel,
    'aria-invalid': invalid,
    'aria-describedby': describedBy,
  } = props;
  const legacyChange = (props as { onChange?: (value: string, details: ChangeDetails<'input-change' | 'day-press'>) => void }).onChange;
  const legacyAriaLabel = (props as unknown as Record<string, unknown>)['aria-label'] as string | undefined;
  const legacyRef = (props as { inputRef?: Ref<HTMLInputElement> }).inputRef;
  const label = ariaLabel ?? legacyAriaLabel;
  const targetRef = ref ?? legacyRef;
  const emit = (next: string, details: ChangeDetails<'input-change' | 'day-press'>) => {
    onValueChange?.(next, details);
    legacyChange?.(next, details);
  };

  const datePart = withTime ? (splitDateTime(value)?.date ?? value.slice(0, 10)) : value;
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
  const pendingOpen = useRef(false);
  const openCallback = useRef(onOpenChange);
  const blurCallback = useRef(onBlur);
  useLayoutEffect(() => {
    openCallback.current = onOpenChange;
    blurCallback.current = onBlur;
  });
  const setOpen = (next: boolean, details: ChangeDetails<DateFieldOpenReason>) => {
    /* The page is told the calendar is open when it is, not when it was asked for: while its code loads there is nothing
       on screen, and a load that fails or is called off never opened anything to report or to close. */
    const calledOff = !next && pendingOpen.current && !open;
    pendingOpen.current = next;
    if (next && !CalendarBody) {
      void warmCalendar().then(
        () => {
          if (!pendingOpen.current) return;
          setOpenState(true);
          openCallback.current?.(true, details);
        },
        () => {
          pendingOpen.current = false;
        },
      );
      return;
    }
    setOpenState(next);
    if (!calledOff) openCallback.current?.(next, details);
  };
  const group = useRef<HTMLSpanElement>(null);
  const container = useDialogContainer(group);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(targetRef, () => input.current!, []);
  const popup = useRef<HTMLDivElement | null>(null);
  const setPopup = useCallback(
    (node: HTMLDivElement | null) => {
      popup.current = node;
      popupRef?.(node);
    },
    [popupRef],
  );
  const ownedFocus = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const hint = useId();
  const mask = useMemo(() => dateMask(locale), [locale]);
  const [draft, setDraft] = useState<string | null>(null);
  const read = (text: string) => (withTime ? readDateTime(text, mask) : readDate(text, mask));
  const shown =
    draft ??
    (withTime ? (isPickerDateTime(value) ? localeDateTime(value, mask) : value) : isPickerDate(value) ? localeText(value, mask) : value);
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
  useLayoutEffect(() => {
    if (!open) return;
    if (!configuredBounds || disabled) setOpen(false, changeDetails('disabled'));
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
    blurTimer.current = setTimeout(() => {
      if (!within(document.activeElement)) commitBlur();
    }, 0);
  };
  const leave = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.relatedTarget) return checkBlur();
    clearTimeout(blurTimer.current);
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
    returnToTrigger();
    emit(withTime && date ? withDate(value, date) : date, details);
    changeOpen(false, details);
  };
  const shut = disabled || !configuredBounds;
  const DrawnCalendar = CalendarBody;
  const fieldProps = useFieldControl()?.props({}) as Record<string, unknown> | undefined;
  const fieldId = typeof fieldProps?.id === 'string' && fieldProps.id ? fieldProps.id : undefined;
  const fieldLabelledBy =
    typeof fieldProps?.['aria-labelledby'] === 'string' && fieldProps['aria-labelledby'] ? fieldProps['aria-labelledby'] : undefined;
  const fieldDescribedBy =
    typeof fieldProps?.['aria-describedby'] === 'string' && fieldProps['aria-describedby'] ? fieldProps['aria-describedby'] : undefined;
  const fieldInvalid = fieldProps?.['aria-invalid'] === true || fieldProps?.['aria-invalid'] === 'true';
  const mergedDescribedBy = [describedBy, fieldDescribedBy && fieldDescribedBy !== describedBy ? fieldDescribedBy : undefined, hint]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      ref={group}
      data-slot="date-field"
      data-kind={withTime ? 'with-time' : undefined}
      className={className}
      onPointerEnter={prewarmCalendar}
      onFocus={() => {
        ownedFocus.current = true;
        prewarmCalendar();
      }}
      onBlur={leave}
    >
      <Input
        id={id || fieldId}
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
        aria-labelledby={label ? undefined : fieldLabelledBy}
        aria-invalid={invalid || fieldInvalid || bad || undefined}
        aria-describedby={mergedDescribedBy}
        onChange={(event) => {
          const text = event.target.value;
          const said = changeDetails('input-change', event);
          setDraft(text);
          emit(read(text) ?? text, said);
        }}
        onKeyDown={(event) => {
          if (event.altKey && event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            if (configuredBounds && !disabled) changeOpen(true, changeDetails('open-key', event));
          } else onKeyDown?.(event);
        }}
      />
      {withTime && words.time && (
        <input
          type="time"
          data-slot="date-field-time"
          aria-label={words.time(label || undefined)}
          disabled={disabled}
          value={(splitDateTime(value)?.time ?? '').slice(0, 5)}
          onChange={(event) => {
            const clock = event.target.value;
            if (!clock) {
              emit(isPickerDate(datePart) ? datePart : '', changeDetails('input-change', event));
              return;
            }
            const day = isPickerDate(datePart) ? datePart : today;
            emit(`${day} ${clock}`, changeDetails('input-change', event));
          }}
        />
      )}
      <span id={hint} data-slot="date-field-hint" data-kind="visually-hidden">
        {withTime ? words.dateAndTimeFormat(pattern) : words.dateFormat(pattern)} {words.openWithKeys}
      </span>
      <Popover
        open={open && !shut}
        onOpenChange={(next, details) => {
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
          initialFocus={() => popup.current?.querySelector<HTMLElement>('[data-slot="calendar-day"][tabindex="0"]')}
          finalFocus="none"
          render={(drawn) => <div {...drawn} aria-labelledby={undefined} />}
        >
          {DrawnCalendar && (
            <DrawnCalendar
              datePart={datePart}
              seeded={seed()}
              bounds={bounds}
              locale={locale}
              timezone={timezone}
              today={today}
              firstDay={firstDay}
              previousMonth={words.previousMonth}
              nextMonth={words.nextMonth}
              popupRef={popup}
              onChoose={choose}
            />
          )}
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

/** Editable ISO date or wall-clock date-time field paired with a lazy-loaded popover calendar. */
export const DateField = slotted('DateField', DefaultDateField, { onValueChange: [1, 'input-change'], onOpenChange: [1, 'implicit'] });
