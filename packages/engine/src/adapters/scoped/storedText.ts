/**
 * A stored row's reference columns as PostgreSQL's own text, read in the statement that reads the row.
 *
 * A scoped write checks the parent a reference points at by binding the value as text, read by the column's type
 * (scopedTransaction.ts parentChecks). A value the person gives is bound as given. A value taken from a STORED row was
 * the driver's JavaScript reading of it, and for some types that reading loses what the key compares by (an array's
 * lower bounds, a jsonb number past 2^53): an update that set the other column of a composite reference was checked
 * against the visible parent the lossy value named, and committed onto the hidden one the stored value names. Those
 * types are no longer keys at all (keyTypes.ts); for the ones that are, the driver's reading is the text already, and
 * the text is still what is bound: every stored value a check takes is read as `col::text` beside the row, so what
 * PostgreSQL said is what it reads back, in the one session whose date style the transaction pins (postgres.ts).
 *
 * The texts ride with the row object they were read with (a WeakMap, never a column of it: the row a write's images,
 * its trigger proof and what it announces see is the row as read), and a row made from a stored one carries those of
 * its columns it took unchanged (`overlaid`, `withStoredText`).
 */
import type { DatabaseSchema, TableMeta } from '../../shared/schema.js';

type Row = Record<string, unknown>;
/** Each column's stored text, or null where it is NULL. */
type StoredTexts = Readonly<Record<string, string | null>>;

const TEXTS = new WeakMap<object, StoredTexts>();

/**
 * What a read of `table` also selects for its reference columns' stored text, on PostgreSQL: the columns any foreign
 * key of the table references from, and the name the object of their texts is selected as, one no column of the table
 * has. Undefined where there are none, or on another engine: SQLite's driver reads a stored value as it is.
 */
export function storedTextOf(schema: DatabaseSchema, table: TableMeta): { alias: string; columns: readonly string[] } | undefined {
  if (schema.dialect !== 'postgres') return undefined;
  const referencing = new Set(schema.foreignKeys.filter((fk) => fk.from.table === table.id).flatMap((fk) => fk.from.columns));
  const columns = table.columns.map((column) => column.name).filter((name) => referencing.has(name));
  if (!columns.length) return undefined;
  let alias = '?stored text';
  while (table.columns.some((column) => column.name === alias)) alias = `?${alias}`;
  return { alias, columns };
}

/**
 * The select-list item that reads `columns` as text, as one jsonb object (a string or null each, which the driver
 * reads exactly). Built in pieces of fifty pairs, a function's argument limit being a hundred.
 */
export function storedTextSelect(columns: readonly string[], quote: (name: string) => string): string {
  const pieces: string[] = [];
  for (let at = 0; at < columns.length; at += 50)
    pieces.push(
      `pg_catalog.jsonb_build_object(${columns
        .slice(at, at + 50)
        // An escape string, read alike whatever standard_conforming_strings says.
        .map((name) => `E'${name.replaceAll('\\', '\\\\').replaceAll("'", "''")}'::pg_catalog.text, ${quote(name)}::pg_catalog.text`)
        .join(', ')})`,
    );
  return pieces.join(' OPERATOR(pg_catalog.||) ');
}

/** `row` without the texts `spec` selected, those kept beside it. A row read without them is returned as it is. */
export function detachStoredText(spec: { alias: string } | undefined, row: Row): Row {
  if (!spec || !Object.hasOwn(row, spec.alias)) return row;
  const { [spec.alias]: said, ...rest } = row;
  const texts: Record<string, string | null> = {};
  if (said && typeof said === 'object' && !Array.isArray(said))
    for (const [column, text] of Object.entries(said)) if (typeof text === 'string' || text === null) texts[column] = text;
  TEXTS.set(rest, texts);
  return rest;
}

/** The stored texts read with `row`, or carried to it from the row it was made from. */
export const storedText = (row: object | null | undefined): StoredTexts | undefined => (row ? TEXTS.get(row) : undefined);

/** `row`, carrying `texts`: each for a column `row` holds. */
export function withStoredText<T extends object>(row: T, texts: StoredTexts | undefined): T {
  if (texts) TEXTS.set(row, Object.fromEntries(Object.entries(texts).filter(([column]) => Object.hasOwn(row, column))));
  return row;
}

/** A stored row with `given` written over it: it keeps the texts of the columns `given` leaves as stored. */
export function overlaid(stored: Row, given: Row | undefined): Row {
  const texts = storedText(stored);
  const row = { ...stored, ...(given ?? {}) };
  return texts
    ? withStoredText(row, Object.fromEntries(Object.entries(texts).filter(([column]) => !Object.hasOwn(given ?? {}, column))))
    : row;
}
