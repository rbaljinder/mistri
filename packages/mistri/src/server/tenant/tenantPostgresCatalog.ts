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
 * - Under the row-security backstop (TenantRelationOptions.rowSecurity), the
 *   database's own second fence, attested: every tenant table carries
 *   exactly mistri's tenant policy on its own ownership column, every global
 *   and platform table none, no view reaches a tenant table but as the person
 *   reading it, and no SECURITY DEFINER function in an App schema reads as
 *   someone else. The engine refuses a write to any other shape of policy
 *   (postgresScopeCatalog.ts); which table carries it, on which column, is
 *   the ownership's to say, so it is said here.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { postgresCatalogDigestOf } from '@mistriwork/engine/adapters/postgresCatalogDigest.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { tenantKeyRefusal, tenantUniqueRefusal, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { EPOCHLESS_TTL_MS } from '@mistriwork/engine/adapters/postgresSchemaEpoch.js';
import { TENANT_POLICY, TENANT_POLICY_TAIL } from '@mistriwork/engine/adapters/scoped/postgresScopeCatalog.js';

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
  /** Read under the backstop only: each policy as deparsed, and the server, views and functions around them. */
  policy_detail?: RelationPolicy[];
  version?: number;
  views?: Array<{ id: string; kind: string; options: string[] | null }>;
  definers?: string[];
}
interface RelationPolicy {
  name: string;
  cmd: string;
  permissive: boolean;
  /** Each role's name; null for PUBLIC, or for a role the catalog no longer names. */
  roles: Array<string | null>;
  qual: string | null;
  check: string | null;
  /** The column whose tenant comparison both expressions are, exactly (TENANT_POLICY_TAIL); null where they are not. */
  column: string | null;
}

/** Under the backstop: the runtime role its policies name, and whether FORCE ROW LEVEL SECURITY may be on. */
export interface TenantRelationOptions {
  readonly rowSecurity?: { readonly role: string; readonly force?: boolean };
}

/* PostgreSQL 15 is the first with a view's `security_invoker`, without which a view reads its tables as its owner. */
const BACKSTOP_VERSION = 150000;
/* What PostgreSQL's parse_bool reads as true, as a reloption may be spelt (`security_invoker`, `=on`, `=1`). */
const TRUE_OPTION = /^(t|tr|tru|true|y|ye|yes|on|1)$/i;
const invoker = (options: readonly string[] | null) =>
  (options ?? []).some((option) => option.startsWith('security_invoker=') && TRUE_OPTION.test(option.slice('security_invoker='.length)));

/**
 * The backstop's reads, appended to the description so that it costs no round trip: each relation's policies as
 * deparsed (and which column each compares, matched as the engine matches it), the server version, every view that
 * reaches a tenant table through other views, and the SECURITY DEFINER functions in the schemas the App maps.
 * `$4` is the tenant tables' ids, `$5` the expression's tail.
 */
