/**
 * The themed calendar field: editable ISO text beside a calendar popover,
 * for a date, or with `withTime` for a date and a wall-clock time. The text
 * is the value — typed drafts survive, the calendar only ever writes the
 * date part — and nothing here converts a value through an instant. The
 * arithmetic and the bounds are datePickerModel.ts's. Its words and the
 * calendar button's icon are props: the kit lends its catalog's and its icon.
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
import { Popover } from '@base-ui/react/popover';
import { layoutViewport, zoomAnchor } from './anchor.js';
import {
  addDateDays,
  addDateMonths,
  clampDate,
  dateBounds,
  dateFormat,
  dateParts,
  dateTimeWithinBounds,
  dateWithinBounds,
  isPickerDate,
  isPickerDateTime,
  monthGrid,
  monthLabel,
  splitDateTime,
  todayInZone,
  weekdayLabels,
  withDate,
} from './datePickerModel.js';
import { popupContainer } from './popups.js';

/** What a date field says. A `format` is the locale's numeric date pattern ("MM/DD/YYYY"). */
export interface DateFieldWords {
  /** The placeholder and the format a date and a time are typed in. */
  dateTimePattern: string;
  /** The box's complaint at a date and time it cannot take. */
  enterDateAndTime: string;
  /** The box's complaint at a date it cannot take. */
  enterDate: (format: string) => string;
  /** The hint read with the box: its format, for a date and a time. */
  dateAndTimeFormat: string;
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
  /** Typed text is preserved, including an incomplete date; callers validate on commit. */
  onChange: (value: string) => void;
  /** Composite blur: never fired while focus moves between the input and calendar. */
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  locale?: string;
  timezone?: string;
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
  onOpenChange?: (open: boolean) => void;
  'aria-label'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

/** A date field, or a date and a wall-clock time. No input is parsed as an instant or shifted by a timezone. */
export function DateField({
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
  firstDay = 1,
  className = '',
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
  // A range facet may temporarily supply an incomplete or reversed bound.
  // Keep text editable but disable calendar selection until both ends agree.
  const configuredBounds = useMemo(() => {
    try {
      return dateBounds(withTime ? min?.slice(0, 10) : min, withTime ? max?.slice(0, 10) : max);
    } catch {
      return null;
    }
  }, [min, max, withTime]);
  const bounds = configuredBounds ?? dateBounds();
  const today = todayInZone(new Date(), timezone);
  const seed = () => clampDate(isPickerDate(datePart) ? datePart : today, bounds);
  const [active, setActive] = useState(seed);
  const [open, setOpenState] = useState(false);
  const openCallback = useRef(onOpenChange);
  useLayoutEffect(() => {
    openCallback.current = onOpenChange;
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    openCallback.current?.(next);
  };
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const group = useRef<HTMLSpanElement>(null);
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
  const ownedFocus = useRef(false);
  const moveFocus = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreFocus = useRef(false);
  const blurCallback = useRef(onBlur);
  useLayoutEffect(() => {
    blurCallback.current = onBlur;
  });
  const caption = useId();
  const hint = useId();
  /* A date alone is shown as the locale writes it and kept as ISO; what is being typed stays as typed until the
     field is left, so a half-typed date is never rewritten under the caret. A date with a time stays ISO text. */
  const mask = useMemo(() => dateMask(locale), [locale]);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = withTime ? value : (draft ?? (isPickerDate(value) ? localeText(value, mask) : value));
  const formatHint = withTime ? words.dateTimePattern : mask.hint;
  useEffect(() => {
    if (draft !== null && value !== (readDate(draft, mask) ?? draft)) setDraft(null);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = monthGrid(active, firstDay, bounds);
  const weekdays = weekdayLabels(locale, firstDay);
  useEffect(() => {
    setContainer(trigger.current?.closest('dialog, [role="dialog"]') as HTMLElement | null);
    return () => {
      clearTimeout(blurTimer.current);
    };
  }, []);
  const bad =
    !configuredBounds ||
    (value !== '' &&
      (withTime
        ? !isPickerDateTime(value) || !dateWithinBounds(datePart, bounds) || !dateTimeWithinBounds(value, min, max)
        : !dateWithinBounds(value, bounds)));
  useEffect(() => {
    input.current?.setCustomValidity(!bad ? '' : withTime ? words.enterDateAndTime : words.enterDate(mask.hint));
  }, [bad, withTime, mask]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!open) return;
    if (!configuredBounds || disabled) {
      setOpen(false);
      return;
    }
    const next = clampDate(isPickerDate(datePart) ? datePart : active, configuredBounds);
    if (next !== active) {
      moveFocus.current = Boolean(popup.current?.querySelector('[data-date]:focus'));
      setActive(next);
    }
    // Synchronize external changes, not arrow-key movement within the calendar.
  }, [value, min, max, disabled]);
  useLayoutEffect(() => {
    if (!open || !moveFocus.current) return;
    popup.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus();
    moveFocus.current = false;
  }, [active, open]);
  const within = (node: Node | null) => Boolean(node && (group.current?.contains(node) || popup.current?.contains(node)));
  const commitBlur = () => {
    if (ownedFocus.current) {
      ownedFocus.current = false;
      setDraft(null);
      blurCallback.current?.();
    }
  };
  const checkBlur = () => {
    clearTimeout(blurTimer.current);
    // Let the portal's focus restoration finish before deciding the field was left.
    blurTimer.current = setTimeout(() => {
      if (!within(document.activeElement)) commitBlur();
    }, 0);
  };
  const leave = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.relatedTarget) {
      checkBlur();
      return;
    }
    clearTimeout(blurTimer.current);
    // Pointer focus leaves before the destination's click/submit. Publish the
    // draft now so a surrounding filter's Apply button reads the new value.
    if (!within(event.relatedTarget)) commitBlur();
  };
  const changeOpen = (next: boolean) => {
    if (next) {
      restoreFocus.current = false;
      setActive(seed());
    }
    setOpen(next);
    if (!next) checkBlur();
  };
  const returnToTrigger = () => {
    const target = trigger.current;
    if (target?.isConnected && (!container || (container.isConnected && !container.hasAttribute('data-closed')))) {
      target.focus({ preventScroll: true });
    }
  };
  const choose = (date: string) => {
    restoreFocus.current = true;
    setDraft(null);
    // Move focus before removing the focused day. Otherwise an enclosing
    // modal sees focus fall to body and starts its own recovery to the dialog.
    returnToTrigger();
    onChange(withTime && date ? withDate(value, date) : date);
    changeOpen(false);
  };
  const move = (date: string) => {
    moveFocus.current = true;
    setActive(clampDate(date, bounds));
  };
  const onDayKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = days.findIndex((day) => day.date === active) % 7;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -index, End: 6 - index };
    if (Object.hasOwn(steps, event.key)) {
      event.preventDefault();
      event.stopPropagation();
      move(addDateDays(active, steps[event.key]));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      event.stopPropagation();
      move(addDateMonths(active, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)));
    }
  };
  const dayName = (date: string) => {
    const p = dateParts(date),
      ruler = new Date(0);
    ruler.setUTCFullYear(p.year, p.month - 1, p.day);
    return dateFormat(locale, { calendar: 'gregory', timeZone: 'UTC', dateStyle: 'full' }).format(ruler);
  };
  const previous = addDateMonths(active, -1),
    next = addDateMonths(active, 1);
  return (
    <Popover.Root
      open={open && !disabled && Boolean(configuredBounds)}
      onOpenChange={(next, details) => {
        restoreFocus.current = !next && details.reason === 'escape-key';
        if (restoreFocus.current) returnToTrigger();
        changeOpen(next);
      }}
    >
      <span
        ref={group}
        className={withTime ? 'date-field with-time' : 'date-field'}
        onFocus={() => {
          ownedFocus.current = true;
        }}
        onBlur={leave}
      >
        <input
          ref={input}
          id={id}
          name={name}
          type="text"
          value={shown}
          className={`date-field-input ${className}`}
          placeholder={placeholder ?? (withTime ? words.dateTimePattern : mask.hint)}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          required={required}
          aria-required={required}
          aria-label={label}
          aria-invalid={invalid || bad || undefined}
          aria-describedby={[describedBy, hint].filter(Boolean).join(' ')}
          onChange={(event) => {
            const text = event.target.value;
            if (withTime) return onChange(text);
            setDraft(text);
            onChange(readDate(text, mask) ?? text);
          }}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              if (configuredBounds) changeOpen(true);
            } else onKeyDown?.(event);
          }}
        />
        <span id={hint} className="date-field-hint">
          {withTime ? words.dateAndTimeFormat : words.dateFormat(formatHint)} {words.openWithKeys}
        </span>
        <Popover.Trigger
          render={
            <button
              ref={trigger}
              type="button"
              className="date-field-trigger"
              disabled={disabled || !configuredBounds}
              aria-label={words.chooseDate(label || undefined)}
            />
          }
        >
          {calendarIcon}
        </Popover.Trigger>
        <Popover.Portal container={container ?? popupContainer()}>
          <Popover.Positioner
            anchor={() => (trigger.current ? zoomAnchor(trigger.current) : null)}
            positionMethod="fixed"
            side="bottom"
            align="end"
            sideOffset={6}
            collisionBoundary={layoutViewport()}
            collisionPadding={8}
            style={{ zIndex: 45 }}
          >
            <Popover.Popup
              ref={setPopup}
              finalFocus={() => {
                const target = trigger.current,
                  focused = document.activeElement;
                return restoreFocus.current &&
                  target?.isConnected &&
                  (!container || (container.isConnected && !container.hasAttribute('data-closed'))) &&
                  (focused === target || focused === document.body || focused === container)
                  ? target
                  : false;
              }}
              className="date-field-popup"
              aria-label={words.calendar(label || undefined)}
              initialFocus={() => popup.current?.querySelector<HTMLElement>(`[data-date="${active}"]`) ?? true}
            >
              <div className="date-field-head">
                <button
                  type="button"
                  aria-label={words.previousMonth}
                  disabled={previous.slice(0, 7) === active.slice(0, 7) || previous.slice(0, 7) < bounds.min.slice(0, 7)}
                  onClick={() => setActive(clampDate(previous, bounds))}
                >
                  ←
                </button>
                <span id={caption} aria-live="polite" aria-atomic="true">
                  {monthLabel(active, locale)}
                </span>
                <button
                  type="button"
                  aria-label={words.nextMonth}
                  disabled={next.slice(0, 7) === active.slice(0, 7) || next.slice(0, 7) > bounds.max.slice(0, 7)}
                  onClick={() => setActive(clampDate(next, bounds))}
                >
                  →
                </button>
              </div>
              <table className="date-field-calendar" role="grid" aria-labelledby={caption}>
                <thead>
                  <tr>
                    {weekdays.map((day) => (
                      <th key={day.long} scope="col" aria-label={day.long}>
                        {day.short}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, week) => (
                    <tr key={week}>
                      {days.slice(week * 7, week * 7 + 7).map((day, index) => (
                        <td key={day.date ?? index} aria-selected={day.date === datePart}>
                          {day.date && (
                            <button
                              type="button"
                              data-date={day.date}
                              data-outside={!day.inMonth || undefined}
                              data-selected={day.date === datePart || undefined}
                              aria-current={day.date === today ? 'date' : undefined}
                              disabled={day.disabled}
                              tabIndex={day.date === active ? 0 : -1}
                              aria-label={dayName(day.date)}
                              onKeyDown={onDayKey}
                              onClick={() => choose(day.date!)}
                            >
                              {Number(day.date.slice(8))}
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="date-field-foot">
                <button type="button" onClick={() => choose('')}>
                  {words.clear}
                </button>
                <button type="button" disabled={!dateWithinBounds(today, bounds)} onClick={() => choose(today)}>
                  {words.today}
                </button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </span>
    </Popover.Root>
  );
}
