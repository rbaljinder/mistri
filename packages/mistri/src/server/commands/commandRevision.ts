/**
 * A record's revision, as a command checks it: the opaque number a form, a
 * selection or an API caller holds from when it read the record, and that
 * the command compares again inside its transaction before the handler runs,
 * so a change made in between is refused as `stale_record` instead of being
 * written over.
 *
 * No table needs a version column for it. A target with a non-null integer
 * column named `version` uses it as its revision (`versionColumn`), and
 * `db.update` advances it on every write; any other target's revision is a
 * digest of the row as it reads now —
 * every column, key included — so any change to the row is a new revision
 * and no change is the same one. The handler's own writes still compare and
 * set on the values it read (commandDb.ts), so the revision guards what the
 * person saw and the writes guard what the handler read.
 *
 * The digest is 52 bits of SHA-256, a safe integer, so it travels where an
 * integer revision always has: the command envelope's `expectedVersion`, an
 * API request's `If-Match: "…"`, a selection's `expectedVersions`. Callers
 * never see how it was made. Revision reads retain binary bytes, which are
 * digested separately before canonicalization so equal-length replacements
 * change the revision without expanding a large attachment into JSON.
 */
import { createHash } from 'node:crypto';
import { canonicalCommandJson } from './commandPayload.js';

/** The one name a target's revision column goes by: a table that has it holds its own revision, and nothing is declared. */
const VERSION_COLUMN = 'version';
const INTEGER_TYPE = /^(?:tinyint|smallint|mediumint|int(?:eger|2|4|8)?|bigint)(?:\s*\(\s*\d+\s*\))?(?:\s+unsigned)?$/i;

/** The revision column of a table, if it has one: a non-null integer `version`. Otherwise its revision is the row's digest. */
export function versionColumn(
  columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[] | undefined,
): string | undefined {
  const column = columns?.find((item) => item.name === VERSION_COLUMN);
  return column && !column.nullable && INTEGER_TYPE.test(column.type.trim()) ? VERSION_COLUMN : undefined;
}

/** The columns a revision is read from: the declared version column, or the whole row (undefined: every column the reader has). */
export const revisionColumns = (versionField?: string): string[] | undefined => (versionField === undefined ? undefined : [versionField]);

/**
 * A row's revision: its version column's value, or the digest of the row as
 * read. Both prepare and execution read the target through the command's own
 * reader, so the digest covers the same columns on both sides. Undefined when
 * the row holds none.
 */
export function rowRevision(row: Readonly<Record<string, unknown>>, versionField?: string): number | undefined {
  if (versionField !== undefined) {
    const value = row[versionField];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  let json: string;
  try {
    // Tag every value so a JSON column cannot impersonate a binary digest.
    const values = Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        value instanceof Uint8Array ? ['bytes', createHash('sha256').update(value).digest('hex')] : ['value', value],
      ]),
    );
    json = canonicalCommandJson(values, 1 << 22);
  } catch {
    return undefined;
  }
  return parseInt(createHash('sha256').update(json).digest('hex').slice(0, 13), 16);
}
