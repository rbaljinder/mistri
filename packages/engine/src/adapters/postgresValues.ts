/** PostgreSQL identifiers, connection labels, and JSON-safe result values. */
import { POSTGRES_STYLE } from '../shared/filter.js';
import { isRuntimeRelation as inRuntimeSchema, isRuntimeTable } from '../shared/runtimeTables.js';

/** Runtime state, by an adapter id that may carry the schema: anything in the runtime schema, and a
 * reserved name anywhere (an App table may not take one, so it is refused as runtime state too). */
export const isRuntimeRelation = (id: string): boolean => {
  const dot = id.indexOf('.');
  return (
    isRuntimeTable(id) || isRuntimeTable(id.slice(dot + 1)) || (dot > 0 && inRuntimeSchema('postgres', id.slice(0, dot), id.slice(dot + 1)))
  );
};

/** `schema.table`, both halves quoted. */
export function qualified(at: { schema: string; name: string }): string {
  return `${POSTGRES_STYLE.quote(at.schema)}.${POSTGRES_STYLE.quote(at.name)}`;
}

/** Keep the password out of the label, the logs and the UI. */
export function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return 'postgres';
  }
}

/**
 * The `pg` options for a connection URL. libpq's `sslrootcert=system` means
 * "verify against the system's CAs", which PlanetScale's own strings carry;
 * pg-connection-string reads every `sslrootcert` as a file path and fails on
 * `system`. Strip it and ask for a verified connection: Node checks the
 * certificate chain and the host name against its default roots, which is
 * verify-full. A string's own `sslmode` still wins, as it does for pg; none of
 * its values weakens this, because `disable` is the operator's word.
 */
export function pgConnectionOptions(connectionString: string): { connectionString: string; ssl?: { rejectUnauthorized: true } } {
  const at = connectionString.indexOf('?');
  if (at < 0 || !/(^|[?&])sslrootcert=system(&|$)/i.test(connectionString.slice(at))) return { connectionString };
  const query = connectionString
    .slice(at + 1)
    .split('&')
    .filter((pair) => !/^sslrootcert=system$/i.test(pair))
    .join('&');
  const stripped = connectionString.slice(0, at) + (query ? `?${query}` : '');
  // `disable` is the operator's word: the root is dropped but no TLS is asked for.
  if (/(^|&)sslmode=disable(&|$)/i.test(query)) return { connectionString: stripped };
  return { connectionString: stripped, ssl: { rejectUnauthorized: true } };
}

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
