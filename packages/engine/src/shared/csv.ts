/*
 * One CSV field and one JSON record, as an export writes them — shared, so
 * the file the browser writes from rows in hand and the file the server
 * streams (exportRoute.ts) are the same file, byte for byte.
 */

/* RFC 4180 §2.6: a field containing a comma, a quote or a line break must be
   quoted. CR and LF are listed separately because a lone CR inside a value is
   just as capable of splitting a record as a full CRLF. */
const NEEDS_QUOTES = /[",\r\n]/;

/* Excel, Sheets and LibreOffice all treat a cell beginning with one of these
   as a formula to evaluate rather than text to show — so a value like
   `=HYPERLINK(...)` or `@SUM(A1)` out of a database column becomes code the
   moment someone opens the file. Prefixing a single quote is the standard
   mitigation: spreadsheets show the rest as literal text.
   Tab and CR are included because they are skipped before the parse, which
   makes `\t=cmd` a formula too. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/* ...but `-5` and `+1.5e3` are numbers, not formulas, and prefixing them
   would corrupt every negative amount in the export to buy nothing. Only a
   leading sign that is *not* part of a plain number is dangerous. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export const CRLF = '\r\n';

/**
 * One CSV field.
 *
 * null and undefined emit nothing at all, while an empty string emits `""`.
 * That asymmetry is the whole point: `a,,b` and `a,"",b` are different
 * documents, and collapsing them means an export cannot tell you whether a
 * column was never set or set to blank — often the exact question the export
 * was taken to answer.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  // A JSON/JSONB column arrives as a parsed object; `String(obj)` would write
  // "[object Object]" into every row of it.
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  if (safe === '' || NEEDS_QUOTES.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/* A row's own value for a column, never one it inherits: an export's column
   list is the caller's, and `constructor` or `__proto__` named there would
   otherwise write out Object's own members as if they were data. */
const own = (row: Record<string, unknown> | undefined, name: string): unknown => (row && Object.hasOwn(row, name) ? row[name] : undefined);

/** One CSV record: the fields of `row` in `columns` order, without its line break. */
export function csvRecord(columns: readonly string[], row: Record<string, unknown> | undefined): string {
  return columns.map((name) => csvField(own(row, name))).join(',');
}

/**
 * One record as an export's JSON writes it: rebuilt from `columns` rather
 * than emitted as-is so the shape matches the CSV exactly — including a key
 * whose value is missing, which `JSON.stringify` would silently drop and
 * leave the two formats disagreeing about the row.
 */
export function jsonRecord(columns: readonly string[], row: Record<string, unknown> | undefined): Record<string, unknown> {
  /* No prototype, so a column called `__proto__` is a key like any other. */
  const out: Record<string, unknown> = Object.create(null);
  for (const name of columns) out[name] = own(row, name) ?? null;
  return out;
}
