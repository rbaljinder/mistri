/**
 * A wall time in a zone, and the instant it names. The date field never
 * converts (it edits text); a command's `datetime` input does, once, where the
 * form is sent: a person types the time as the App shows times (its
 * `ui.timezone`, the browser's own without one), and the handler receives the
 * UTC instant. A starting value comes back the other way.
 */
import { dateFormat, isPickerDateTime, splitDateTime } from '@mistriwork/ui/datePickerModel.js';

const PARTS = {
  calendar: 'gregory',
  numberingSystem: 'latn',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
} as const;

/** The wall clock in `zone` at an instant, as numbers. */
function wallAt(time: number, zone: string | undefined) {
  const parts = dateFormat('en-US', { ...PARTS, timeZone: zone }).formatToParts(new Date(time));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/* The wall clock's fields read as if they were UTC: a ruler, never a moment. setUTCFullYear keeps years 0–99. */
function ruler(year: number, month: number, day: number, hour: number, minute: number, second: number, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

const offsetAt = (time: number, zone: string | undefined): number => {
  const wall = wallAt(time, zone);
  return ruler(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) - (time - (((time % 1000) + 1000) % 1000));
};

/**
 * The UTC instant a wall time (`YYYY-MM-DD HH:MM`, seconds optional) names in
 * `zone`, as ISO 8601; undefined for text that is not a whole date and time.
 * A time a clock change repeats is the earlier of its two moments; a time it
 * skips moves forward by the gap.
 */
export function wallTimeInstant(value: string, zone: string | undefined): string | undefined {
  if (!isPickerDateTime(value)) return undefined;
  const { date, time } = splitDateTime(value)!;
  const [hour, minute, rest = '0'] = time.split(':');
  const [second, fraction = ''] = rest.split('.');
  const wall = ruler(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    Number(date.slice(8, 10)),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  // The offsets a day either side: one moment for most wall times, two where a clock repeats an hour, none where it skips one.
  const day = 86_400_000;
  const readings = [wall - offsetAt(wall - day, zone), wall - offsetAt(wall + day, zone)];
  const whole = wall - (((wall % 1000) + 1000) % 1000);
  const shows = (time: number) => {
    const at = wallAt(time, zone);
    return ruler(at.year, at.month, at.day, at.hour, at.minute, at.second) === whole;
  };
  const shown = readings.filter(shows);
  return new Date(shown.length ? Math.min(...shown) : Math.max(...readings)).toISOString();
}

/** An instant as the wall time `zone` shows it, `YYYY-MM-DD HH:MM` (seconds only when it has some); undefined for anything else. */
export function instantWallTime(value: string, zone: string | undefined): string | undefined {
  const time = Date.parse(value);
  if (!/[zZ]|[+-]\d{2}(?::?\d{2})?$/.test(value) || !Number.isFinite(time)) return undefined;
  const wall = wallAt(time, zone);
  const two = (n: number) => String(n).padStart(2, '0');
  const seconds = wall.second ? `:${two(wall.second)}` : '';
  return `${String(wall.year).padStart(4, '0')}-${two(wall.month)}-${two(wall.day)} ${two(wall.hour)}:${two(wall.minute)}${seconds}`;
}
