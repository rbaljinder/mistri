/** SQL DATE text only. No instant, timezone, BC, infinity or zero-date coercion. */
const year = '(?!0000)[0-9]{4}';
const leapYear = '(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[48]|[2468][048]|[13579][26])00)';
const date = `(?:${year}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|${leapYear}-02-29)`;
const pattern = `^${date}$(?![\\s\\S])`;
/* A command's `date()` also takes year 0000, a leap year in the proleptic calendar both it and RFC 3339 count in. */
const commandDate = `(?:${date}|0000-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|[12][0-9])))`;
/** The calendar dates a command's `date()` accepts, 0000-01-01 through 9999-12-31, as a JSON Schema pattern. */
export const COMMAND_DATE_PATTERN = `^${commandDate}$(?![\\s\\S])`;
const canonical = new RegExp(pattern);

export function apiDateCodec() {
  return Object.freeze({
    kind: 'date' as const,
    schema: Object.freeze({ type: 'string', minLength: 10, maxLength: 10, pattern }),
    encode(value: unknown): string {
      if (typeof value !== 'string' || !canonical.test(value))
        throw new TypeError('Expected a canonical Gregorian SQL DATE from 0001-01-01 through 9999-12-31.');
      return value;
    },
  });
}
