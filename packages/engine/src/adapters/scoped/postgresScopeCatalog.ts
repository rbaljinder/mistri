/**
 * The scope catalog on PostgreSQL.
 *
 * SQLite reads its physical metadata inside `BEGIN IMMEDIATE`, where nothing
 * else can write, so what it attests is what the transaction will see until
 * COMMIT. PostgreSQL has no such fence: DDL from another session commits
 * under a READ COMMITTED transaction unless something holds a lock on the
 * relation it touches. So the tables this scope may write are pinned first,
 * with `LOCK TABLE … IN ROW EXCLUSIVE MODE` — the lock an UPDATE takes
 * anyway, compatible with every ordinary reader and writer and in conflict
 * with everything that would change what a write means: ALTER TABLE, CREATE
 * TRIGGER, ADD FOREIGN KEY (on either side), CREATE INDEX, ENABLE ROW LEVEL
 * SECURITY. The catalog is read *after* the pin, so drift that committed
 * before it is what the attestation compares, and drift after it waits for
 * this transaction to end.
 *
 * Only tables in the scope that the writer role may update are pinned. That
 * is not a loophole: a table outside the scope is unreadable here (`WHERE
 * 1 = 0`), and one the role cannot update cannot be written by it, locked
 * for update, or have its rows held for a parent check — so it is never in
 * `writable` and the guarantee it lacks is one it could not use.
 *
 * What is described is exactly what `introspect()` describes, on the leased
 * writer inside the transaction, so the deployed catalog and this evidence
 * differ only when the database does.
 */
import { POSTGRES_STYLE, Refusal } from '../adapter.js';
import type { DatabaseSchema, TableMeta } from '../../shared/schema.js';
import type { RowScope } from '../../shared/rowScope.js';
import { captureScopeCatalog } from '../../shared/scopeCatalog.js';
import { writtenType } from '../postgresCatalog.js';
import type { PgQuery } from '../postgresPool.js';
import { referenceKey, ScopeRefusal, triggerNames, type ReferenceComparison, type ScopeCatalog } from './scopedTransaction.js';
import { recordRefusalCause } from '../../shared/refusal.js';
import {
  baseType,
  CATALOG_OPERATORS,
  defaultBtreeClass,
  postgresTreeTriggerNames,
  postgresTriggerAnalyzer,
  postgresTriggersByTable,
  postgresTriggerStatement,
  postgresTriggerVersions,
  readPostgresTableCode,
} from './postgresTriggers.js';
import type { ScopeTrigger } from './scopeTriggers.js';
import type { EffectCatalog, KeyComparison, TriggerKeyFacts } from './triggerEffects.js';
import { keyTypeRefusal, postgresKeyType } from './keyTypes.js';

const { EQ, GT, LT, NE, PLUS } = CATALOG_OPERATORS;

export interface PostgresScopeCatalog extends ScopeCatalog {
  /** Ordinary tables the writer role may UPDATE, and so lock rows in. A
   * superset of `writable`: a lockable table with a trigger is still refused
   * as a target, but its rows can be held for a parent-visibility check. */
  lockable: ReadonlySet<string>;
  /** The relations this read pinned, quoted, in order: what a later transaction under the same epoch pins before it reads the epoch. */
  pinned: readonly string[];
  /** Each table in `triggered`, what its triggers' proof was read from (postgresTriggers.ts triggerVersion): read
   * again before COMMIT by a transaction that relied on it (attestPostgresTriggers). */
  triggerVersions?: ReadonlyMap<string, string>;
  /** Under row security (PostgresAdapterOptions.rowSecurity): each table carrying mistri's tenant policy, and the
   * column that policy compares. Which column a table's policy must be on, and which tables must carry one, is the
   * App's ownership to say (mistri's tenantPostgresCatalog.ts); the engine says only that the shape is exactly this. */
  tenantPolicies?: ReadonlyMap<string, string>;
}

/** Row security as the adapter runs under it: the role a policy names, and whether FORCE ROW LEVEL SECURITY may be on. */
type RowSecurityShape = Readonly<{ role: string; force: boolean }>;

/** The only policy a scoped write accepts under row security, by name. */
export const TENANT_POLICY = 'mistri_tenant';

/**
 * What follows the column in the policy's expression as `pg_get_expr` deparses it (PostgreSQL 16.15): a text column
 * reads `(tenant = NULLIF(current_setting('mistri.tenant'::text, true), ''::text))`, a varchar one
 * `((tenant)::text = NULLIF(…))`. Compared as text so that any other expression — `USING (true)`, another setting, an
 * OR — is not mistri's policy, whatever it would filter.
 */
export const TENANT_POLICY_TAIL = " = NULLIF(current_setting('mistri.tenant'::text, true), ''::text))";

interface FactRow {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  triggers: boolean;
  trigger_names: string[];
  rules: boolean;
  policies: boolean;
  updatable: boolean;
  /** In a partition or inheritance hierarchy, on either side of pg_inherits: no scoped write targets it (ScopeCatalog.hierarchy). */
  hierarchy: boolean;
  /** An ordinary table with inheritance children (ScopeCatalog.inheritanceParents): a reference to it is not checked. */
  inherited: boolean;
  /** The first primary key column of a type a scoped write does not take as a row's identity (keyTypes.ts), and that type. */
  unkeyed_column: string | null;
  unkeyed_type: string | null;
  /** Read only under row security: FORCE ROW LEVEL SECURITY, how many policies the table has, and the column of the
   * one policy that is exactly mistri's tenant policy (TENANT_POLICY_TAIL), or null where none is. */
  force?: boolean;
  policy_count?: number;
  tenant_column?: string | null;
}

