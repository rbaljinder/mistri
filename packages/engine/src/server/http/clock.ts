/**
 * App logic's clock: what a command's `now()`, a loader, a dashboard's "last 30 days", a job's due check and a
 * stamp an action writes read. The real time, unless
 *
 * - a test has pinned it: MISTRI_CLOCK holds an instant the browser suite fixes so that "last 90 days" over a
 *   database seeded for a known day reads the same on every run, and a stamp an action writes ('now') is the same
 *   instant on every run. Never set in use.
 * - a development or test process was started as of another moment (`mistri dev --as-of 2026-01-05`, or
 *   MISTRI_AS_OF): the clock then reads that moment at start and moves on in real time from it, so seed data dated
 *   for one day reads as it was written on every later one. A field report: moving the machine's clock instead
 *   broke sign-in, and moving the browser's paused a tenant's access.
 *
 * Only App logic reads it. Sign-in, sessions, one-time codes, tokens and their expiry, rate limits, the read audit,
 * receipts and history, caches and the job scheduler's own timers keep the real clock, so an as-of moment never
 * expires a session or holds a lease past its time.
 */
import { appClockOffset, setAppClockOffset } from '../../shared/appClock.js';
import { productEnv } from '../product.js';

/**
 * The pin wins over an as-of moment: a browser suite that pins the clock asks for the same instant on every run, and
 * an offset from the real time would undo that.
 */
export function clockNow(): Date {
  const pinned = productEnv('CLOCK');
  if (!pinned) return appTime();
  const at = new Date(pinned);
  return Number.isNaN(at.getTime()) ? appTime() : at;
}

/**
 * A real instant as App logic reads it: moved by the as-of offset. For code handed a real clock (a tenant
 * deployment's, a job host's) and for a default that read `new Date()`; it never applies the MISTRI_CLOCK pin, so
 * what read the real time under the browser suite still does.
 */
export function appTime(real: number | Date = Date.now()): Date {
  return new Date((typeof real === 'number' ? real : real.getTime()) + appClockOffset());
}

/** The as-of offset in milliseconds, 0 for the real clock: what an App's chrome carries to the browser. */
export { appClockOffset };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** How far `zone`'s wall clock stands ahead of UTC at `at`, in milliseconds. */
function zoneAhead(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall clock (its fields read as UTC) names in `zone`; asked twice so a daylight-saving edge settles. */
function wallIn(zone: string | undefined, wall: number): number {
  if (!zone || zone === 'UTC') return wall;
  try {
    const first = wall - zoneAhead(zone, wall);
    return wall - zoneAhead(zone, first);
  } catch {
    return wall;
  }
}

/**
 * The moment an as-of value names, or undefined when it names none. A date alone (2026-01-05) is midnight in
 * `zone` (the caller passes the App's declared zone, else the server's own; UTC when none is given at all);
 * a date and time without an offset (2026-01-05T09:30) is that wall clock in the same zone; one with an offset
 * (…Z, …-05:00) is that instant.
 */
export function parseAsOf(given: string, zone?: string): Date | undefined {
  const text = given.trim();
  const day = DATE.exec(text);
  const timed = day ? undefined : DATE_TIME.exec(text);
  const m = day ?? timed;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s, ms] = timed
    ? [Number(timed[4]), Number(timed[5]), Number(timed[6] ?? 0), Number((timed[7] ?? '0').padEnd(3, '0'))]
    : [0, 0, 0, 0];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(wall);
  /* 2026-02-30 is not a day, and 24:00 not an hour: Date.UTC would roll either over without a word. */
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    s > 59
  )
    return undefined;
  const offset = timed?.[8];
  if (offset === undefined) return new Date(wallIn(zone, wall));
  if (offset === 'Z') return new Date(wall);
  const sign = offset.startsWith('-') ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  return new Date(wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000);
}

interface AsOfProcess {
  /** The process is `mistri dev` (`--dev`). */
  readonly dev: boolean;
  /** The process serves a build, which is what is deployed. */
  readonly build?: boolean;
  /**
   * The App's declared zone, which a date alone is midnight in. Undefined (the Apps name none, or differ) is the
   * server's own zone: it is the one a query's `today` is counted in for an App that names none (zonedNow), so
   * `--as-of 2026-01-05` on a laptop in Chicago reads the 5th as today, not the 4th.
   */
  readonly zone?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The real time to count the offset from; the real clock's when absent. */
  readonly now?: number;
}

/**
 * Read the as-of moment the flag or MISTRI_AS_OF asks for (the flag wins), and set App logic's clock to start at
 * it. Development and tests only: refused, with a message naming what asked, under NODE_ENV=production, when
 * serving a build, and in any process that is neither `mistri dev` nor NODE_ENV=test — never ignored, since a
 * server quietly running on another day's clock is worse than one that will not start. Returns the moment, or
 * undefined when nothing asked for one.
 */
export function configureAsOf(flag: string | undefined, asked: AsOfProcess): Date | undefined {
  const env = asked.env ?? process.env;
  const given = flag ?? env.MISTRI_AS_OF;
  if (given === undefined || (flag === undefined && given.trim() === '')) return undefined;
  const source = flag !== undefined ? '--as-of' : 'MISTRI_AS_OF';
  const refused =
    env.NODE_ENV === 'production'
      ? 'NODE_ENV is production'
      : asked.build
        ? 'this serves a build, which is what is deployed'
        : !asked.dev && env.NODE_ENV !== 'test'
          ? 'this is neither mistri dev nor a test process (NODE_ENV=test)'
          : undefined;
  if (refused)
    throw new Error(
      `${source} moves App logic's clock for development and tests (mistri dev, or NODE_ENV=test), and ${refused}. ` +
        `Remove ${source} to serve.`,
    );
  const at = parseAsOf(given, asked.zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (!at)
    throw new Error(
      `${source} takes a date (2026-01-05, midnight in the App's zone) or a date and time (2026-01-05T09:30, ` +
        `or with an offset, 2026-01-05T09:30Z); it got "${given}".`,
    );
  setAppClockOffset(at.getTime() - (asked.now ?? Date.now()));
  return at;
}
