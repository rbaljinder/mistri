/**
 * The reading of `ui.timezone`, apart from the rest of `ui`: a command host
 * counts its days in the App's zone, and importing `appUi.ts` for that
 * loaded every look and theme module into `--mcp` (test/cli-startup.test.ts).
 */
import type { AppUi } from './appModel.js';

/**
 * The one reading of `ui.timezone`. Without a reader's zone it is the App's
 * own — the wall clock its writes, stamps, machines and jobs keep, whoever
 * caused them. With one (`readerZone`, resolved per request from
 * `{ column }`), it is the zone that reader's days are counted in: their
 * "today", their windows, the served payload's `timezone`.
 */
export function appZone(ui: Pick<AppUi, 'timezone'> | undefined, reader?: string): string | undefined {
  const zone = ui?.timezone;
  if (typeof zone !== 'object') return zone;
  return reader ?? zone.default;
}

/** The resource and column `ui.timezone: { column }` names, where it names one. */
export function zoneColumn(ui: Pick<AppUi, 'timezone'> | undefined): { resource: string; column: string } | undefined {
  const zone = ui?.timezone;
  if (typeof zone !== 'object') return undefined;
  const [resource, column] = zone.column.split('.') as [string, string];
  return { resource, column };
}

/** A value read from that column, as a zone: only one this runtime knows, so a typo in a row falls to the App's own. */
export function readerZone(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && zoneKnown(value) ? value.trim() : undefined;
}

export function zoneKnown(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/* A formatter is the expensive part of reading a zone's clock (it loads the zone's rules), and this runs on
   every request and per computed value. A zone the runtime refuses throws here, before anything is kept. */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(zone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (zoneFormats.size >= 64) zoneFormats.clear();
    zoneFormats.set(zone, format);
  }
  return format;
}

/**
 * "Now", as a wall clock in the app's zone: a Date whose local fields read
 * the zone's date and time, which is what `dateWindow` computes with. A
 * server in a UTC container serving a team in Sydney said "today" about
 * a day that had ended there hours ago. Absent zone means the server's own.
 */
export function zonedNow(zone: string | undefined, now: Date = new Date()): Date {
  if (!zone) return now;
  try {
    const parts = zoneFormat(zone).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'), now.getMilliseconds());
  } catch {
    return now;
  }
}
