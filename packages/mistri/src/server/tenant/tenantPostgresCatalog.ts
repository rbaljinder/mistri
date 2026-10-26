/**
 * What the PostgreSQL tenant sources attest beyond catalog authority.
 *
 * Catalog authority (shared/scopeCatalog.ts) compares tables, columns with
 * types, nullability, defaults and identity, primary and foreign keys. It
 * does not see collations, indexes, triggers, rules or row security, which
 * the SQLite sources pin through the stored CREATE text and PRAGMAs.
 * PostgreSQL keeps no CREATE text, so these are read from pg_catalog on the
 * snapshot or the writer that relies on them:
 *
 * - A description of every mapped relation — kind, row security, every
 *   column's type, collation and whether that collation is deterministic,
 *   NOT NULL, default, identity and generation, every constraint and index
 *   definition, and trigger, rule and policy counts — captured when a source
 *   opens and compared on every later use, the way the SQLite reader pins
 *   its CREATE text: an ALTER that re-collates a policy column must not
 *   quietly widen a filter.
 * - Every ownership column is text or varchar under a deterministic
 *   collation. There `=` is byte-exact (a nondeterministic ICU collation
 *   could make 'North' equal 'north'), so the tenant predicate needs no
 *   COLLATE, which would stop the column's own indexes from serving it.
 * - Tenant-local uniqueness, from pg_index, by SQLite's rule: every unique
 *   index on a tenant-owned table includes the ownership column under a
 *   deterministic collation, except the primary key of a single opaque
 *   text, varchar or uuid identifier. Expression keys and exclusion
 *   constraints refuse: neither says which tenant it compares within.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { postgresCatalogDigestOf } from '@mistriwork/engine/adapters/postgresCatalogDigest.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { tenantKeyRefusal, tenantUniqueRefusal, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { EPOCHLESS_TTL_MS } from '@mistriwork/engine/adapters/postgresSchemaEpoch.js';

let catalogTrust = EPOCHLESS_TTL_MS;
/** How long a tenant read source's catalog attestation stands before a snapshot reads the digest again
    (tenantReadSource.ts, tenantPlatformSource.ts): what a source opened without saying takes. */
export const tenantCatalogTrust = (): number => catalogTrust;
/** For a suite whose cases change the catalog and expect the very next read to see it: zero makes every snapshot
    read the digest, as every snapshot did before the window. Returns what it replaced. */
export function trustTenantCatalogFor(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('A catalog trust window is a whole number of milliseconds.');
  const was = catalogTrust;
  catalogTrust = ms;
  return was;
}

/** The adapter's id convention: always `schema.name`. A schema containing a
 * dot splits wrongly, finds no relation and refuses. */
function located(id: string): { schema: string; name: string } {
  const dot = id.indexOf('.');
  return dot < 1 ? denyTenant() : { schema: id.slice(0, dot), name: id.slice(dot + 1) };
}
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const targets = (ids: readonly string[]) => {
  const at = ids.map(located);
  return [ids, at.map((value) => value.schema), at.map((value) => value.name)];
};

interface RelationColumn {
  name: string;
  type: string;
  notnull: boolean;
  collation: string | null;
  deterministic: boolean | null;
  default: string | null;
  identity: string;
  generated: string;
}
interface Relation {
  id: string;
  kind: string | null;
  rls: boolean;
  force: boolean;
  columns: RelationColumn[];
  constraints: string[];
  indexes: string[];
  triggers: number;
  rules: number;
  policies: number;
}

/**
 * Describes the source's mapped relations and checks every ownership column;
 * returns the description as one comparable string. Call on the source's own
 * snapshot or writer, after the relations are locked.
 */
export async function attestPostgresTenantRelations(client: PgQuery, ownership: TenantOwnershipSnapshot): Promise<string> {
  const ids = [...new Set(Object.values(ownership.resources))].sort(byCodeUnit);
  const rows = (
    await client.query(
      `SELECT w.id, c.relkind::text AS kind, COALESCE(c.relrowsecurity, false) AS rls, COALESCE(c.relforcerowsecurity, false) AS force,
            COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                'notnull', a.attnotnull, 'collation', l.collname, 'deterministic', l.collisdeterministic,
                'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated)
                ORDER BY a.attnum)
               FROM pg_catalog.pg_attribute a
               LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               LEFT JOIN pg_catalog.pg_collation l ON l.oid = a.attcollation
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS columns,
            COALESCE((SELECT json_agg(pg_catalog.pg_get_constraintdef(co.oid))
               FROM pg_catalog.pg_constraint co WHERE co.conrelid = c.oid AND co.contype <> 'n'), '[]'::json) AS constraints,
            COALESCE((SELECT json_agg(pg_catalog.pg_get_indexdef(i.indexrelid))
               FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid), '[]'::json) AS indexes,
            (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)::int AS triggers,
            (SELECT count(*) FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid)::int AS rules,
            (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)::int AS policies
       FROM unnest($1::text[], $2::text[], $3::text[]) AS w(id, schema, name)
       LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
       LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name`,
      targets(ids),
    )
  ).rows as unknown as Relation[];
  if (rows.length !== ids.length || rows.some((row) => typeof row.kind !== 'string' || !Array.isArray(row.columns))) return denyTenant();
  const described = new Map(rows.map((row) => [row.id, row]));
  for (const [logical, rule] of Object.entries(ownership.ownership)) {
    if (rule.kind !== 'tenant') continue;
    const column = described.get(ownership.resources[logical])?.columns.find((field) => field.name === rule.column);
    if (!column || column.deterministic !== true || !/^(text|character varying(\(\d+\))?)$/.test(column.type)) return denyTenant();
  }
  return JSON.stringify(
    rows
      .map((row) => ({ ...row, constraints: [...row.constraints].sort(byCodeUnit), indexes: [...row.indexes].sort(byCodeUnit) }))
      .sort((a, b) => byCodeUnit(a.id, b.id)),
  );
}