const refuse = (): never => {
  throw new Refusal('PostgreSQL scoped transactions require a complete catalog and an ordinary table the writer may update.');
};

/** The adapter's own id convention: `schema.name`, or `name` in public. */
function located(id: string): { schema: string; name: string } {
  const dot = id.indexOf('.');
  return dot === -1 ? { schema: 'public', name: id } : { schema: id.slice(0, dot), name: id.slice(dot + 1) };
}

const key = (at: { schema: string; name: string }) => `${at.schema}.${at.name}`;

/** A column's type as a refusal names it: as declared, and a domain with the type it is over. */
const saidType = (type: string, typmod: string, base: string, basemod: string) =>
  `pg_catalog.format_type(${type}, ${typmod}) OPERATOR(pg_catalog.||) CASE WHEN ${type} ${NE} ${base}
         THEN ' (a domain over ' OPERATOR(pg_catalog.||) pg_catalog.format_type(${base}, ${basemod}) OPERATOR(pg_catalog.||) ')' ELSE '' END`;

/** Everything that decides whether a write to a relation means what the
 * scope assumes: its kind, row security, and the presence of triggers,
 * rules and policies — and whether this role may update it at all. */
async function facts(
  client: PgQuery,
  targets: Array<{ schema: string; name: string }>,
  backstop?: RowSecurityShape,
): Promise<Map<string, FactRow>> {
  const result = new Map<string, FactRow>();
  if (!targets.length) return result;
  /* Under row security only, so a deployment without it asks the statement it always did. The policy is matched in
     full here — its name, command, permissiveness, its one role, and both expressions as deparsed against a column of
     the table — and anything else is a policy that is not mistri's (tenantShape). */
  const policy = backstop
    ? {
        columns: `,
            c.relforcerowsecurity AS force,
            (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid ${EQ} c.oid)::pg_catalog.int4 AS policy_count,
            tenant.name AS tenant_column`,
        join: `
       LEFT JOIN LATERAL (SELECT a.attname::pg_catalog.text AS name
           FROM pg_catalog.pg_policy p
           JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} c.oid AND a.attnum ${GT} 0 AND NOT a.attisdropped
           CROSS JOIN LATERAL (SELECT CASE a.atttypid
               WHEN 25::pg_catalog.oid THEN '(' ${CONCAT} pg_catalog.quote_ident(a.attname::pg_catalog.text) ${CONCAT} $4::pg_catalog.text
               WHEN 1043::pg_catalog.oid THEN '((' ${CONCAT} pg_catalog.quote_ident(a.attname::pg_catalog.text) ${CONCAT} ')::text' ${CONCAT} $4::pg_catalog.text
             END AS said) AS expected
          WHERE p.polrelid ${EQ} c.oid AND p.polname ${EQ} '${TENANT_POLICY}' AND p.polcmd ${EQ} '*' AND p.polpermissive
            AND pg_catalog.cardinality(p.polroles) ${EQ} 1
            AND p.polroles[1] ${EQ} (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname::pg_catalog.text ${EQ} $3::pg_catalog.text)
            AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) ${EQ} expected.said
            AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) ${EQ} expected.said
          LIMIT 1) AS tenant ON true`,
        values: [backstop.role, TENANT_POLICY_TAIL],
      }
    : { columns: '', join: '', values: [] };
  const rows = await client.query(
    /* Every function and operator named in pg_catalog (postgresTriggers.ts CAT): with `cardinality` found through the
       search_path, `public.cardinality(text[])` answered 0 for every table, which read as no triggers at all. */
    `SELECT n.nspname::pg_catalog.text AS schema, c.relname::pg_catalog.text AS name, c.relkind::pg_catalog.text AS kind,
            c.relrowsecurity AS rls, pg_catalog.cardinality(fired.names) ${GT} 0 AS triggers, fired.names AS trigger_names,
            EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class ${EQ} c.oid) AS rules,
            EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid ${EQ} c.oid) AS policies,
            pg_catalog.has_table_privilege(c.oid, 'UPDATE') AS updatable,
            c.relkind ${EQ} 'p' OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid ${EQ} c.oid OR i.inhparent ${EQ} c.oid)
              AS hierarchy,
            c.relkind ${EQ} 'r' AND EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent ${EQ} c.oid) AS inherited,
            unkeyed.name AS unkeyed_column, unkeyed.said AS unkeyed_type${policy.columns}
       FROM ${WANTED}
       -- A key column whose type is not on the list (keyTypes.ts), its domains unwrapped: no scoped write targets the table.
       LEFT JOIN LATERAL (SELECT a.attname::pg_catalog.text AS name, ${saidType('a.atttypid', 'a.atttypmod', 'b.type', 'b.typmod')} AS said
           FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} c.oid AND a.attnum OPERATOR(pg_catalog.=) ANY (i.indkey)
           CROSS JOIN LATERAL ${baseType('a.atttypid', 'a.atttypmod')} AS b
          WHERE i.indrelid ${EQ} c.oid AND i.indisprimary AND NOT ${postgresKeyType('b.type')}
          ORDER BY a.attnum LIMIT 1) AS unkeyed ON true
       -- Its partitions' and inheritance children's too: a write through it reaches their rows and fires theirs.
       CROSS JOIN LATERAL (SELECT ${postgresTreeTriggerNames('c.oid')} AS names) AS fired${policy.join}`,
    [targets.map((target) => target.schema), targets.map((target) => target.name), ...policy.values],
  );
  for (const row of rows.rows as unknown as FactRow[]) {
    if (
      typeof row.schema !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.kind !== 'string' ||
      [row.rls, row.triggers, row.rules, row.policies, row.updatable, row.hierarchy, row.inherited].some(
        (value) => typeof value !== 'boolean',
      ) ||
      !Array.isArray(row.trigger_names) ||
      row.trigger_names.some((name) => typeof name !== 'string') ||
      (row.unkeyed_column !== null && typeof row.unkeyed_column !== 'string') ||
      (row.unkeyed_type !== null && typeof row.unkeyed_type !== 'string') ||
      (backstop &&
        (typeof row.force !== 'boolean' ||
          !Number.isInteger(row.policy_count) ||
          (row.tenant_column !== null && typeof row.tenant_column !== 'string'))) ||
      result.has(key(row))
    )
      return refuse();
    result.set(key(row), row);
  }
  return result;
}

