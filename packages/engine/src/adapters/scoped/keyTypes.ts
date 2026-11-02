/**
 * The types a scoped write takes as a row's identity (docs/trigger-effects.md, "Key types").
 *
 * Under a row policy, every check names a row by a value: a write's own row by its primary key, a parent by the
 * reference that points at it, a row a trigger reaches by its effect's key. The check is sound only where the value
 * it binds is the value the database compares. Six reviews found the same defect in new places: the driver's
 * JavaScript reading of a jsonb key (2^53 rounded, "123" read as 123), SQLite's numeric(p,s) said with its scale
 * (19.987 read as "19.99"), a float or timestamp whose text depends on the session's settings. So a column that is a
 * row's identity — a primary key, either side of a foreign key, either side of a trigger effect's key — must be of a
 * type whose value reads back exactly, through the driver and through text, and any other is refused from the
 * catalog, before a value is read:
 *
 * - PostgreSQL, a domain read as the type it is over: text, varchar, char, name, citext; int2, int4, int8; numeric
 *   (the driver reads it as its exact text); uuid; date (its text pinned to ISO for the transaction, postgres.ts);
 *   boolean; an enum. Never json or jsonb, a float, a time or timestamp, an interval, money, bytea, a network
 *   address, an array, a range or a composite.
 * - SQLite, by the affinity its declared type gives: INTEGER or TEXT. Never REAL, NUMERIC (a decimal with a declared
 *   scale is said with it), BLOB or a column declared without a type; except that a typeless column may reference an
 *   allowed key, which its foreign key compares as the check does (sqliteScopeCatalog.ts affinitiesPart).
 */

/** Why a column of `type` cannot be a row's identity in a scoped write, as a refusal says it (no full stop: it is said inside others). */
export const keyTypeRefusal = (dialect: 'postgres' | 'sqlite', table: string, column: string, type: string): string =>
  `"${table}".${column} is of type ${type}, which is not supported as a key for writes under a row policy ` +
  "(a primary key, either side of a foreign key, or a trigger effect's key): " +
  (dialect === 'sqlite'
    ? 'on SQLite a key must have INTEGER or TEXT affinity'
    : 'on PostgreSQL a key must be text, varchar, char, citext, name, an integer, numeric, uuid, date, boolean or an enum') +
  ', whose value reads back exactly as the database compares it' +
  (dialect === 'sqlite' && looksLikeText(type) ? '; declare it TEXT (or INTEGER) to use it as a key under a row policy' : '');

/* A SQLite type named as another engine's (UUID, STRING, DATETIME, BOOLEAN, GUID) is NUMERIC by SQLite's rules, which
   its author rarely meant: the refusal says what to declare instead. `said` is sqliteTypeSaid's. */
const looksLikeText = (said: string): boolean =>
  said.endsWith(' (NUMERIC affinity)') && /UUID|GUID|STRING|DATE|TIME|BOOL/i.test(said.slice(0, -' (NUMERIC affinity)'.length));

/** SQLite's affinity for a declared type (datatype3.html, 3.1), and ANY as itself: a STRICT table's ANY converts nothing. */
export function sqliteAffinity(declared: string): string {
  const type = declared.toUpperCase();
  if (type.trim() === 'ANY') return 'ANY';
  if (type.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(type)) return 'TEXT';
  if (type.includes('BLOB') || !type.trim()) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(type)) return 'REAL';
  return 'NUMERIC';
}

/** Whether a SQLite column declared `declared` may be a row's identity in a scoped write. */
export const sqliteKeyType = (declared: string): boolean => ['INTEGER', 'TEXT'].includes(sqliteAffinity(declared));

/** A SQLite column's type as a refusal names it. */
export const sqliteTypeSaid = (declared: string): string =>
  declared.trim() ? `${declared.trim()} (${sqliteAffinity(declared)} affinity)` : 'none declared (BLOB affinity)';

/* PostgreSQL's built-in types on the list, by oid (pg_type.dat, fixed by the server's source): bool 16, name 19,
   int8 20, int2 21, int4 23, text 25, bpchar 1042, varchar 1043, date 1082, numeric 1700, uuid 2950. */
const POSTGRES_KEY_OIDS = '{16,19,20,21,23,25,1042,1043,1082,1700,2950}';

/**
 * Whether the base type `type` (an oid expression, its domains already unwrapped) may be a row's identity, as a SQL
 * boolean: one of the built-in types above, an enum, or the citext extension's own type (an extension's member is
 * recorded in pg_depend, so a type merely named citext is not it). Every operator named in pg_catalog.
 */
export const postgresKeyType = (type: string): string => `(${type} OPERATOR(pg_catalog.=) ANY ('${POSTGRES_KEY_OIDS}'::pg_catalog.oid[])
         OR EXISTS (SELECT FROM pg_catalog.pg_type kt WHERE kt.oid OPERATOR(pg_catalog.=) ${type} AND kt.typtype OPERATOR(pg_catalog.=) 'e')
         OR EXISTS (SELECT FROM pg_catalog.pg_type kt
                      JOIN pg_catalog.pg_depend kd ON kd.objid OPERATOR(pg_catalog.=) kt.oid AND kd.classid OPERATOR(pg_catalog.=) 1247::pg_catalog.oid
                       AND kd.refclassid OPERATOR(pg_catalog.=) 3079::pg_catalog.oid AND kd.deptype OPERATOR(pg_catalog.=) 'e'
                      JOIN pg_catalog.pg_extension kx ON kx.oid OPERATOR(pg_catalog.=) kd.refobjid
                     WHERE kt.oid OPERATOR(pg_catalog.=) ${type} AND kt.typname OPERATOR(pg_catalog.=) 'citext'
                       AND kx.extname OPERATOR(pg_catalog.=) 'citext'))`;
