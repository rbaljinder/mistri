/**
 * PostgreSQL introspection: the catalog queries that describe a database, and
 * the one reading of the rows they return.
 *
 * It sits apart from the adapter because describing a database is a different
 * job from connecting to one, querying it or writing to it — and because it is
 * the half that carries an invariant of its own. Every query here has an
 * explicit ORDER BY: the catalog promises no order, so without them the same
 * server may hand back a table's two foreign keys either way round, its
 * indexed columns in any order and its checks in any order, and a description
 * taken twice then differs with nothing changed underneath it. The ordering is
 * the point of this module rather than decoration, and `test/postgres.test.ts`
 * ("two reads of one database describe it identically") is what holds it.
 *
 * Where SQLite hands you a per-table PRAGMA, Postgres hands you a catalog you
 * can query in one shot. That difference is worth exploiting: introspection
 * here is a fixed handful of queries regardless of how many tables exist, which
 * matters the first time someone points this at a schema with four hundred of
 * them.
 *
 * The queries below read `information_schema` for columns and `pg_catalog` for
 * keys, checks and row estimates. `information_schema` is the portable half but
 * it has no cheap row count and describes composite keys awkwardly;
 * `pg_catalog` carries both, at the cost of being Postgres-specific. Since we
 * are already inside the Postgres adapter, that cost is zero.
 */