const lockable = (fact: FactRow | undefined): boolean => fact !== undefined && ['r', 'p'].includes(fact.kind) && fact.updatable;
/**
 * Under row security, the one shape of row security a scoped write accepts: enabled, FORCE off unless the deployment
 * allows it, and exactly one policy, mistri's (facts). Anything else — a second policy, a RESTRICTIVE one, `USING
 * (true)`, another role — refuses as it always did, named as a policy that is not mistri's.
 */
const tenantShape = (fact: FactRow, backstop: RowSecurityShape | undefined): boolean =>
  backstop !== undefined &&
  fact.rls &&
  fact.policies &&
  (!fact.force || backstop.force) &&
  fact.policy_count === 1 &&
  typeof fact.tenant_column === 'string';
/** Row security a scoped write does not take as given: none at all is clean, and under row security mistri's own is. */
const secured = (fact: FactRow, backstop: RowSecurityShape | undefined): boolean =>
  (fact.rls || fact.policies) && !tenantShape(fact, backstop);
const clean = (fact: FactRow, backstop?: RowSecurityShape): boolean => !secured(fact, backstop) && !fact.triggers && !fact.rules;
/** Clean but for its triggers: each write is then judged by the triggers it fires (scopedTransaction.ts target). */
const cleanButTriggers = (fact: FactRow, backstop?: RowSecurityShape): boolean => fact.triggers && !secured(fact, backstop) && !fact.rules;
/** Row security as a refusal names it: under row security, any that is not mistri's tenant policy. */
const securityNamed = (backstop: RowSecurityShape | undefined): string =>
  backstop ? "a row policy that is not mistri's tenant policy" : 'row-level security';

/** The rows of the triggers of `tables`, read on the writer. */
async function triggerRows(client: PgQuery, tables: ReadonlyArray<{ schema: string; name: string }>): Promise<unknown[]> {
  const result = await client.query(postgresTriggerStatement(true), [
    tables.map((table) => table.schema),
    tables.map((table) => table.name),
  ]);
  return result.rows;
}

/** The triggers of `tables` (adapter ids), read and proven on the writer: what fires each, whether it only validates, and what that was proven from. */
async function readTriggers(
  client: PgQuery,
  tables: ReadonlyArray<{ id: string; schema: string; name: string }>,
): Promise<Map<string, { triggers: ScopeTrigger[]; version: string }>> {
  const byKey = await postgresTriggersByTable(await triggerRows(client, tables), postgresTriggerAnalyzer(client));
  const read = new Map<string, { triggers: ScopeTrigger[]; version: string }>();
  for (const table of tables) {
    const found = byKey.get(key(table));
    // The facts said it has triggers, and the table is pinned against CREATE and DROP TRIGGER: none is a catalog this code misread.
    if (!found) return refuse();
    read.set(table.id, found);
  }
  return read;
}

/**
 * Before COMMIT, in a transaction that let a write fire a trigger the catalog proved validation-only: the proof's
 * sources read again. A table's triggers cannot change under its pin, but the function a trigger runs, and the
 * functions, operators and casts its conditions resolve to, can (CREATE OR REPLACE FUNCTION takes no lock on the table). Under
 * READ COMMITTED this read sees every change committed before it, so every version a write that has already run
 * could have used: a changed one refuses the transaction.
 */
export async function attestPostgresTriggers(client: PgQuery, catalog: PostgresScopeCatalog, tables: ReadonlySet<string>): Promise<void> {
  if (!tables.size) return;
  try {
    const wanted = [...tables].map((id) => {
      const table = catalog.schema.tables.find((candidate) => candidate.id === id);
      const version = catalog.triggerVersions?.get(id);
      if (!table || version === undefined) return refuse();
      return { id, schema: table.schema, name: table.name, version };
    });
    // The versions alone: what the proof was made from, not the proof made again.
    const read = postgresTriggerVersions(await triggerRows(client, wanted));
    for (const table of wanted) if (read.get(key(table)) !== table.version) return refuse();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse();
  }
}
/* The value a hierarchy found again is said in (hierarchyRecheck), between these, so its failure names the table. */
const JOINED = 'mistri: a scoped write target is in a hierarchy: ';
const INHERITED = 'mistri: a scoped write references an inheritance parent: ';
const JOINED_END = ' (end)';

