/**
 * An amount a person types, or a CSV cell holds, read back as the whole number
 * of minor units a `minor: true` money column stores (money.ts says why). A
 * module of its own so it loads with what takes a typed amount — a money box,
 * an import — and not with every list that only says one.
 */
import { currencyDigits } from './money.js';

/**
 * A major amount — a number, or decimal text with a point ("19.99", "-5",
 * ".5") — as the whole number of minor units it is, written out in digits
 * ("1999"), or undefined when it is no amount or says more decimals than the
 * currency has: 19.999 dollars is a typo, not a value to round. Text to text,
 * never through a float, so an amount past 2^53 stays exact.
 */
export function majorToMinorText(major: number | string, currency: string): string | undefined {
  const text = typeof major === 'number' ? (Number.isFinite(major) ? String(major) : '') : major.trim();
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return undefined;
  const digits = currencyDigits(currency);
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  if (fraction.length > digits) return undefined;
  const whole = `${m[2]}${fraction.padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  return m[1] === '-' && whole !== '0' ? `-${whole}` : whole;
}

/** The same amount as a number of minor units, or undefined past 2^53 too (use majorToMinorText there). */
export function majorToMinor(major: number | string, currency: string): number | undefined {
  const text = majorToMinorText(major, currency);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}
