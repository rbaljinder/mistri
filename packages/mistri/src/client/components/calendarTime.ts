/**
 * A calendar's moments as its time grid reads them (CalendarTimeGrid.tsx): the day a stored timestamp falls on and
 * its minute of that day, and the same value moved by some minutes, written back in its own form.
 *
 * As every figure the client says (locale.ts `wallClock`): a timestamp with no zone is the wall clock it was written
 * with; one that carries its zone (`…Z` from SQLite, `+00` from Postgres) is an instant, placed in the App's
 * `ui.timezone` where it names one, else as written. A move keeps the value's form: its separator, whether it has
 * seconds, and its offset — the instant moved, not re-said in another zone.
 */
import { formatTimezone } from '@mistriwork/kit/client/locale.js';

/** Where a record stands on the grid: its day (YYYY-MM-DD) and its minute of that day, 0 to 1439. */
export interface Moment {
  day: string;
  minute: number;
}

const STORED = /^(\d{4})-(\d{2})-(\d{2})(?:([ T])(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const MINUTE = 60_000;
export const DAY_MINUTES = 1440;
const pad = (n: number) => String(n).padStart(2, '0');

interface Stored {
  /** The fields as written, read as UTC: the wall clock, in milliseconds. */
  wall: number;
  separator: string;
  seconds: boolean;
  fraction: string;
  /** The offset written after it, in minutes east of UTC, and as written; absent for a wall clock. */
  offset?: { minutes: number; text: string };
}

function read(text: string): Stored | null {
  const match = STORED.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, separator, h, mi, s, fraction, zone] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  const said = new Date(wall);
  if (said.getUTCMonth() !== Number(mo) - 1 || said.getUTCDate() !== Number(d)) return null;
  let offset: Stored['offset'];
  if (zone && h !== undefined) {
    const [, sign, oh, om] = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone) ?? [];
    offset = { minutes: sign ? (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om ?? 0)) : 0, text: zone };
  }
  return { wall, separator: separator ?? 'T', seconds: s !== undefined, fraction: fraction ?? '', ...(offset ? { offset } : {}) };
}

/* The App's zone, where this runtime knows it: a reader's own zone is never guessed (locale.ts appZone). */
function appZone(): string | undefined {
  const zone = formatTimezone();
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

const zoned = new Map<string, Intl.DateTimeFormat>();
/** An instant's wall clock in a zone, as UTC fields in milliseconds. */
function wallIn(instant: number, zone: string): number {
  let parts = zoned.get(zone);
  if (!parts) {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    zoned.set(zone, parts);
  }
  const get = (type: string) => Number(parts.formatToParts(instant).find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
}

const fromWall = (wall: number): Moment => {
  const at = new Date(wall);
  return {
    day: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    minute: at.getUTCHours() * 60 + at.getUTCMinutes(),
  };
};

/** Where a stored value stands on the grid, or null when it is not a date. */
export function momentOf(value: unknown): Moment | null {
  if (value === null || value === undefined || value === '') return null;
  const stored = read(String(value));
  if (!stored) return null;
  const zone = stored.offset ? appZone() : undefined;
  return fromWall(zone ? wallIn(stored.wall - stored.offset!.minutes * MINUTE, zone) : stored.wall);
}

/** The present, as the grid places it: in the App's zone where it names one, else the reader's own clock. */
export function nowMoment(now: Date = new Date()): Moment {
  const zone = appZone();
  if (zone) return fromWall(wallIn(now.getTime(), zone));
  return { day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, minute: now.getHours() * 60 + now.getMinutes() };
}

/** Minutes from one moment to another. */
export const minutesBetween = (from: Moment, to: Moment): number =>
  Math.round((Date.UTC(...dayParts(to.day)) - Date.UTC(...dayParts(from.day))) / MINUTE) + to.minute - from.minute;
const dayParts = (day: string): [number, number, number] => {
  const [y, m, d] = day.split('-').map(Number);
  return [y!, m! - 1, d!];
};

/** A stored value moved by `minutes`, in the form it was written: its separator, its seconds, its offset. */
export function shifted(value: unknown, minutes: number): string | null {
  const stored = read(String(value ?? ''));
  if (!stored) return null;
  const at = new Date(stored.wall + minutes * MINUTE);
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}${stored.seconds ? `:${pad(at.getUTCSeconds())}${stored.fraction}` : ''}`;
  /* The wall clock written with the offset it had: the instant moves by the same minutes, and stays in its zone. */
  return `${date}${stored.separator}${time}${stored.offset?.text ?? ''}`;
}

/** The grid's step: a drop lands on the hour or the half hour, and the keyboard moves a record by it. */
export const SLOT_MINUTES = 30;