/**
 * The tables a scoped write wrote, read again for a hierarchy just before COMMIT, as a statement that fails where one
 * is in one: sent with the COMMIT (beforeCommit), its failure answers the COMMIT as a ROLLBACK, so it costs no round
 * trip. The pin's ROW EXCLUSIVE holds a target against becoming a partition or a child (ATTACH PARTITION and ALTER
 * TABLE … INHERIT take ACCESS EXCLUSIVE on it), but not against becoming a parent: ALTER TABLE c INHERIT t and CREATE
 * TABLE c () INHERITS (t) take SHARE UPDATE EXCLUSIVE on t, and every mode that conflicts with that conflicts with an
 * ordinary write's ROW EXCLUSIVE or with itself, which would line up every scoped write of the table behind one
 * another. Under READ COMMITTED a statement after the transaction's last write sees every inheritance committed before
 * that write was planned, and one committed after it no write of the transaction expanded into: so a target that
 * passed the catalog's check (ScopeCatalog.hierarchy) and gained a child while the write ran refuses the transaction.
 * The tables those reference are read in the same statement for the same reason: one that gained an inheritance child
 * while the write ran (CREATE TABLE … INHERITS takes the same SHARE UPDATE EXCLUSIVE) may have let a parent check
 * find the child's visible row where the foreign key, which reads the parent alone, found a hidden one
 * (ScopeCatalog.inheritanceParents). Undefined where nothing was written.
 */
export function hierarchyRecheck(
  ids: Iterable<string>,
  referenced: Iterable<string> = [],
): { text: string; values: unknown[] } | undefined {
  const at = [...new Set(ids)].map(located);
  if (!at.length) return undefined;
  const parents = [...new Set(referenced)].map(located);
  const said = (prefix: string) =>
    `('${prefix}' ${CONCAT} n.nspname::pg_catalog.text ${CONCAT} '.' ${CONCAT} c.relname::pg_catalog.text ${CONCAT} '${JOINED_END}')::pg_catalog.int4`;
  return {
    text: `SELECT ${said(JOINED)}
       FROM ${WANTED}
      WHERE c.relkind ${EQ} 'p' OR EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE i.inhrelid ${EQ} c.oid OR i.inhparent ${EQ} c.oid)${
        parents.length
          ? `
     UNION ALL
     SELECT ${said(INHERITED)}
       FROM ${WANTED.replace('$1::', '$3::').replace('$2::', '$4::')}
      WHERE c.relkind ${EQ} 'r' AND EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE i.inhparent ${EQ} c.oid)`
          : ''
      }`,
    values: [
      at.map((table) => table.schema),
      at.map((table) => table.name),
      ...(parents.length ? [parents.map((table) => table.schema), parents.map((table) => table.name)] : []),
    ],
  };
}

/** The refusal a hierarchyRecheck failure says, or undefined for any other failure. */
export function joinedHierarchy(error: unknown): ScopeRefusal | undefined {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== '22P02' || typeof message !== 'string') return undefined;
  const reference = message.includes(INHERITED);
  const prefix = reference ? INHERITED : JOINED;
  const start = message.indexOf(prefix);
  const end = message.indexOf(JOINED_END, start);
  if (start === -1 || end === -1) return undefined;
  const table = message.slice(start + prefix.length, end);
  return recordRefusalCause(
    new ScopeRefusal('This operation is not available in the current row scope.'),
    reference
      ? `"${table}" became an inheritance parent while the write ran, and a reference to it is not checked under a row policy: the foreign key reads its own rows, a parent check its children's too.`
      : `"${table}" became part of a partition or inheritance hierarchy while the write ran, which writes under a row policy do not support yet.`,
  );
}

/** The relations of `$1` (schemas) and `$2` (names), as `c` and `n`: the proof's own catalog read, its operators named in pg_catalog (postgresTriggers.ts). */
const WANTED = `pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid ${EQ} c.relnamespace
       JOIN ROWS FROM (pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.text[])) AS wanted(schema, name)
         ON n.nspname ${EQ} wanted.schema AND c.relname ${EQ} wanted.name`;

/**
 * How a trigger's key equality compares on PostgreSQL, for `ids` (triggerEffects.ts): each column's base type and
 * type modifier with its domains unwrapped, its collation and whether that collation is deterministic; and the
 * column sets each table is unique on as such an equality compares. A unique index counts only where it is valid,
 * immediate (a deferrable one holds duplicates until COMMIT), B-tree, over plain columns of the whole table, and
 * each column is indexed under its own collation and its type's default operator class: an index under "C" on a
 * column whose collation folds case, or under a pattern operator class, is unique by an equality the trigger does not
 * make. `TableMeta.unique` (an App's address, a tenant's bound) is read by looser rules and is left as it is.
 */