import {
  chooseColumnReference,
  columnKind,
  deleteRuleOf,
  type ColumnMeta,
  type ColumnReferenceCandidate,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from '../shared/schema.js';
import { checkFlag, checksIn } from '../shared/vocabulary.js';
import { catalogTextRule } from '../shared/textRules.js';
import {
  checkedText,
  firstVocabulary,
  postgresRowEstimate,
  type CheckRow,
  type ColumnRow,
  type IndexRow,
  type KeyRow,
  type PkRow,
  type RelRow,
} from './postgresCatalogRows.js';
import { Refusal } from './adapter.js';
import type { EpochCache } from './epochCache.js';
import type { PgQuery } from './postgresPool.js';
import { RESERVED_SCHEMAS } from './reservedSql.js';
import { POSTGRES_INLINE_STYLE, POSTGRES_STYLE, type SqlStyle } from '../shared/filter.js';

/** The style row-scoped reads compile with on this server: POSTGRES_INLINE_STYLE
 * from 12, where `AS NOT MATERIALIZED` exists; before it, every CTE is
 * materialized anyway and the words would be a syntax error. */
export async function postgresScopeStyle(db: PgQuery): Promise<SqlStyle> {
  const result = await db.query(`SELECT current_setting('server_version_num')::int AS version`);
  return Number((result.rows[0] as { version?: unknown } | undefined)?.version) >= 120_000 ? POSTGRES_INLINE_STYLE : POSTGRES_STYLE;
}

/** Schemas that are the server's own business, not the user's data. */
export const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/**
 * A relation that belongs to an extension is the extension's, not the App's:
 * PlanetScale preinstalls hypopg (its views, in `pscale_extensions`) in every
 * database and PostGIS brings `spatial_ref_sys` to Neon and Supabase, none of
 * which the App declared and a tenant policy can name no owner for. Extension
 * membership is a `pg_depend` row with `deptype = 'e'` on `pg_extension`; the
 * description and the catalog digest both leave such relations out, so they
 * agree. `alias` is the `pg_class` row's alias in the caller's query.
 */
export function notExtensionMember(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend ext
                       WHERE ext.classid = 'pg_catalog.pg_class'::regclass AND ext.objid = ${alias}.oid
                         AND ext.refclassid = 'pg_catalog.pg_extension'::regclass AND ext.deptype = 'e')`;
}

/** The adapter as its own description names it: the schemas it was pointed at,
 * and what it calls itself. Passed per description rather than captured, so the
 * leased writer inside a scoped transaction describes the same reach as the
 * reader does on connect. */
interface CatalogSource {
  readonly schemas: readonly string[];
  readonly label: string;
  readonly dialect: 'postgres';
}

export async function describePostgresCatalog(db: PgQuery, source: CatalogSource): Promise<DatabaseSchema> {
  const filterSchemas = source.schemas.length ? `AND n.nspname = ANY($1)` : `AND n.nspname <> ALL($1)`;
  const schemaParam = source.schemas.length
    ? source.schemas.filter((schema) => !RESERVED_SCHEMAS.includes(schema))
    : [...SYSTEM_SCHEMAS, ...RESERVED_SCHEMAS];

  /* 1. Relations, with the planner's row estimate.
        `reltuples` is an estimate, not a count, and is labelled as such in
        the UI. An exact count on a large table is a sequential scan, which
        is a strange thing for a schema browser to do on connect. */
  const rels = await db.query(
    `SELECT n.nspname AS table_schema,
            c.relname  AS table_name,
            c.relkind  AS kind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples END AS approx_rows,
            obj_description(c.oid) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','v','m','p','f')
        AND ${notExtensionMember('c')}
        ${filterSchemas}
        /* Temporary tables belong to one session. Another session's show
           in pg_class but not in information_schema, so they would arrive
           with no columns, and none of them is anything to browse. */
        AND n.nspname !~ '^pg_(toast_)?temp_'
      ORDER BY n.nspname, c.relname`,
    [schemaParam],
  );

  const relRows = rels.rows as unknown as RelRow[];
  const wanted = new Set(relRows.map((r) => `${r.table_schema}.${r.table_name}`));

  /* 2. Columns, in one pass over information_schema. */
  const cols = await db.query(
    /* `col_description` joined on rather than left out.

       A column comment is the table's own documentation — the one place a
       schema explains itself — and SQLite has none to read. It lives in `pg_description` rather
       than `information_schema`, which is why it needs the join. */
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
            c.is_nullable, c.column_default, c.ordinal_position, c.is_identity, c.identity_generation, c.is_generated,
            c.character_maximum_length,
            col_description(pc.oid, c.ordinal_position::int) AS comment,
            /* Cast to text before aggregating: enumlabel has type "name",
               and the driver hands a name[] back as the literal string
               '{open,held,closed}' rather than an array — the same value,
               typed as something no caller can use. */
            (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
               FROM pg_enum e
               JOIN pg_type t ON t.oid = e.enumtypid
               JOIN pg_namespace tn ON tn.oid = t.typnamespace
              WHERE t.typname = c.udt_name AND tn.nspname = c.udt_schema) AS enum_labels
       FROM information_schema.columns c
       LEFT JOIN pg_namespace pn ON pn.nspname = c.table_schema
       LEFT JOIN pg_class pc ON pc.relname = c.table_name AND pc.relnamespace = pn.oid
      WHERE c.table_schema ${source.schemas.length ? '= ANY($1)' : '<> ALL($1)'}
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    [schemaParam],
  );

  /* Checks, for the other half of the vocabulary. A `status text CHECK
     (status IN (...))` is far commoner in the wild than a real enum type,
     and to anything reading the catalog it is an untyped text column unless
     the constraint is read too. Postgres stores what it rewrote rather than
     what was written, which `checkVocabulary` knows about. */
  const checks = await db.query(
    `SELECT n.nspname AS table_schema, cl.relname AS table_name,
            pg_get_constraintdef(co.oid) AS expression
       FROM pg_constraint co
       JOIN pg_class cl     ON cl.oid = co.conrelid
       JOIN pg_namespace n  ON n.oid = cl.relnamespace
      WHERE co.contype = 'c'
        AND n.nspname ${source.schemas.length ? '= ANY($1)' : '<> ALL($1)'}
      ORDER BY n.nspname, cl.relname, co.conname`,
    [schemaParam],
  );

  const checksByTable = new Map<string, string[]>();
  for (const row of checks.rows as unknown as CheckRow[]) {
    const id = `${row.table_schema}.${row.table_name}`;
    const list = checksByTable.get(id) ?? [];
    /* `pg_get_constraintdef` returns `CHECK ((expr))`; the parser wants the
       expression, and `checksIn` is the same unwrapping SQLite needs. */
    list.push(...checksIn(row.expression));
    checksByTable.set(id, list);
  }

  /* 3. Keys. `unnest ... WITH ORDINALITY` keeps composite key columns in
        their declared order, which a plain array_agg over conkey would not
        guarantee and which matters for a two-column join.

        `attname` is of type `name`, not `text`, so aggregating it yields
        `name[]` — an array OID the driver has no parser for, which arrives
        as the raw string "{a,b}" rather than an array. The ::text casts are
        what make these come back as JavaScript arrays. */
  const keys = await db.query(
    `SELECT con.conname AS constraint_name,
            fn.nspname  AS from_schema,
            f.relname   AS from_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = f.oid AND a.attnum = k.attnum) AS from_columns,
            tn.nspname  AS to_schema,
            t.relname   AS to_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS to_columns,
            con.confdeltype AS delete_rule
       FROM pg_constraint con
       JOIN pg_class f      ON f.oid = con.conrelid
       JOIN pg_namespace fn ON fn.oid = f.relnamespace
       JOIN pg_class t      ON t.oid = con.confrelid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE con.contype = 'f'
      ORDER BY fn.nspname, f.relname, con.conname`,
  );

  const pks = await db.query(
    `SELECT n.nspname AS table_schema,
            c.relname AS table_name,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS columns
       FROM pg_constraint con
       JOIN pg_class c      ON c.oid = con.conrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
      WHERE con.contype = 'p'
      ORDER BY n.nspname, c.relname, con.conname`,
  );

  const pkByTable = new Map<string, string[]>();
  for (const row of pks.rows as unknown as PkRow[]) {
    pkByTable.set(`${row.table_schema}.${row.table_name}`, row.columns ?? []);
  }

  /* Only the leading column of each index.

     `indkey[0]` is the first key column, and it is the only one an ORDER BY
     can be satisfied by — an index on (customer_id, opened_at) makes
     `ORDER BY customer_id` free and `ORDER BY opened_at` a full sort. An
     expression index has attnum 0 and joins to nothing, which drops it, as
     it should: there is no bare column to sort by. */
  const indexes = await db.query(
    `SELECT n.nspname AS table_schema,
            c.relname AS table_name,
            a.attname::text AS column_name,
            -- Unique by itself (an App's natural-key address): one column, the whole table, no expression.
            (i.indisunique AND i.indnatts = 1 AND i.indpred IS NULL AND i.indexprs IS NULL) AS sole_unique,
            -- Unique as a pair (a natural key within a tenant): two key columns and nothing included.
            CASE WHEN i.indisunique AND i.indnatts = 2 AND i.indpred IS NULL AND i.indexprs IS NULL THEN
              (SELECT array_agg(pa.attname::text ORDER BY k.ord)
                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute pa ON pa.attrelid = c.oid AND pa.attnum = k.attnum) END AS unique_pair,
            -- The key columns a pg_trgm operator class indexes, at any position: what
            -- serves a contains (ILIKE '%x%') search, which a B-tree never does.
            (SELECT coalesce(array_agg(ta.attname::text), '{}')
               FROM unnest(i.indkey::int2[], i.indclass::oid[]) AS k(attnum, opclass)
               JOIN pg_opclass oc ON oc.oid = k.opclass
               JOIN pg_attribute ta ON ta.attrelid = c.oid AND ta.attnum = k.attnum
              WHERE oc.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')) AS trigram_columns
       FROM pg_index i
       JOIN pg_class c     ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      WHERE i.indisvalid
      ORDER BY n.nspname, c.relname, a.attname`,
  );

  const indexedByTable = new Map<string, Set<string>>();
  const uniqueByTable = new Map<string, Set<string>>();
  const pairsByTable = new Map<string, Array<[string, string]>>();
  const trigramByTable = new Map<string, Set<string>>();
  for (const row of indexes.rows as unknown as IndexRow[]) {
    const id = `${row.table_schema}.${row.table_name}`;
    const set = indexedByTable.get(id) ?? new Set<string>();
    set.add(row.column_name);
    indexedByTable.set(id, set);
    if (row.sole_unique) uniqueByTable.set(id, (uniqueByTable.get(id) ?? new Set<string>()).add(row.column_name));
    if (row.unique_pair?.length === 2) pairsByTable.set(id, [...(pairsByTable.get(id) ?? []), [row.unique_pair[0], row.unique_pair[1]]]);
    for (const column of row.trigram_columns ?? []) trigramByTable.set(id, (trigramByTable.get(id) ?? new Set<string>()).add(column));
  }

  const foreignKeys: ForeignKey[] = [];
  /* A column-level reference map, so the table view can show "this column
     points there" without searching the whole key list per cell. A column
     can sit in several keys — a tenant table's ownership column carries its
     own reference to the tenancy profile and its part in each composite
     tenant key — so every candidate is gathered and the link a reader
     follows is chosen by the one shared rule the SQLite catalog applies. */
  const refCandidates = new Map<string, ColumnReferenceCandidate[]>();
  for (const row of keys.rows as unknown as KeyRow[]) {
    const from = `${row.from_schema}.${row.from_table}`;
    const to = `${row.to_schema}.${row.to_table}`;
    // Keys can point out of the browsed schema set; those edges lead
    // nowhere the user can click, so they are dropped rather than shown broken.
    if (!wanted.has(from) || !wanted.has(to)) continue;
    foreignKeys.push({
      name: row.constraint_name,
      from: { table: from, columns: row.from_columns ?? [] },
      to: { table: to, columns: row.to_columns ?? [] },
      onDelete: deleteRuleOf(row.delete_rule),
    });
    (row.from_columns ?? []).forEach((col, i) => {
      const at = `${from}.${col}`;
      const listed = refCandidates.get(at) ?? [];
      listed.push({
        reference: { table: to, column: row.to_columns?.[i] ?? row.to_columns?.[0] ?? '' },
        composite: (row.from_columns ?? []).length > 1,
      });
      refCandidates.set(at, listed);
    });
  }
  const refByColumn = new Map<string, { table: string; column: string }>();
  for (const [at, listed] of refCandidates) {
    /* Describing a database this tool did not design: a column whose keys
       name no single link simply shows none. The scoped catalogs, which
       attest a write boundary, are the ones that refuse a contradiction. */
    const chosen = chooseColumnReference(listed);
    if (chosen.kind === 'one') refByColumn.set(at, chosen.reference);
  }

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const row of cols.rows as unknown as ColumnRow[]) {
    const id = `${row.table_schema}.${row.table_name}`;
    if (!wanted.has(id)) continue;
    const list = columnsByTable.get(id) ?? [];
    list.push(row);
    columnsByTable.set(id, list);
  }

  const tables: TableMeta[] = relRows.map((r) => {
    const id = `${r.table_schema}.${r.table_name}`;
    const pk = new Set(pkByTable.get(id) ?? []);
    const tableChecks = checksByTable.get(id) ?? [];
    const columns: ColumnMeta[] = (columnsByTable.get(id) ?? []).map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
      primaryKey: pk.has(c.column_name),
      references: refByColumn.get(`${id}.${c.column_name}`),
      default: c.column_default ?? undefined,
      identity: c.is_identity === 'YES' ? (c.identity_generation === 'ALWAYS' ? 'always' : 'by-default') : undefined,
      comment: c.comment ?? undefined,
      // The database computes a generated column; nothing may write it (as sqlite.ts says of its own).
      ...(c.is_generated === 'ALWAYS' ? { writable: false } : {}),
      /* The type wins where there is one: an enum's labels are the whole
         truth, while a check is one rule among however many the table has. */
      allowed: c.enum_labels?.length ? c.enum_labels : firstVocabulary(tableChecks, c.column_name),
      /* An integer a check pins to 0 and 1 reads as the boolean it stands for. */
      ...(columnKind(c.data_type) === 'number' && tableChecks.some((check) => checkFlag(check, c.column_name))
        ? { flag: true as const }
        : {}),
      /* A text column's length and form, where the type and the checks say them: a form checks them as someone types. */
      ...(() => {
        if (columnKind(c.data_type) !== 'text' || c.enum_labels?.length) return {};
        const text = catalogTextRule({
          max: c.character_maximum_length === null ? null : Number(c.character_maximum_length),
          ...checkedText(tableChecks, c.column_name),
        });
        return text ? { text } : {};
      })(),
    }));
    return {
      name: r.table_name,
      schema: r.table_schema,
      id,
      columns,
      approxRows: postgresRowEstimate(r.approx_rows),
      comment: r.comment ?? undefined,
      // Views and materialised views are read-only; foreign tables are
      // remote. All three are worth flagging rather than silently listing.
      isView: r.kind === 'v' || r.kind === 'm' || r.kind === 'f',
      indexed: [...(indexedByTable.get(id) ?? [])],
      trigram: [...(trigramByTable.get(id) ?? [])],
      ...(uniqueByTable.get(id)?.size ? { unique: [...uniqueByTable.get(id)!] } : {}),
      ...(pairsByTable.get(id)?.length ? { uniquePairs: pairsByTable.get(id)! } : {}),
    };
  });

  return {
    label: source.label,
    dialect: source.dialect,
    tables,
    foreignKeys,
    readAt: new Date().toISOString(),
  };
}

/** Where a table is, and whether writing to it makes sense. */
export interface Located {
  kind: string;
  schema: string;
  name: string;
  isView: boolean;
}

/** One column, as the write path needs it: name, type, null-ness, key-ness. */
export interface PgColumnRow {
  name: string;
  type: string;
  notnull: boolean;
  is_pk: boolean;
}

/**
 * The write path, on its own handle.
 *
 * Every reader carries `default_transaction_read_only = on`. A separate
 * writer pool is opened on the first edit: a connection that can write
 * should exist because somebody wrote, not because somebody connected.
 *
 * Every guard below is the SQLite adapter's, one for one. An edit refused on
 * SQLite and allowed on Postgres would mean the safety of a cell editor
 * depended on which database it was pointed at.
 *
 * A table's columns as the catalog has them now, not as they were on connect.
 *
 * `information_schema` would do for the names and types, but not for the
 * primary key — it describes a composite one across two more views — and
 * the key is the whole safety argument for a write. `pg_catalog` answers
 * both in one query, and this is the Postgres adapter, so being
 * Postgres-specific costs nothing.
 *
 * Read per write rather than from the cached schema: a column added since
 * the connection opened is a column the editor should be able to write, and
 * one dropped since is one it must not.
 */
export async function postgresColumnsOf(
  schema: string,
  name: string,
  db: PgQuery | undefined,
  epoch: string | undefined,
  cache: EpochCache<unknown>,
  connect: () => Promise<PgQuery>,
): Promise<PgColumnRow[]> {
  const kept = cache.get(epoch, `columns:${schema}.${name}`) as PgColumnRow[] | undefined;
  if (kept) return kept;
  db ??= await connect();
  const result = await db.query(
    `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull,
              COALESCE(k.is_pk, false) AS is_pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN LATERAL (
           SELECT true AS is_pk FROM pg_index i
            WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
         ) k ON true
        WHERE n.nspname = $1 AND c.relname = $2
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    [schema, name],
  );
  return cache.set(epoch, `columns:${schema}.${name}`, result.rows as unknown as PgColumnRow[]);
}

export async function assertPostgresTable(
  id: string,
  db: PgQuery | undefined,
  epoch: string | undefined,
  cache: EpochCache<unknown>,
  connect: () => Promise<PgQuery>,
): Promise<Located> {
  const dot = id.indexOf('.');
  const schema = dot === -1 ? 'public' : id.slice(0, dot);
  const name = dot === -1 ? id : id.slice(dot + 1);
  if (RESERVED_SCHEMAS.includes(schema)) throw new Refusal('Reserved resources are runtime-only.');
  const kept = cache.get(epoch, `table:${id}`) as Located | undefined;
  if (kept) return kept;
  db ??= await connect();
  const found = await db.query(
    `SELECT c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','v','m','p','f')`,
    [schema, name],
  );
  if (!found.rows.length) throw new Error(`No table or view called "${id}" in this database.`);
  /* `v` is a view and `m` a materialised one. Both are read-only as far as
     the write path is concerned — the relkind is asked for here rather than
     re-derived from the cached schema, so a view created since the
     connection opened is still recognised as one. */
  const kind = String(found.rows[0]?.kind ?? 'r');
  return cache.set(epoch, `table:${id}`, { schema, name, kind, isView: kind === 'v' || kind === 'm' });
}
