/**
 * A calendar's arithmetic on ISO dates (`YYYY-MM-DD`) and wall-clock date-times: no value is ever an instant, so no
 * timezone moves a day. The errors it throws are a caller's mistake (a date it should have checked first), said to a
 * developer, so they are plain English rather than a catalog's words.
 */

/** A real calendar date written as ISO: the shape, and a day the month has. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const FIRST_DATE = '0001-01-01';
export const LAST_DATE = '9999-12-31';
interface DateParts {
  year: number;
  month: number;
  day: number;
}
interface DateBounds {
  min: string;
  max: string;
}
interface CalendarDay {
  date: string | null;
  inMonth: boolean;
  disabled: boolean;
}

/* One formatter per locale and options, made once: a date field drew its
   weekday names, its month and "today" on every render, and each
   Intl.DateTimeFormat costs about a millisecond to build on a phone — a
   filter sheet with two date ranges spent most of its opening building them
   (test/built-client-vitals.mjs). An option the platform refuses still
   throws, every time, since only a built formatter is kept. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, format);
  }
  return format;
}

/** Reuse command validation, narrowing its year-zero support to the form domain. */
export function isPickerDate(value: unknown): value is string {
  return isIsoDate(value) && value >= FIRST_DATE && value <= LAST_DATE;
}

export function dateParts(value: string): DateParts {
  if (!isPickerDate(value)) throw new RangeError('Expected an existing ISO date from 0001-01-01 through 9999-12-31.');
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

/** UTC is only a ruler for calendar arithmetic, never a conversion of user input.
    setUTCFullYear avoids the Date constructor's special treatment of years 0–99. */
function calendarDate({ year, month, day }: DateParts): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function iso(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function integer(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError('Calendar steps must be safe integers.');
}

export function daysInMonth(year: number, month: number): number {
  integer(year);
  integer(month);
  if (year < 1 || year > 9999 || month < 1 || month > 12) throw new RangeError('Invalid calendar month.');
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function addDateDays(value: string, step: number): string {
  const date = calendarDate(dateParts(value));
  integer(step);
  const min = calendarDate(dateParts(FIRST_DATE)).getTime();
  const max = calendarDate(dateParts(LAST_DATE)).getTime();
  return iso(new Date(Math.min(max, Math.max(min, date.getTime() + step * 86_400_000))));
}

export function addDateMonths(value: string, step: number): string {
  const current = dateParts(value);
  integer(step);
  const index = Math.min(9999 * 12 - 1, Math.max(0, (current.year - 1) * 12 + current.month - 1 + step));
  const year = Math.floor(index / 12) + 1,
    month = (index % 12) + 1;
  return iso(calendarDate({ year, month, day: Math.min(current.day, daysInMonth(year, month)) }));
}

/** Empty ends mean unbounded. Refusing a malformed bound prevents accidental widening. */
export function dateBounds(min?: string, max?: string): DateBounds {
  // Command declarations historically accept year zero; as with native date
  // controls, that lower bound must not disable all supported modern dates.
  const lower = min && isIsoDate(min) && min < FIRST_DATE ? FIRST_DATE : min || FIRST_DATE;
  const upper = max || LAST_DATE;
  dateParts(lower);
  dateParts(upper);
  if (lower > upper) throw new RangeError('Minimum date must not exceed maximum date.');
  return { min: lower, max: upper };
}

export function dateWithinBounds(value: string, bounds: DateBounds): boolean {
  return isPickerDate(value) && value >= bounds.min && value <= bounds.max;
}

export function clampDate(value: string, bounds: DateBounds): string {
  dateParts(value);
  return value < bounds.min ? bounds.min : value > bounds.max ? bounds.max : value;
}

/** Six stable weeks; out-of-domain cells are blanks rather than repeated edge days. */
export function monthGrid(value: string, firstDay = 1, bounds = dateBounds()): CalendarDay[] {
  integer(firstDay);
  if (firstDay < 0 || firstDay > 6) throw new RangeError('First weekday must be between 0 (Sunday) and 6.');
  const parts = dateParts(value),
    start = calendarDate({ ...parts, day: 1 });
  const offset = (start.getUTCDay() - firstDay + 7) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start.getTime() + (index - offset) * 86_400_000);
    if (day.getUTCFullYear() < 1 || day.getUTCFullYear() > 9999) return { date: null, inMonth: false, disabled: true };
    const date = iso(day);
    return { date, inMonth: day.getUTCMonth() + 1 === parts.month, disabled: !dateWithinBounds(date, bounds) };
  });
}

export function monthLabel(value: string, locale?: string): string {
  return dateFormat(locale, { calendar: 'gregory', timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    calendarDate(dateParts(value)),
  );
}

export function weekdayLabels(locale?: string, firstDay = 1): Array<{ short: string; long: string }> {
  integer(firstDay);
  if (firstDay < 0 || firstDay > 6) throw new RangeError('First weekday must be between 0 (Sunday) and 6.');
  const short = dateFormat(locale, { calendar: 'gregory', timeZone: 'UTC', weekday: 'short' });
  const long = dateFormat(locale, { calendar: 'gregory', timeZone: 'UTC', weekday: 'long' });
  return Array.from({ length: 7 }, (_, index) => {
    const day = calendarDate({ year: 2023, month: 1, day: 1 + ((firstDay + index) % 7) });
    return { short: short.format(day), long: long.format(day) };
  });
}

/* A wall-clock time as a datetime-local control writes one: HH:MM, then
   optional seconds and milliseconds. No zone, ever: a value with an offset or
   a Z is an instant, and an instant is not a picker's to edit as a date. */
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/;

export function isPickerTime(value: unknown): value is string {
  return typeof value === 'string' && WALL_TIME.test(value);
}

/** A date and a wall-clock time, split at the T a datetime-local control writes or the space a person types. */
export function splitDateTime(value: string): { date: string; time: string } | null {
  const at = value.search(/[T ]/);
  return at === 10 ? { date: value.slice(0, 10), time: value.slice(11) } : null;
}

export function isPickerDateTime(value: unknown): value is string {
  const parts = typeof value === 'string' ? splitDateTime(value) : null;
  return Boolean(parts && isPickerDate(parts.date) && isPickerTime(parts.time));
}

/** The date a calendar picked, keeping the time already typed; a value with none starts at midnight. Said as the box says it, `YYYY-MM-DD HH:MM`. */
export function withDate(value: string, date: string): string {
  const time = splitDateTime(value)?.time;
  return `${date} ${time && isPickerTime(time) ? time : '00:00'}`;
}

/** Seconds and milliseconds filled in, so two wall times compare as text. Null for anything that is not one. */
function comparable(value: string): string | null {
  if (!isPickerDateTime(value)) return null;
  const { date, time } = splitDateTime(value)!;
  const [hm, rest = '00'] = [time.slice(0, 5), time.slice(6)];
  const [seconds = '00', fraction = ''] = rest.split('.');
  return `${date}T${hm}:${seconds.padEnd(2, '0')}.${fraction.padEnd(3, '0')}`;
}

/** Inclusive bounds on a wall time; an end that is not a complete date and time bounds nothing. */
export function dateTimeWithinBounds(value: string, min?: string, max?: string): boolean {
  const at = comparable(value);
  if (at === null) return false;
  const lower = min ? comparable(min) : null,
    upper = max ? comparable(max) : null;
  return (lower === null || at >= lower) && (upper === null || at <= upper);
}

/** Only 'today' depends on a timezone; values and calendar movement never do. */
export function todayInZone(now: Date, timeZone?: string): string {
  const parts = dateFormat('en-US', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const result = `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
  dateParts(result);
  return result;
}