async function effectKeyFacts(client: PgQuery, ids: readonly string[]): Promise<Pick<EffectCatalog, 'keys' | 'comparison'>> {
  // Each once: a table named twice would count each index column twice.
  const at = [...new Set(ids)].map(located);
  const params = [at.map((table) => table.schema), at.map((table) => table.name)];
  const tables = `SELECT c.oid, n.nspname::pg_catalog.text OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) c.relname::pg_catalog.text AS id
       FROM ${WANTED}`;
  const columns = await client.query(
    `WITH t AS (${tables})
     SELECT t.id, a.attname::pg_catalog.text AS name, b.type::pg_catalog.int4 AS type, b.typmod::pg_catalog.int4 AS typmod,
            pg_catalog.format_type(b.type, b.typmod) AS said, a.attcollation::pg_catalog.int4 AS collation,
            coalesce(ln.nspname::pg_catalog.text, '') AS collschema, coalesce(l.collname::pg_catalog.text, '') AS collname,
            coalesce((pg_catalog.to_jsonb(l) OPERATOR(pg_catalog.->>) 'collisdeterministic')::pg_catalog.bool, true) AS exact,
            ${postgresKeyType('b.type')} AS keyable, ${saidType('a.atttypid', 'a.atttypmod', 'b.type', 'b.typmod')} AS declared
       FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} t.oid AND a.attnum ${GT} 0 AND NOT a.attisdropped
       CROSS JOIN LATERAL ${baseType('a.atttypid', 'a.atttypmod')} AS b
       LEFT JOIN pg_catalog.pg_collation l ON l.oid ${EQ} a.attcollation
       LEFT JOIN pg_catalog.pg_namespace ln ON ln.oid ${EQ} l.collnamespace`,
    params,
  );
  const keys = await client.query(
    `WITH t AS (${tables})
     SELECT t.id, pg_catalog.array_agg(a.attname::pg_catalog.text ORDER BY k.ord) AS columns,
            pg_catalog.bool_and(k.coll ${EQ} a.attcollation AND k.opclass ${EQ} ${defaultBtreeClass('b.type')}) AS own
       FROM t
       JOIN pg_catalog.pg_index i ON i.indrelid ${EQ} t.oid
       JOIN pg_catalog.pg_class ic ON ic.oid ${EQ} i.indexrelid
       CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(i.indkey::pg_catalog.int2[]), pg_catalog.unnest(i.indcollation::pg_catalog.oid[]), pg_catalog.unnest(i.indclass::pg_catalog.oid[]))
             WITH ORDINALITY AS k(attnum, coll, opclass, ord)
       JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} t.oid AND a.attnum ${EQ} k.attnum
       CROSS JOIN LATERAL ${baseType('a.atttypid', 'a.atttypmod')} AS b
      WHERE i.indisunique AND i.indisvalid AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts ${EQ} i.indnkeyatts AND ic.relam ${EQ} 403::pg_catalog.oid
      GROUP BY t.id, i.indexrelid
     HAVING pg_catalog.count(*) ${EQ} pg_catalog.max(i.indnkeyatts)`,
    params,
  );
  const compared = new Map<string, KeyComparison>();
  for (const row of columns.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.id !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.said !== 'string' ||
      typeof row.exact !== 'boolean' ||
      typeof row.keyable !== 'boolean' ||
      typeof row.declared !== 'string'
    )
      return refuse();
    compared.set(`${row.id}\u0000${row.name}`, {
      type: `${String(row.type)}:${String(row.typmod)}`,
      collation: String(row.collation),
      exact: row.exact,
      keyable: row.keyable,
      declared: row.declared,
      // Named with its schema: two collations of one name in two schemas are two collations (an ICU "sv" and a libc one).
      said: `${row.said}${row.collname ? ` COLLATE ${POSTGRES_STYLE.quote(String(row.collschema))}.${POSTGRES_STYLE.quote(String(row.collname))}` : ''}`,
    });
  }
  const unique = new Map<string, string[][]>();
  for (const row of keys.rows as Array<Record<string, unknown>>) {
    if (typeof row.id !== 'string' || !Array.isArray(row.columns) || row.columns.some((name) => typeof name !== 'string')) return refuse();
    if (row.own === true) unique.set(row.id, [...(unique.get(row.id) ?? []), row.columns as string[]]);
  }
  return {
    keys: (table: TableMeta) => unique.get(table.id) ?? [],
    comparison: (table: TableMeta, column: string) => compared.get(`${table.id}\u0000${column}`),
  };
}

/** A type as `ri_triggers.c` casts to it: its schema and name, each quoted where it needs it. */
const castType = (oid: string) => `(SELECT pg_catalog.quote_ident(tn.nspname::pg_catalog.text) OPERATOR(pg_catalog.||) '.'
            OPERATOR(pg_catalog.||) pg_catalog.quote_ident(t.typname::pg_catalog.text)
          FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace tn ON tn.oid ${EQ} t.typnamespace WHERE t.oid ${EQ} ${oid})`;

/* Whether a type is a pseudo-type: a polymorphic operator's input (an enum's `anyenum`), which a side is not cast to.
   The operator resolves it from the side's own type. */
const pseudo = (oid: string) => `EXISTS (SELECT FROM pg_catalog.pg_type pt WHERE pt.oid ${EQ} ${oid} AND pt.typtype ${EQ} 'p')`;

