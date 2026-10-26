/* The small pure pieces the MySQL adapter hands its statements and rows:
   a qualified name, a row count the driver will bind, a label without the
   password, and values JSON can carry. Split from mysql.ts, which keeps the
   connections and the statements themselves. */
import { MYSQL_STYLE } from './adapter.js';

export interface Located {
  schema: string;
  name: string;
  isView: boolean;
}

/** `` `shop`.`invoice` `` — two identifiers, never one containing a dot. */
export function qualify(table: Located): string {
  return `${MYSQL_STYLE.quote(table.schema)}.${MYSQL_STYLE.quote(table.name)}`;
}

/**
 * A row count on its way into a placeholder, as digits rather than a number.
 *
 * mysql2 encodes every JavaScript number in the prepared-statement protocol as
 * a DOUBLE, and MySQL refuses a DOUBLE where it wants a row count: `LIMIT ?`
 * bound to 20 fails with ER_WRONG_ARGUMENTS (1210) instead of returning twenty
 * rows. A decimal string is sent as VAR_STRING, which the server converts, and
 * the alternative — writing the number into the statement text — would put a
 * value in the SQL for the sake of a driver quirk.
 *
 * Safe by construction rather than by escaping: the only callers pass the
 * output of `clampLimit` or `clampOffset`, which are integers this process
 * computed and never anything a user typed.
 */
export function rowCount(n: number): string {
  return String(Math.floor(n));
}

/**
 * The same fix, applied to a statement `compileView` built.
 *
 * The view compiler ends every statement it produces with `LIMIT ? OFFSET ?`
 * and pushes the two clamped integers last. Matching on the text rather than
 * trusting that is what makes this exact: if the compiler ever stops emitting
 * that tail, the parameters are left alone and the failure is a loud one from
 * the server, not a filter value quietly changing type.
 */
export function bindRowCounts(text: string, params: unknown[]): unknown[] {
  if (params.length < 2 || !/LIMIT \?\s+OFFSET \?\s*$/.test(text)) return params;
  const out = [...params];
  const tail = out.length - 2;
  if (typeof out[tail] !== 'number' || typeof out[tail + 1] !== 'number') return params;
  out[tail] = rowCount(out[tail] as number);
  out[tail + 1] = rowCount(out[tail + 1] as number);
  return out;
}

/** Keep the password out of the label, the logs and the UI. */
export function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return 'mysql';
  }
}

/** BigInt and Buffer are common in drivers and neither survives JSON. */
/** One value, made safe to send as JSON. See `toJsonSafe` for the row form. */
export function valueSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** As toJsonSafe, but a blob stays its bytes: a file download asked for them (`QueryRequest.binary`). */
export function withBytes(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? value : valueSafe(value)]));
}

export function toJsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v instanceof Uint8Array) out[k] = `<${v.byteLength} bytes>`;
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}
