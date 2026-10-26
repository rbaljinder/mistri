/**
 * Commons' clock: New York's, the App's zone (app.ts `timezone`).
 *
 * A timestamp column keeps no zone, and a moment without one is read as the wall
 * clock it was written in, in the App's zone. So the seed's day is New York's
 * today, and a wall time becomes the instant the record history stores by way
 * of that zone: read as UTC, an evening post would be tomorrow's.
 */
const ZONE = 'America/New_York';

/** Today in New York as `YYYY-MM-DD`. */
export const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

/** The instant a New York wall time (`YYYY-MM-DD HH:MM:SS`) is, as an ISO string. */
export function wallInstant(wall) {
  const [day, time = '00:00:00'] = String(wall).split(/[ T]/);
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const part = (type) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const offset = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - guess;
  return new Date(guess - offset).toISOString();
}
