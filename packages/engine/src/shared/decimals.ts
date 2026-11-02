/**
 * Decimal columns said exactly: the scale a declared type asks for, and an
 * exact SQLite sum over one.
 *
 * PostgreSQL's `numeric` is exact and `SUM` over it is too, read as text by
 * `pg`. SQLite stores `numeric(12,2)` as an integer or a REAL and sums it as
 * a REAL, so 0.10 + 0.20 + 0.07 + 100,000,000,000,000.00 came back as
 * `100000000000000.38`. Summed here as whole hundredths instead — each value
 * times 10^scale, rounded once to an integer, added as integers — and said
 * with the column's places, as PostgreSQL says it, the two engines agree to
 * the cent. Exact while each REAL value times 10^scale is below 2^53 (SQLite
 * keeps a number with a fraction as a REAL, whose whole units stop there), an
 * integer value times 10^scale and the total fit 2^63. Past either, no answer
 * is the right one, so none is given: the sum says it is beyond exact range
 * (`ExactnessRefusal`), where it once answered 10.223372036854775808 for
 * 10 + 0.5. SQLite's own `integer overflow` of a total is the same refusal.
 */
import { RequestFault } from './refusal.js';

/** The sum of a decimal column SQLite cannot add exactly: a data or schema fault (a column declared with more
    places than SQLite can hold), never worth a retry. */
class ExactnessRefusal extends RequestFault {
  constructor(columns: readonly string[]) {
    const named = columns.length ? columns.map((column) => `"${column}"`).join(', ') : 'a decimal column';
    super(
      `The sum of ${named} is beyond what SQLite adds exactly: a value times 10^places passes 2^53 (a REAL) or 2^63 (an integer), ` +
        'or the total passes 2^63. Declare fewer places, hold smaller values, or run the App on PostgreSQL.',
      { columns },
    );
    this.name = 'ExactnessRefusal';
  }
}

/** What an exact sum says in place of a number when it cannot be exact; `refuseInexact` turns it into the refusal. */
const INEXACT = '\u001finexact\u001f';

const DECLARED_SCALE = /^\s*(?:decimal|numeric)\s*\(\s*\d+\s*,\s*(\d+)\s*\)\s*$/i;

/** The scale a declared type asks for, when it is a DECIMAL/NUMERIC with one above zero. */
export function declaredScale(type: string | null | undefined): number {
  if (!type) return 0;
  const scale = Number(DECLARED_SCALE.exec(type)?.[1] ?? 0);
  return scale > 0 ? scale : 0;
}

/** The most places an exact sum says: 10^18 is the largest power of ten a SQLite integer holds. */
const MOST_PLACES = 18;

/** Whether a SQLite sum over a column of this declared type is summed exactly (`exactSqliteSum`). */
export const sumsExactly = (type: string | null | undefined): boolean => {
  const scale = declaredScale(type);
  return scale > 0 && scale <= MOST_PLACES;
};

/**
 * A SQLite column of `scale` places summed as an integer count of its
 * smallest unit: `total` is that integer (for ordering by it), `text` the
 * decimal it says, null over no rows as `SUM` is. `read` is the column's
 * expression; the scale is a number read off the catalog, never a request's
 * text.
 */
export function exactSqliteSum(read: string, scale: number, label = ''): { total: string; text: string } {
  if (!Number.isInteger(scale) || scale < 1 || scale > MOST_PLACES) throw new RangeError(`An exact sum takes 1 to ${MOST_PLACES} places.`);
  const unit = `1${'0'.repeat(scale)}`;
  /* A value stored as an integer is multiplied as one, exactly; a REAL is
     rounded once to the nearest unit, which is what the column meant. */
  const total = `SUM(CASE WHEN typeof(${read}) = 'integer' THEN ${read} * ${unit} ELSE CAST(ROUND(${read} * ${unit}) AS INTEGER) END)`;
  /* A REAL past 2^53 units is rounded to a neighbor before it is added, and a total that is no longer an integer
     is an integer product that overflowed into a REAL: neither is the sum, so the cell says so instead. */
  const beyond = `SUM(CASE WHEN typeof(${read}) = 'real' AND abs(${read} * ${unit}) >= 9007199254740992 THEN 1 ELSE 0 END) > 0`;
  const text =
    `CASE WHEN ${total} IS NULL THEN NULL ` +
    `WHEN ${beyond} OR typeof(${total}) <> 'integer' THEN '${INEXACT}' || '${label.replaceAll("'", "''")}' ELSE ` +
    `(CASE WHEN ${total} < 0 THEN '-' ELSE '' END) || printf('%d.%0${scale}d', abs(${total}) / ${unit}, abs(${total}) % ${unit}) END`;
  return { total, text };
}

