/**
 * The MySQL catalog's epoch: one statement, cheap enough to ask on every
 * request, whose answer moves whenever anything `introspect()` reads does.
 *
 * PostgreSQL gets its epoch from an event trigger and SQLite from
 * `schema_version`; MySQL has neither, and provisioning an object in the
 * user's database is not a price a read-only browser may ask. What it does
 * have is a data dictionary (8.0, and MariaDB's own tables) that
 * `information_schema` reads without touching a table, so the epoch is a
 * digest of exactly the rows introspection reads — tables and their kind and
 * comment, columns with every attribute surfaced, index parts, foreign-key
 * parts and their rules. It is the same facts under one statement and one
 * round trip instead of five queries that build objects from them, which is
 * what makes a warm request cheap: `schema()` asks this, and derives again
 * only when the answer differs (epochCache.ts: a moved epoch is a miss).
 *
 * Deliberately not read: `TABLE_ROWS`, `UPDATE_TIME` and the other
 * statistics, which move with every write and would make the epoch a clock.
 * A table's approximate size in the sidebar is as old as the last real
 * schema change, as it was before.
 *
 * Each row is hashed (MD5, the first 64 bits) and the hashes are summed and
 * xor-ed with the row count, so reordering never matters, a row added or
 * removed always does, and two changes cancelling each other would take a
 * 2^-64 coincidence. Wide rows are hashed in the server, so no string the
 * size of the catalog is built (`group_concat_max_len` would truncate it
 * silently, which is exactly the wrong failure for a change detector).
 */
import { Refusal } from './adapter.js';

/** One 64-bit digest term of a row's text: a decimal, for SUM and BIT_XOR alike. */
const term = (expression: string) => `CAST(CONV(SUBSTRING(MD5(${expression}), 1, 16), 16, 10) AS UNSIGNED)`;
/* The unit separator as text, not as the binary string 0x1f is: a binary operand would turn the whole row into one and fight the columns' collations. */
const SEP = 'CONVERT(CHAR(31) USING utf8mb4)';

/** One source's `count:sum:xor`, so a change in any of the three moves the epoch. */
function digest(columns: string, from: string, where: string): string {
  const row = term(`CONCAT_WS(${SEP}, ${columns})`);
  return `(SELECT CONCAT(COUNT(*), ':', COALESCE(SUM(${row}), 0), ':', COALESCE(BIT_XOR(${row}), 0)) FROM ${from} WHERE ${where})`;
}

/**
 * The statement and its bindings: the databases the adapter browses. One row,
 * one column, `epoch`. A server that refuses it (a missing view, privileges)
 * makes the caller treat the epoch as unread, which is a miss.
 */
export function mysqlSchemaEpochStatement(databases: readonly string[]): { text: string; params: string[] } {
  if (!databases.length) throw new Refusal('The schema epoch needs at least one database.');
  const holes = databases.map(() => '?').join(', ');
  const in_ = (alias: string) => `${alias}.TABLE_SCHEMA IN (${holes})`;
  const parts = [
    digest('t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, t.TABLE_COMMENT', 'information_schema.TABLES t', in_('t')),
    digest(
      'c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.ORDINAL_POSITION, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.COLUMN_KEY, c.COLUMN_COMMENT, c.EXTRA',
      'information_schema.COLUMNS c',
      in_('c'),
    ),
    digest(
      's.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX, s.NON_UNIQUE, s.COLUMN_NAME',
      'information_schema.STATISTICS s',
      in_('s'),
    ),
    digest(
      'k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE',
      `information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME`,
      in_('k'),
    ),
  ];
  return {
    text: `SELECT CONCAT_WS('|', ${parts.join(', ')}) AS epoch`,
    // One list per source, in the order the sources appear above.
    params: [...databases, ...databases, ...databases, ...databases],
  };
}

/** The epoch an epoch statement answered, or undefined when it answered nothing usable. */
export function mysqlSchemaEpochOf(rows: readonly Record<string, unknown>[] | undefined): string | undefined {
  const value = rows?.length === 1 ? rows[0].epoch : undefined;
  return typeof value === 'string' && value ? value : undefined;
}