const CONCAT = 'OPERATOR(pg_catalog.||)';
/**
 * A column's type as a cast names it whatever the search_path: its schema and name from pg_type, each quoted where it
 * needs it (castType), then its modifier as the digits the type's own input reads back — `pg_catalog."numeric"(10,2)`,
 * `pg_catalog.bpchar(3)`. `format_type` said `text` and `character(3)`: a name found through the search_path when the
 * statement runs, which a type made after the catalog was read (a domain `public.text` over `name`, with pg_catalog
 * after public) answered, and a check that read 64 characters as 63 found another key than the foreign key. The
 * modifier is what `format_type` adds to the type's bare name, a parenthesised list for every type a reference may be
 * that has one (varchar, char, numeric: keyTypes.ts). NULL where it is not: a type a check cannot name.
 */
const sqlType = (oid: string, typmod: string) => `(SELECT CASE WHEN m.said IS NOT NULL THEN
            pg_catalog.quote_ident(tn.nspname::pg_catalog.text) ${CONCAT} '.' ${CONCAT} pg_catalog.quote_ident(t.typname::pg_catalog.text) ${CONCAT} m.said END
          FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace tn ON tn.oid ${EQ} t.typnamespace
          CROSS JOIN LATERAL (SELECT CASE
              WHEN ${typmod} ${LT} 0 THEN ''
              WHEN pg_catalog.left(pg_catalog.format_type(t.oid, ${typmod}), pg_catalog.length(pg_catalog.format_type(t.oid, NULL)))
                     ${EQ} pg_catalog.format_type(t.oid, NULL)
                THEN pg_catalog.substr(pg_catalog.format_type(t.oid, ${typmod}), pg_catalog.length(pg_catalog.format_type(t.oid, NULL)) ${PLUS} 1)
            END AS said) AS m
         WHERE t.oid ${EQ} ${oid})`;

/**
 * How each foreign key of `schema` compares a reference with its parent's key (ScopeCatalog.references), as the
 * database's own check states it (ri_triggers.c RI_FKey_check, ruleutils.c generate_operator_clause): the parent
 * column, cast to the operator's left type where its own is another, then `OPERATOR(schema.name)` of the constraint's
 * own equality (`conpfeqop`), then the value read as the referencing column's type, typmod and all and named by its
 * schema (sqlType), and cast to the operator's right type where that is another. Neither side is cast to a
 * pseudo-type (`pseudo`): an enum's `anyenum` is resolved from the side's own type. A parent check written so finds the
 * row the foreign key finds: by `=` and the value as given, a char(3) 'ab ' found the text key 'ab ', where the foreign
 * key, comparing as text, finds 'ab'. A key whose columns or operators the catalog does not give whole, either side of
 * which is of a type a key may not be (keyTypes.ts), or whose type a cast cannot name, is refused to a scoped write
 * through it.
 */
