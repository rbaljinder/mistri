/**
 * The one spelling of "how long" in the App DSL: a whole number and a unit,
 * `'30 seconds'`, `'5 minutes'`, `'12 hours'`, `'3 days'`, `'2 weeks'`. A
 * machine's timer, a workflow's sleep, retry and timeout, an HMAC's timestamp
 * window, a saved form's resume and an experiment's conversion window
 * all read it here, so a duration an author learns once
 * works everywhere; each caller says only how long is too long (or too short)
 * for it.
 */
const UNITS: Readonly<Record<string, number>> = Object.freeze({
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
});

/** What a refusal says a duration is, to finish its own sentence. */
export const DURATION_WORDS = "a whole number and seconds, minutes, hours, days or weeks, like '30 seconds' or '3 days'";

/** A duration in milliseconds, or undefined for anything that is not `'<n> <unit>'`. Zero reads as zero; a caller that needs more refuses it. */
export function parseDuration(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^\s*(\d{1,9})\s+(second|minute|hour|day|week)s?\s*$/.exec(value) : null;
  return match ? Number(match[1]) * UNITS[match[2]] : undefined;
}