const BACKSTOP_COLUMNS = `,
            COALESCE((SELECT json_agg(json_build_object('name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive,
                'roles', (SELECT json_agg(CASE WHEN r.oid = 0 THEN NULL ELSE ro.rolname END ORDER BY r.ord)
                            FROM unnest(p.polroles) WITH ORDINALITY AS r(oid, ord) LEFT JOIN pg_catalog.pg_roles ro ON ro.oid = r.oid),
                'qual', pg_catalog.pg_get_expr(p.polqual, p.polrelid), 'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
                'column', (SELECT a.attname FROM pg_catalog.pg_attribute a
                   CROSS JOIN LATERAL (SELECT CASE a.atttypid
                       WHEN 25::oid THEN '(' || pg_catalog.quote_ident(a.attname) || $5::text
                       WHEN 1043::oid THEN '((' || pg_catalog.quote_ident(a.attname) || ')::text' || $5::text END AS said) AS e
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                    AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = e.said AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = e.said
                  LIMIT 1))
                ORDER BY p.polname)
               FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid), '[]'::json) AS policy_detail,
            (SELECT pg_catalog.current_setting('server_version_num')::int) AS version,
            (WITH RECURSIVE tenant AS (
                 SELECT tc.oid FROM unnest($4::text[]) AS t(id)
                   JOIN pg_catalog.pg_namespace tn ON tn.nspname = split_part(t.id, '.', 1)
                   JOIN pg_catalog.pg_class tc ON tc.relnamespace = tn.oid AND tc.relname = substr(t.id, length(split_part(t.id, '.', 1)) + 2)),
               -- A view's query is its rewrite rule, which depends on every relation the query reads.
               over(oid) AS (
                 SELECT r.ev_class FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_rewrite r ON r.oid = d.objid
                  WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass
                    AND d.refobjid IN (SELECT oid FROM tenant) AND r.ev_class <> d.refobjid
                 UNION
                 SELECT r.ev_class FROM over o JOIN pg_catalog.pg_depend d ON d.refobjid = o.oid
                   JOIN pg_catalog.pg_rewrite r ON r.oid = d.objid
                  WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND r.ev_class <> o.oid)
             SELECT COALESCE(json_agg(json_build_object('id', vn.nspname || '.' || v.relname, 'kind', v.relkind, 'options', v.reloptions)
                      ORDER BY vn.nspname, v.relname), '[]'::json)
               FROM over JOIN pg_catalog.pg_class v ON v.oid = over.oid JOIN pg_catalog.pg_namespace vn ON vn.oid = v.relnamespace) AS views,
            (SELECT COALESCE(json_agg(fn.nspname || '.' || f.proname ORDER BY fn.nspname, f.proname), '[]'::json)
               FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
              WHERE f.prosecdef AND fn.nspname = ANY ($2::text[])) AS definers`;

/** Under the backstop, what the database must say beside the description; refuses where it says anything else. */
function attestBackstop(
  rows: readonly Relation[],
  ownership: TenantOwnershipSnapshot,
  security: { readonly role: string; readonly force?: boolean },
): void {
  // Nothing mapped, nothing to fence: the server-wide reads ride on a relation's row.
  const first = rows[0];
  if (!first) return;
  if (typeof first.version !== 'number' || first.version < BACKSTOP_VERSION) return denyTenant();
  if (!Array.isArray(first.definers) || first.definers.length) return denyTenant();
  if (!Array.isArray(first.views) || first.views.some((view) => view.kind !== 'v' || !invoker(view.options))) return denyTenant();
  const described = new Map(rows.map((row) => [row.id, row]));
  for (const [logical, rule] of Object.entries(ownership.ownership)) {
    const row = described.get(ownership.resources[logical]);
    if (!row || !Array.isArray(row.policy_detail)) return denyTenant();
    if (rule.kind !== 'tenant') {
      if (row.rls || row.force || row.policies !== 0 || row.policy_detail.length) return denyTenant();
      continue;
    }
    const [policy, ...others] = row.policy_detail;
    if (
      !row.rls ||
      (row.force && security.force !== true) ||
      row.policies !== 1 ||
      others.length ||
      !policy ||
      policy.name !== TENANT_POLICY ||
      policy.cmd !== '*' ||
      policy.permissive !== true ||
      !Array.isArray(policy.roles) ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== security.role ||
      policy.column !== rule.column
    )
      return denyTenant();
  }
}

/**
 * Describes the source's mapped relations and checks every ownership column;
 * returns the description as one comparable string. Call on the source's own
 * snapshot or writer, after the relations are locked.
 */