async function foreignKeyComparisons(client: PgQuery, schema: DatabaseSchema): Promise<Map<string, ReferenceComparison>> {
  const at = schema.tables.map((table) => ({ schema: table.schema, name: table.name }));
  const result = await client.query(
    `SELECT n.nspname::pg_catalog.text AS schema, c.relname::pg_catalog.text AS "table", con.conname::pg_catalog.text AS name,
            k.ord::pg_catalog.int4 AS ord, fa.attname::pg_catalog.text AS child, pa.attname::pg_catalog.text AS parent,
            ${sqlType('fa.atttypid', 'fa.atttypmod')} AS type, ${writtenType('fa.atttypid', 'fa.atttypmod')} AS written,
            ${postgresKeyType('fb.type')} AS child_keyable, ${saidType('fa.atttypid', 'fa.atttypmod', 'fb.type', 'fb.typmod')} AS child_said,
            ${postgresKeyType('pb.type')} AS parent_keyable, ${saidType('pa.atttypid', 'pa.atttypmod', 'pb.type', 'pb.typmod')} AS parent_said,
            pg_catalog.quote_ident(opn.nspname::pg_catalog.text) OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) o.oprname::pg_catalog.text AS operator,
            CASE WHEN pa.atttypid ${EQ} o.oprleft OR ${pseudo('o.oprleft')} THEN NULL ELSE ${castType('o.oprleft')} END AS "left",
            CASE WHEN fa.atttypid ${EQ} o.oprright OR ${pseudo('o.oprright')} THEN NULL ELSE ${castType('o.oprright')} END AS "right"
       FROM ${WANTED}
       -- Never a clone that points at a partition, as the schema reads them (postgresCatalog.ts).
       JOIN pg_catalog.pg_constraint con ON con.conrelid ${EQ} c.oid AND con.contype ${EQ} 'f'
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_constraint pc WHERE pc.oid ${EQ} con.conparentid AND pc.confrelid ${NE} con.confrelid)
       CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(con.conkey), pg_catalog.unnest(con.confkey), pg_catalog.unnest(con.conpfeqop))
             WITH ORDINALITY AS k(child, parent, operator, ord)
       LEFT JOIN pg_catalog.pg_attribute fa ON fa.attrelid ${EQ} con.conrelid AND fa.attnum ${EQ} k.child
       LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid ${EQ} con.confrelid AND pa.attnum ${EQ} k.parent
       LEFT JOIN LATERAL ${baseType('fa.atttypid', 'fa.atttypmod')} AS fb ON true
       LEFT JOIN LATERAL ${baseType('pa.atttypid', 'pa.atttypmod')} AS pb ON true
       LEFT JOIN pg_catalog.pg_operator o ON o.oid ${EQ} k.operator
       LEFT JOIN pg_catalog.pg_namespace opn ON opn.oid ${EQ} o.oprnamespace
      ORDER BY 1, 2, 3, 4`,
    [at.map((table) => table.schema), at.map((table) => table.name)],
  );
  const read = new Map<string, Array<Record<string, unknown>>>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const id = `${String(row.schema)}.${String(row.table)}\u0000${String(row.name)}`;
    read.set(id, [...(read.get(id) ?? []), row]);
  }
  const comparisons = new Map<string, ReferenceComparison>();
  for (const fk of schema.foreignKeys) {
    const rows = read.get(`${fk.from.table}\u0000${fk.name}`) ?? [];
    const whole =
      rows.length === fk.from.columns.length &&
      rows.every(
        (row, index) =>
          row.ord === index + 1 &&
          row.child === fk.from.columns[index] &&
          row.parent === fk.to.columns[index] &&
          (row.type === null || typeof row.type === 'string') &&
          typeof row.written === 'string' &&
          typeof row.child_keyable === 'boolean' &&
          typeof row.parent_keyable === 'boolean' &&
          typeof row.child_said === 'string' &&
          typeof row.parent_said === 'string' &&
          typeof row.operator === 'string' &&
          (row.left === null || typeof row.left === 'string') &&
          (row.right === null || typeof row.right === 'string'),
      );
    const unnamed = rows.findIndex((row) => row.type === null);
    // Each side a row's identity (keyTypes.ts): the key pointed at, then the reference.
    const parent = rows.findIndex((row) => row.parent_keyable !== true);
    const child = rows.findIndex((row) => row.child_keyable !== true);
    comparisons.set(
      referenceKey(fk),
      !whole
        ? {
            refused: `"${fk.from.table}".${fk.from.columns.join('+')} has a foreign key ("${fk.name}") whose comparison the catalog does not give whole, so a parent it points at cannot be checked as it compares.`,
          }
        : parent !== -1
          ? { refused: `${keyTypeRefusal('postgres', fk.to.table, fk.to.columns[parent], rows[parent].parent_said as string)}.` }
          : child !== -1
            ? { refused: `${keyTypeRefusal('postgres', fk.from.table, fk.from.columns[child], rows[child].child_said as string)}.` }
            : unnamed !== -1
              ? {
                  refused: `"${fk.from.table}".${fk.from.columns[unnamed]} is of a type whose modifier a check cannot write, which a scoped write does not support for a reference.`,
                }
              : {
                  columns: rows.map((row) => ({
                    // Coerced as the write coerces it (postgresCatalog.ts writtenType): a domain read as the type it is over.
                    type: row.written as string,
                    equality: {
                      operator: row.operator as string,
                      type: row.type as string,
                      ...(typeof row.left === 'string' ? { left: row.left } : {}),
                      ...(typeof row.right === 'string' ? { right: row.right } : {}),
                    },
                  })),
                },
    );
  }
  return comparisons;
}

/** What blocks a scoped write to a table beyond its triggers, as a refusal names it; undefined where nothing does. */
const blockerOf = (fact: FactRow, backstop?: RowSecurityShape): string | undefined =>
  !['r', 'p'].includes(fact.kind)
    ? 'a kind a scoped write cannot target'
    : !fact.updatable
      ? 'no UPDATE privilege for the role that writes'
      : fact.rules || secured(fact, backstop)
        ? [fact.rules ? 'a rule' : '', secured(fact, backstop) ? securityNamed(backstop) : ''].filter(Boolean).join(' and ')
        : undefined;

/**
 * For `mistri check`: what a write's own catalog reads about `ids` to judge a trigger's effects
 * (readPostgresScopeCatalog), read on `client` outside a write: the keys, the tables in a partition or inheritance
 * hierarchy, and the tables a scoped write cannot target for row security, a rule, or the role's privileges.
 */
export async function effectCatalogFacts(client: PgQuery, given: readonly string[], backstop?: RowSecurityShape): Promise<TriggerKeyFacts> {
  const ids = [...new Set(given)];
  const read = await facts(client, ids.map(located), backstop);
  const blocked = new Map<string, string>();
  const hierarchy = new Set<string>();
  for (const id of ids) {
    const fact = read.get(key(located(id)));
    if (fact?.hierarchy) hierarchy.add(id);
    const blocker = fact && blockerOf(fact, backstop);
    if (blocker) blocked.set(id, blocker);
  }
  return { ...(await effectKeyFacts(client, ids)), hierarchy, blocked };
}

/** What makes a table unclean, as a refusal names it. */
const unclean = (fact: FactRow, backstop?: RowSecurityShape): string =>
  [
    fact.triggers ? triggerNames(fact.trigger_names) : '',
    fact.rules ? 'a rule' : '',
    secured(fact, backstop) ? securityNamed(backstop) : '',
  ]
    .filter(Boolean)
    .join(' and ');

