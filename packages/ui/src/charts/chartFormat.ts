/**
 * How a chart reads a value off a row and says a number, with no drawing in it: what counts as an absent reading,
 * which digits a `Number` cannot hold, and the default words for a figure. Shared by the declarative dashboard
 * charts (the kit's) and the free-form page charts (`charts.ts`). No React and no DOM.
 */
import { resolveLocale } from '../internal/locale.js';

/** A plotted value as read from a row: where it stands on the scale, and how it is said when a number cannot hold it. */
export interface ChartReading {
  /** The scale position, or `null` for a reading that is absent (missing, null, empty, or not a number). */
  value: number | null;
  /** The digits as written, kept when a `Number` would round them (beyond 2^53, or past 15 significant digits). */
  exact?: string;
}

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/* An absent reading is not a zero. Read as 0 it drew a line down to the baseline and printed "0" in the table, which
   is a measurement nobody took (`Number(null)` and `Number('')` are both 0, which is how it happened). A string of
   digits a double cannot hold keeps its text for the same reason: the plot may approximate, the words may not. */
export function readChartValue(raw: unknown): ChartReading {
  if (typeof raw === 'number') return { value: Number.isFinite(raw) ? raw : null };
  if (typeof raw === 'bigint') {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? { value } : { value, exact: raw.toString() };
  }
  if (typeof raw !== 'string') return { value: null };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { value: null };
  if (!PLAIN_DECIMAL.test(trimmed)) return { value };
  const significant = trimmed.replace('-', '').replace('.', '').replace(/^0+/, '').length;
  const lossy = trimmed.includes('.') ? significant > 15 : !Number.isSafeInteger(value);
  return lossy ? { value, exact: trimmed } : { value };
}

/** Say a digit string no `Number` can hold, grouped for the locale, without passing it through a double. */
export function formatExactNumeric(exact: string, locale?: string, options: Intl.NumberFormatOptions = {}): string {
  try {
    return new Intl.NumberFormat(resolveLocale(locale), { maximumFractionDigits: 20, ...options }).format(
      exact as Intl.StringNumericLiteral,
    );
  } catch {
    return exact;
  }
}

/** A figure in a chart's default words: grouped, at most one decimal, compact from ten thousand up. */
export function formatChartNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '0';
  const tag = resolveLocale(locale);
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value);
}

/*
 * A shorter way to say a value axis's ticks where `format` is a number between fixed words: the compact form
 * ("12K") between whatever the format writes before and after the digits (a currency sign, a unit), read off the
 * largest tick. Only for a format that says the tick's own number; one that converts it (minor units, a duration)
 * has no compact form this can know.
 */
export function compactAround(ticks: ReadonlyArray<number>, format: (tick: number) => string, locale?: string): (tick: number) => string {
  const largest = ticks.reduce((most, tick) => (Math.abs(tick) > Math.abs(most) ? tick : most), 0);
  const around = /^[-−]?(\D*)\d.*?(\D*)$/.exec(format(Math.abs(largest)));
  const before = around && around[1]!.length <= 4 ? around[1]! : '';
  const after = around && around[2]!.length <= 4 ? around[2]! : '';
  const compact = new Intl.NumberFormat(resolveLocale(locale), { notation: 'compact', maximumFractionDigits: 1 });
  return (tick) => `${tick < 0 ? '−' : ''}${before}${compact.format(Math.abs(tick))}${after}`;
}
