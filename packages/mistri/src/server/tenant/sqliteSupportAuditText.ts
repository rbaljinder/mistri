/** Exact SQLite audit text: native TEXT projection can truncate at NUL or
 * replace malformed UTF-8. Compare the actual stored bytes before trusting it. */
type Fields = readonly (readonly [column: string, alias: string])[];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Fields are code-owned SQL column/alias pairs, never supplied by a request. */
export function auditTextProjection(fields: Fields): string {
  return fields
    .map(
      ([column], index) => `typeof(${quote(column)}) AS "__audit_type_${index}", CAST(${quote(column)} AS BLOB) AS "__audit_raw_${index}"`,
    )
    .join(', ');
}

export function captureAuditText(input: Record<string, unknown>, fields: Fields) {
  const row = { ...input };
  let exact = true;
  for (const [, alias] of fields) {
    // All aliases must be present even for nullable text columns.
    if (!Object.hasOwn(row, alias)) exact = false;
  }
  for (const [index, [, alias]] of fields.entries()) {
    const kind = row[`__audit_type_${index}`],
      raw = row[`__audit_raw_${index}`],
      value = row[alias];
    delete row[`__audit_type_${index}`];
    delete row[`__audit_raw_${index}`];
    if (kind === 'null') {
      if (raw !== null || value !== null) exact = false;
      continue;
    }
    if (kind !== 'text' || typeof value !== 'string' || !(raw instanceof Uint8Array)) {
      exact = false;
      continue;
    }
    try {
      const decoded = decoder.decode(raw);
      if (decoded.includes('\u0000') || decoded !== value || !Buffer.from(decoded, 'utf8').equals(raw)) exact = false;
    } catch {
      exact = false;
    }
  }
  return { row, exact };
}