interface IndexRow {
  id: string;
  name: string;
  unique: boolean;
  primary: boolean;
  exclusion: boolean;
  columns: Array<{ attnum: number; name: string | null; deterministic: boolean | null }> | null;
}

/** Attest tenant-local business uniqueness; a single opaque primary ID is the
 * intentional global exception. Type and DDL cannot prove how a host
 * generates those IDs, so ID generation remains a deployment responsibility. */
export async function assertPostgresTenantUniqueKeys(client: PgQuery, ownership: TenantOwnershipSnapshot): Promise<void> {
  const tenants = Object.entries(ownership.ownership)
    .filter(([, rule]) => rule.kind === 'tenant')
    .map(([logical]) => logical);
  const physical = tenants.map((logical) => ownership.resources[logical]);
  const rows = (
    await client.query(
      `SELECT w.id, i.indexrelid::regclass::text AS name, i.indisunique AS "unique", i.indisprimary AS "primary", i.indisexclusion AS exclusion,
            (SELECT json_agg(json_build_object('attnum', k.attnum, 'name', a.attname, 'deterministic', l.collisdeterministic) ORDER BY k.ord)
               FROM unnest(i.indkey::int2[], i.indcollation::oid[]) WITH ORDINALITY AS k(attnum, coll, ord)
               LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               LEFT JOIN pg_catalog.pg_collation l ON l.oid = k.coll
              WHERE k.ord <= i.indnkeyatts) AS columns
       FROM unnest($1::text[], $2::text[], $3::text[]) AS w(id, schema, name)
       JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name
       JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
      WHERE i.indisunique OR i.indisprimary OR i.indisexclusion`,
      targets(physical),
    )
  ).rows as unknown as IndexRow[];
  for (const logical of tenants) {
    const rule = ownership.ownership[logical];
    if (rule.kind !== 'tenant') continue;
    const table = ownership.schema.tables.find((table) => table.id === logical) ?? denyTenant();
    const primary = table.columns.filter((column) => column.primaryKey);
    const opaque =
      primary.length === 1 &&
      !primary[0].nullable &&
      !primary[0].identity &&
      ['text', 'character varying', 'uuid'].includes(primary[0].type);
    if (!primary.length || (!primary.some((column) => column.name === rule.column) && !opaque))
      return denyTenant(tenantKeyRefusal(logical, rule.column, primary));
    let primarySeen = false;
    for (const index of rows.filter((row) => row.id === ownership.resources[logical])) {
      if (index.exclusion || !index.unique) return denyTenant();
      const keys = index.columns ?? [];
      if (!keys.length || keys.some((key) => key.attnum === 0 || typeof key.name !== 'string')) return denyTenant();
      const local = keys.some((key) => key.name === rule.column && key.deterministic !== false);
      const primaryOnly = opaque && keys.length === 1 && keys[0].name === primary[0].name && keys[0].deterministic !== false;
      if (!local && !primaryOnly)
        return denyTenant(tenantUniqueRefusal(logical, typeof index.name === 'string' ? index.name : undefined, rule.column));
      if (index.primary) primarySeen = true;
    }
    if (!primarySeen) denyTenant(tenantKeyRefusal(logical, rule.column, []));
  }
}

/* The catalog digest a snapshot's attestation stands on is the adapter's
   (adapters/postgresCatalogDigest.ts): the writer's scoped transaction reads
   the same one before it describes the catalog. */
export function postgresCatalogFingerprintOf(result: { rows: readonly Record<string, unknown>[] } | undefined): string {
  try {
    return postgresCatalogDigestOf(result);
  } catch {
    return denyTenant();
  }
}

/** Lock every mapped relation against DDL for the rest of the caller's
 * transaction. ACCESS SHARE conflicts only with ACCESS EXCLUSIVE — ALTER
 * TABLE, DROP, TRUNCATE — which is what could change what a read means, and
 * is permitted in a read-only transaction. */
export async function pinPostgresTenantRelations(client: PgQuery, physical: readonly string[]): Promise<void> {
  const statement = pinPostgresTenantRelationsStatement(physical);
  if (statement) await client.query(statement);
}

/** The LOCK itself, without parameters, for a snapshot's prologue; undefined for no relations. */
export function pinPostgresTenantRelationsStatement(physical: readonly string[]): string | undefined {
  const quoted = [...new Set(physical)].sort(byCodeUnit).map((id) => {
    const at = located(id);
    return `"${at.schema.replaceAll('"', '""')}"."${at.name.replaceAll('"', '""')}"`;
  });
  return quoted.length ? `LOCK TABLE ${quoted.join(', ')} IN ACCESS SHARE MODE` : undefined;
}
