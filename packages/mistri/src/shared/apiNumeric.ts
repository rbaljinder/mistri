/** Draft wire building blocks, not a selected API or adapter policy.
 * Encoders take normalized adapter values (number|string), never attempt to
 * recover precision from an unsafe number, and publish the schema they obey.
 * Decimal/money and database-specific range selection are separate concerns. */

interface NumericCodec<T> {
  readonly schema: Readonly<
    | { type: 'integer' | 'number'; minimum: number; maximum: number }
    | { type: 'string'; pattern: string; minLength: number; maxLength: number }
  >;
  readonly encode: (value: unknown) => T;
}

const MIN_INT64 = -9223372036854775808n,
  MAX_INT64 = 9223372036854775807n;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$(?![\s\S])/;
const invalidInteger = (): never => {
  throw new TypeError('Expected an exact signed 64-bit integer in the selected representation.');
};

/** Positive canonical decimal integers up to one fixed positive bound.
 * Prefix alternatives encode the bound itself, not just a digit-count cap. */
function positivePattern(maximum: string): string {
  const alternatives: string[] = [];
  if (maximum.length > 1) alternatives.push(`[1-9][0-9]{0,${maximum.length - 2}}`);
  for (let i = 0; i < maximum.length; i++) {
    const low = i === 0 ? 1 : 0,
      high = Number(maximum[i]) - 1;
    if (high < low) continue;
    const digit = low === high ? String(low) : `[${low}-${high}]`;
    const remaining = maximum.length - i - 1;
    alternatives.push(`${maximum.slice(0, i)}${digit}${remaining ? `[0-9]{${remaining}}` : ''}`);
  }
  alternatives.push(maximum);
  return `(?:${alternatives.join('|')})`;
}

// JavaScript `$` alone also matches before a final newline; require actual EOF.
const INT64_PATTERN = `^(?:0|${positivePattern(String(MAX_INT64))}|-${positivePattern(String(-MIN_INT64))})$(?![\\s\\S])`;

function exactInteger(value: unknown): bigint {
  let integer: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return invalidInteger();
    integer = BigInt(value);
  } else if (typeof value === 'string' && value.length <= 20 && CANONICAL_INTEGER.test(value)) integer = BigInt(value);
  else return invalidInteger();
  if (integer < MIN_INT64 || integer > MAX_INT64) return invalidInteger();
  return integer;
}

/** Explicit strategy only: no default dialect or public wire decision.
 * The number strategy refuses int64 values outside JavaScript's safe range.
 * Decimal-string supports the full signed-int64 range with no rounding. */
export function int64Codec(representation: 'number'): NumericCodec<number>;
export function int64Codec(representation: 'decimal-string'): NumericCodec<string>;
export function int64Codec(representation: 'number' | 'decimal-string'): NumericCodec<number | string> {
  if (representation !== 'number' && representation !== 'decimal-string') throw new TypeError('Choose an explicit integer representation.');
  if (representation === 'decimal-string')
    return Object.freeze({
      schema: Object.freeze({ type: 'string' as const, pattern: INT64_PATTERN, minLength: 1, maxLength: 20 }),
      encode(value: unknown) {
        return exactInteger(value).toString();
      },
    });
  return Object.freeze({
    schema: Object.freeze({ type: 'integer' as const, minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    encode(value: unknown) {
      const integer = exactInteger(value);
      if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) return invalidInteger();
      return Number(integer);
    },
  });
}

/** Existing finite JS numbers only. This makes no exact-decimal or money
 * promise, and will not interpret a decimal string as a floating-point value. */
export function finiteNumberCodec(): NumericCodec<number> {
  return Object.freeze({
    schema: Object.freeze({ type: 'number' as const, minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
    encode(value: unknown) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite number.');
      return value;
    },
  });
}
