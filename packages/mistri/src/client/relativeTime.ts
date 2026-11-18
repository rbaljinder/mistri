/**
 * "12 minutes ago", "in 3 hours": the largest whole unit, in the page's language. Shared by the console's moments and
 * the review queue's ages, so the two say a time the same way.
 */
import { shellRoot } from '@mistriwork/kit/client/shellHost.js';

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 1],
  ['minute', 60],
  ['hour', 3600],
  ['day', 86_400],
  ['month', 2_592_000],
  ['year', 31_536_000],
];

export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000),
    size = Math.abs(seconds);
  let unit: Intl.RelativeTimeFormatUnit = 'second',
    per = 1;
  for (const [name, length] of UNITS)
    if (size >= length) {
      unit = name;
      per = length;
    }
  const format = new Intl.RelativeTimeFormat(shellRoot().lang || undefined, { numeric: 'auto' });
  return size < 45 ? format.format(0, 'second') : format.format(Math.round(seconds / per), unit);
}