/** The columns a list of measures sums, for the refusal to name. */
export const summed = (measures: readonly { fn?: string; path?: string; column?: string }[] | undefined): string[] =>
  (measures ?? []).flatMap((measure) =>
    measure.fn === 'sum' && (measure.path ?? measure.column) ? [(measure.path ?? measure.column)!] : [],
  );

/**
 * Runs a SQLite read whose rows may hold exact sums: a cell that says it was beyond exact range, or SQLite's own
 * `integer overflow` while adding, is the refusal, naming the columns summed (`columns`).
 */
export async function readExactly<T extends { rows: readonly Record<string, unknown>[] }>(
  run: () => Promise<T>,
  columns: readonly string[],
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (columns.length && error instanceof Error && /integer overflow/i.test(error.message)) throw new ExactnessRefusal(columns);
    throw error;
  }
  const found = new Set<string>();
  for (const row of result.rows)
    for (const value of Object.values(row))
      if (typeof value === 'string' && value.startsWith(INEXACT)) found.add(value.slice(INEXACT.length));
  if (found.size) throw new ExactnessRefusal([...found].filter(Boolean).length ? [...found].filter(Boolean) : columns);
  return result;
}

/* ---------- exact decimal text in the server ---------- */

const DECIMAL_TEXT = /^(-)?(\d+)(?:\.(\d+))?$/;

/** A decimal as an integer count of units and its places, or undefined when the text is not a plain decimal. */
export function parseDecimal(value: string | number | bigint): { units: bigint; scale: number } | undefined {
  if (typeof value === 'bigint') return { units: value, scale: 0 };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value)) return Number.isSafeInteger(value) ? { units: BigInt(value), scale: 0 } : undefined;
    value = String(value);
    if (/e/i.test(value)) return undefined;
  }
  const match = DECIMAL_TEXT.exec(value.trim());
  if (!match) return undefined;
  const places = match[3] ?? '';
  const units = BigInt(`${match[2]}${places}`);
  return { units: match[1] ? -units : units, scale: places.length };
}

/** An integer count of units said with `scale` places: `formatDecimal(-5n, 2)` is `-0.05`. */
export function formatDecimal(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative && /[1-9]/.test(digits) ? `-${whole}` : whole;
}

/** `units / divisor`, rounded half to even: the banker's rounding, so ties do not drift one way. */
function divideHalfEven(units: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new RangeError('Division by zero.');
  if (divisor < 0n) return divideHalfEven(-units, -divisor);
  let quotient = units / divisor;
  const remainder = units - quotient * divisor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n !== 0n)) quotient += remainder < 0n ? -1n : 1n;
  return quotient;
}

/** The mean of an exact sum over `count` values, said with `places` places, rounded half to even. */
export function exactAverage(sum: string | number | bigint, count: number | bigint, places: number): string | undefined {
  const parsed = parseDecimal(sum);
  if (!parsed) return undefined;
  const n = BigInt(count);
  if (n <= 0n) return undefined;
  /* sum / count at `places` places: units · 10^(places − scale) / count, with the shift folded into whichever side keeps it whole. */
  const shift = places - parsed.scale;
  const numerator = shift >= 0 ? parsed.units * 10n ** BigInt(shift) : parsed.units;
  const denominator = shift >= 0 ? n : n * 10n ** BigInt(-shift);
  return formatDecimal(divideHalfEven(numerator, denominator), places);
}
