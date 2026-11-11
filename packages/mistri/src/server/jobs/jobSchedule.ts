/**
 * When a time-based job is due: `every`, five cron fields — minute, hour, day
 * of month, month, day of week (0 or 7 is Sunday) — each `*`, a number, a
 * range `a-b`, a list `a,b` or a step `*\/n` and `a-b/n`, or one of the words
 * `@hourly`, `@daily`, `@weekly`, `@monthly`. Read on the wall clock of
 * `timezone` (an IANA name, UTC by default), so `0 6 * * 1-5` is six in the
 * morning where the business is, through daylight-saving changes.
 *
 * A slot is a minute the expression matches. The host enqueues each slot
 * once, keyed by its instant, so every process that runs the jobs agrees on
 * it and the job store keeps one run (jobHost.ts). A slot missed while no
 * process ran is not run late one by one: after a stop, the most recent slot
 * that passed runs once, and the ones before it are skipped. A store that
 * holds no run of the job has missed nothing: its first slot is the next.
 *
 * `timezone: 'tenant'` reads it on each tenant's own wall clock instead (a
 * tenant App's job per tenant): the zone its profile names through
 * `ui.timezone`, so `0 6 * * *` is six in the morning at each tenant. The
 * host groups the tenants by zone and keeps each zone's slots apart.
 */
const WORDS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const MINUTE = 60_000;
/* Eight years includes the leap-day gap across a century that is not a leap year. */
const HORIZON = 8 * 366 * 24 * 60;

export interface JobEvery {
  readonly text: string;
  readonly timezone: string;
  readonly fields: readonly ReadonlySet<number>[];
  /** Both day fields restricted: as cron has it, a day matches either. */
  readonly eitherDay: boolean;
  /** Read on each tenant's zone (`timezone: 'tenant'`): `timezone` is then a placeholder that `inZone` replaces. */
  readonly tenantZone?: true;
}

/** The same `every`, read on one zone's wall clock: a tenant-zone job's slots for the tenants in that zone. */
export function inZone(every: JobEvery, zone: string): JobEvery {
  const { tenantZone: _tenantZone, ...rest } = every;
  return Object.freeze({ ...rest, timezone: zone });
}

function field(text: string, [low, high]: [number, number], where: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error(`${where} "${part}" is not a number, a range, a list or a step.`);
    const from = match[1] === '*' ? low : Number(match[2]);
    const to = match[1] === '*' ? high : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? high : from;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < low || to > high || from > to || step < 1) throw new Error(`${where} "${part}" is outside ${low}-${high}.`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Read an `every` and its timezone; refused with what is wrong. `tenant`: a job's, which may say `'tenant'`, each
 * tenant's own zone. */
export function parseEvery(text: unknown, timezone: unknown = 'UTC', tenant = false): JobEvery {
  if (typeof text !== 'string' || !text.trim()) throw new Error('every is five cron fields, or @hourly, @daily, @weekly or @monthly.');
  if (tenant && timezone === 'tenant') return Object.freeze({ ...parseEvery(text, 'UTC'), tenantZone: true as const });
  if (typeof timezone !== 'string')
    throw new Error(`timezone is an IANA time zone name, such as America/New_York${tenant ? ", or 'tenant'" : ''}.`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`timezone "${timezone}" is not an IANA time zone name.`);
  }
  const expression = WORDS[text.trim()] ?? text.trim();
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) throw new Error(`every "${text}" is not five cron fields: minute, hour, day of month, month, day of week.`);
  const fields = parts.map((part, index) => field(part, BOUNDS[index], `every "${text}", field ${index + 1}`));
  if (fields[4].has(7)) fields[4].add(0);
  const eitherDay = parts[2] !== '*' && parts[4] !== '*';
  const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!eitherDay && ![...fields[3]].some((month) => [...fields[2]].some((day) => day <= monthDays[month - 1]))) {
    throw new Error(`every "${text}" matches no calendar date.`);
  }
  return Object.freeze({ text: text.trim(), timezone, fields: Object.freeze(fields), eitherDay });
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of `timezone` at an instant: minute, hour, day, month, weekday. */
function wall(instant: number, timezone: string): number[] {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    });
    formats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), weekday];
}

function matchesDay(every: JobEvery, parts: number[]): boolean {
  const [, , day, month, weekday] = parts;
  const [, , days, months, weekdays] = every.fields;
  if (!months.has(month)) return false;
  return every.eitherDay ? days.has(day) || weekdays.has(weekday) : days.has(day) && weekdays.has(weekday);
}

function slot(every: JobEvery, start: number, direction: 1 | -1): number | undefined {
  for (let distance = 0; distance <= HORIZON;) {
    const instant = start + direction * distance * MINUTE;
    const parts = wall(instant, every.timezone);
    const [minute, hour, day, month, weekday] = parts;
    if (matchesDay(every, parts)) {
      if (every.fields[0].has(minute) && every.fields[1].has(hour)) return instant;
    } else {
      // Skip only within the same local calendar day. Checking the far end
      // preserves midnight and daylight-saving boundaries, including zones
      // whose UTC offset contains half an hour or a quarter of an hour.
      const end = wall(instant + direction * 59 * MINUTE, every.timezone);
      if (end[2] === day && end[3] === month && end[4] === weekday) {
        distance += 60;
        continue;
      }
    }
    distance++;
  }
  return undefined;
}

/** The most recent matching slot, including annual and leap-day schedules. */
export function latestSlot(every: JobEvery, now: number): number | undefined {
  return slot(every, Math.floor(now / MINUTE) * MINUTE, -1);
}

/** The first matching slot strictly after the supplied instant. */
export function nextSlot(every: JobEvery, after: number): number | undefined {
  return slot(every, Math.floor(after / MINUTE) * MINUTE + MINUTE, 1);
}
