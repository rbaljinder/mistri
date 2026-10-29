/**
 * Wall-clock digits: how the server writes a moment into a column that holds
 * no zone (Postgres `timestamp`, SQLite's text datetimes).
 * Such a column holds the clock on the wall of the App's `ui.timezone` — UTC
 * when the App names none — whatever wrote it: an action's `now`, a machine's
 * `since`, a command's `Date`. The browser shows the digits as written, so they
 * have to be the digits a person in that zone would read off the clock.
 *
 * A column with a zone (`timestamptz`) holds an instant and is not written here.
 */
import { zonelessInstant } from '../../shared/appStamps.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';

/* A formatter loads the zone's rules, the costly part, and every stamp asks. */
const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (formats.size >= 64) formats.clear();
    formats.set(zone, found);
  }
  return found;
}

/**
 * `YYYY-MM-DD HH:MM:SS` on the clock of `timezone` (UTC when absent), with
 * `.mmm` only where the moment has milliseconds to keep: a stamp is whole
 * seconds, as the engines' own CURRENT_TIMESTAMP writes one, but a handler's
 * `new Date()` should not lose what its column can hold.
 */
export function wallClockText(at: Date, timezone?: string): string {
  const millis = at.getUTCMilliseconds();
  const tail = millis ? `.${String(millis).padStart(3, '0')}` : '';
  if (!timezone) {
    const utc = at.toISOString();
    return `${utc.slice(0, 10)} ${utc.slice(11, 19)}${tail}`;
  }
  const part = Object.fromEntries(
    format(timezone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}${tail}`;
}

/** The values of a write with each `Date` bound for a zone-less column made its wall-clock text; every other value, and a zoned column's, as it was. */
export function withWallClock<V extends Record<string, unknown>>(
  columns: readonly Pick<ColumnMeta, 'name' | 'type'>[] | undefined,
  values: V,
  timezone?: string,
): V {
  let out: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(values)) {
    if (!(value instanceof Date)) continue;
    if (!columns?.some((column) => column.name === name && zonelessInstant(column.type))) continue;
    if (Number.isNaN(value.getTime())) continue;
    out ??= { ...values };
    out[name] = wallClockText(value, timezone);
  }
  return (out ?? values) as V;
}