/** Call only on the leased writer inside its transaction, before any read of
 * user data. The describe callback is the adapter's own introspection so the
 * evidence has the same shape as the catalog the permissions were bound to. */
export async function readPostgresScopeCatalog(
  client: PgQuery,
  scope: RowScope,
  describe: (client: PgQuery) => Promise<DatabaseSchema>,
  backstop?: RowSecurityShape,
): Promise<PostgresScopeCatalog> {
  try {
    const wanted = Object.keys(scope).map(located);
    const before = await facts(client, wanted, backstop);
    const pinned = wanted.filter((target) => lockable(before.get(key(target))));
    const relations = pinned.map((target) => `${POSTGRES_STYLE.quote(target.schema)}.${POSTGRES_STYLE.quote(target.name)}`);
    if (pinned.length) await client.query(`LOCK TABLE ${relations.join(', ')} IN ROW EXCLUSIVE MODE`);
    const described = await describe(client);
    const schema = captureScopeCatalog({ ...described, label: 'PostgreSQL scoped transaction', readAt: new Date().toISOString() });
    const after = facts(
      client,
      schema.tables.map((table) => ({ schema: table.schema, name: table.name })),
      backstop,
    );
    const held = new Set(pinned.map(key));
    const writable = new Set<string>();
    const blockedBy = new Map<string, string>();
    const unkeyed = new Map<string, string>();
    const hierarchy = new Set<string>();
    const inheritanceParents = new Set<string>();
    const locks = new Set<string>();
    const withTriggers: Array<{ id: string; schema: string; name: string }> = [];
    const tenantPolicies = new Map<string, string>();
    for (const table of schema.tables) {
      const fact = (await after).get(key(table));
      // A relation the catalog listed a moment ago and cannot describe now
      // was dropped under this transaction; nothing here may rely on it.
      if (!fact || table.id !== key(table)) return refuse();
      if (fact.unkeyed_column !== null)
        unkeyed.set(table.id, keyTypeRefusal('postgres', table.id, fact.unkeyed_column, fact.unkeyed_type ?? 'unknown'));
      // Never a target, but still lockable: a reference to a partitioned table holds its parent row through it.
      if (fact.hierarchy) hierarchy.add(table.id);
      if (fact.inherited) inheritanceParents.add(table.id);
      if (tenantShape(fact, backstop)) tenantPolicies.set(table.id, fact.tenant_column as string);
      if (!lockable(fact)) continue;
      locks.add(table.id);
      if (fact.hierarchy) continue;
      // Writable means pinned: a table that became clean after the pin
      // decision could be dirtied again before COMMIT, so it stays read-only.
      const ordinary = held.has(table.id) && !table.isView && table.columns.some((column) => column.primaryKey);
      if (ordinary && clean(fact, backstop)) writable.add(table.id);
      else if (ordinary && cleanButTriggers(fact, backstop)) withTriggers.push({ id: table.id, schema: table.schema, name: table.name });
      else if (!clean(fact, backstop)) blockedBy.set(table.id, unclean(fact, backstop));
    }
    /* Read only where a table has triggers: a database without them asks nothing more than it did. */
    const read = withTriggers.length ? await readTriggers(client, withTriggers) : undefined;
    const readTriggered = new Map([...(read ?? [])].map(([id, entry]) => [id, entry.triggers as readonly ScopeTrigger[]]));
    const triggerVersions = new Map([...(read ?? [])].map(([id, entry]) => [id, entry.version]));
    /* What else a write to a writable table runs — a default, a CHECK, a domain — judged as a trigger that is not
       validation-only where it calls a function of the database's: a table with such code is written only by the
       writes that run none of it. Read before the effects are judged, so a trigger's write to such a table is
       refused as the person's own would be. */
    const written = schema.tables.filter((table) => writable.has(table.id) || readTriggered.has(table.id));
    const code = await readPostgresTableCode(client, written);
    for (const table of written) {
      const own = code.get(key(table));
      if (!own) continue;
      writable.delete(table.id);
      readTriggered.set(table.id, [...(readTriggered.get(table.id) ?? []), ...own]);
    }
    // Keyed effects are judged against the catalog they run in (triggerEffects.ts); a database without them asks nothing more.
    const triggered = [...readTriggered.values()].some((triggers) => triggers.some((trigger) => trigger.effects))
      ? (await import('./triggerEffects.js')).resolveTriggerEffects({
          schema,
          writable,
          triggered: readTriggered,
          foldCase: false,
          hierarchy,
          ...(await effectKeyFacts(client, [...writable, ...readTriggered.keys()])),
        })
      : readTriggered;
    return {
      schema,
      writable,
      references: await foreignKeyComparisons(client, schema),
      ...(blockedBy.size ? { blockedBy } : {}),
      ...(unkeyed.size ? { unkeyed } : {}),
      ...(hierarchy.size ? { hierarchy } : {}),
      ...(inheritanceParents.size ? { inheritanceParents } : {}),
      ...(triggered.size ? { triggered, triggerVersions } : {}),
      ...(tenantPolicies.size ? { tenantPolicies } : {}),
      lockable: locks,
      pinned: relations,
    };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    // A lock the role may not take, a vanished relation or unknown metadata
    // cannot weaken the boundary; the failure aborts the transaction anyway.
    return refuse();
  }
}