export async function attestPostgresTenantRelations(
  client: PgQuery,
  ownership: TenantOwnershipSnapshot,
  options: TenantRelationOptions = {},
): Promise<string> {
  const ids = [...new Set(Object.values(ownership.resources))].sort(byCodeUnit);
  const security = options.rowSecurity;
  const tenantIds = Object.entries(ownership.ownership)
    .filter(([, rule]) => rule.kind === 'tenant')
    .map(([logical]) => ownership.resources[logical]);
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
            (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)::int AS policies${security ? BACKSTOP_COLUMNS : ''}
       FROM unnest($1::text[], $2::text[], $3::text[]) AS w(id, schema, name)
       LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
       LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name`,
      security ? [...targets(ids), tenantIds, TENANT_POLICY_TAIL] : targets(ids),
    )
  ).rows as unknown as Relation[];
  if (rows.length !== ids.length || rows.some((row) => typeof row.kind !== 'string' || !Array.isArray(row.columns))) return denyTenant();
  const described = new Map(rows.map((row) => [row.id, row]));
  for (const [logical, rule] of Object.entries(ownership.ownership)) {
    if (rule.kind !== 'tenant') continue;
    const column = described.get(ownership.resources[logical])?.columns.find((field) => field.name === rule.column);
    if (!column || column.deterministic !== true || !/^(text|character varying(\(\d+\))?)$/.test(column.type)) return denyTenant();
  }
  if (security) attestBackstop(rows, ownership, security);
  return JSON.stringify(
    rows
      .map((row) => ({ ...row, constraints: [...row.constraints].sort(byCodeUnit), indexes: [...row.indexes].sort(byCodeUnit) }))
      .sort((a, b) => byCodeUnit(a.id, b.id)),
  );
}

/**
 * The backstop's two roles, each asked as it connects (tenantEnrollment.ts): the owner's, and the runtime role the
 * pinned policy binds. The runtime role must be neither the owner nor a member of it, nor a superuser, nor BYPASSRLS,
 * and must see the same database: each of those reads every tenant's rows whatever the policy says, and the
 * PostgreSQL error that would say so is never raised. Refuses with the reason, which the trusted startup reports.
 */
export async function attestPostgresBackstopRoles(runtime: PgQuery, owner: PgQuery): Promise<{ role: string; ownerRole: string }> {
  const theirs = (await owner.query('SELECT current_user::text AS role, current_database()::text AS db')).rows[0] as
    | { role?: unknown; db?: unknown }
    | undefined;
  if (typeof theirs?.role !== 'string' || typeof theirs.db !== 'string') return denyTenant();
  const mine = (
    await runtime.query(
      `SELECT r.rolname::text AS role, r.rolsuper AS super, r.rolbypassrls AS bypass, current_database()::text AS db,
            o.oid IS NOT NULL AS known, COALESCE(pg_catalog.pg_has_role(r.oid, o.oid, 'MEMBER'), false) AS member
       FROM pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_roles o ON o.rolname = $1
      WHERE r.rolname = current_user`,
      [theirs.role],
    )
  ).rows[0] as { role?: unknown; super?: unknown; bypass?: unknown; db?: unknown; known?: unknown; member?: unknown } | undefined;
  if (typeof mine?.role !== 'string') return denyTenant();
  const refuse = (why: string) => denyTenant(new Error(`The row-security backstop refuses this pair of roles: ${why}`));
  if (mine.db !== theirs.db || mine.known !== true)
    return refuse('"url" and "owner" must name the same database, and the runtime role must see the owner role there.');
  if (mine.role === theirs.role) return refuse('"url" connects as the owner. The runtime role must be another role, which owns nothing.');
  if (mine.super !== false) return refuse('the runtime role is a superuser, which row-level security never binds.');
  if (mine.bypass !== false) return refuse('the runtime role has BYPASSRLS. Run ALTER ROLE … NOBYPASSRLS.');
  if (mine.member !== false) return refuse('the runtime role is a member of the owner role, and so reads as the owner.');
  return { role: mine.role, ownerRole: theirs.role };
}

/** Under the backstop: the runtime role, asked on its own connection, owns no tenant table, directly or through a
 * role it is a member of. A table's owner is exempt from its policies unless FORCE is on, which the backstop does
 * not use. */
export async function assertPostgresRuntimeOwnsNone(client: PgQuery, ownership: TenantOwnershipSnapshot): Promise<void> {
  const tenantIds = Object.entries(ownership.ownership)
    .filter(([, rule]) => rule.kind === 'tenant')
    .map(([logical]) => ownership.resources[logical])
    .sort(byCodeUnit);
  const owned = (
    await client.query(
      `SELECT w.id FROM unnest($1::text[], $2::text[], $3::text[]) AS w(id, schema, name)
       JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name
      WHERE pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
      ORDER BY w.id`,
      targets(tenantIds),
    )
  ).rows as Array<{ id: string }>;
  if (owned.length)
    denyTenant(
      new Error(
        `The row-security backstop refuses this pair of roles: the runtime role owns ${owned.map((row) => row.id).join(', ')}, and a table's owner is exempt from its policy. ALTER TABLE … OWNER TO the owner role.`,
      ),
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
