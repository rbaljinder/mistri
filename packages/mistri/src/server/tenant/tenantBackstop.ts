/**
 * The row-security backstop as a command's output instead of hand-written SQL (docs/postgresql.md): the plan of
 * what a tenant App's database must hold for the runtime role to be bound by the pinned policy, the idempotent SQL
 * that makes it, and the drift between the plan and the database as it is.
 *
 * The plan reads ownership where the start does — the App's own resource catalog over the live schema, and the
 * tenant policy's ownership (tenantEnrollment.ts) — and says what the rc.52 catalog attestation will then demand
 * (tenantPostgresCatalog.ts attestBackstop): every tenant table carries exactly `mistri_tenant` on its own ownership
 * column, to the runtime role, enabled and not forced; every global and platform table carries none. A tenant-keyed
 * table of mistri's own stores (the `mistri` schema) is granted and not fenced: it stays app-fenced, as
 * docs/postgresql.md says. The role's LOGIN and password are the operator's, never written into a file that lands in git.
 */
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { TENANT_POLICY, TENANT_POLICY_TAIL } from '@mistriwork/engine/adapters/scoped/postgresScopeCatalog.js';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import type { AppDef } from '../../shared/app.js';
import { declaredReferences, homeSourceOf, physicalBindings } from '../../shared/appModel.js';
import { appResourceCatalog } from '../app/appResources.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';

/** The first PostgreSQL with a view's `security_invoker`, without which a view reads its tables as its owner. */
const MINIMUM_VERSION = 150000;

/** Why a backstop cannot be planned here, as the sentence to print. */
export class BackstopRefusal extends Error {}

export interface BackstopPlan {
  readonly runtime: string;
  /** Schemas the runtime role needs USAGE on. */
  readonly schemas: readonly string[];
  /** Tables the runtime role touches, as `schema.name`: every one reads; `write` ones insert, update and delete too. */
  readonly tables: ReadonlyArray<{ readonly id: string; readonly write: boolean }>;
  readonly sequences: readonly string[];
  /** Tenant-owned tables, with the column that owns each row: they carry the policy. */
  readonly tenant: ReadonlyArray<{ readonly id: string; readonly column: string }>;
  /** App tables that belong to no tenant, which carry no row security. */
  readonly unfenced: readonly string[];
}

/** What the database holds beside the App's own tables: mistri's store tables and the sequences the grants reach. */
interface BackstopLive {
  readonly storeTables: readonly string[];
  /** Each sequence, with the table that owns it; none for one of a store's own. */
  readonly sequences: ReadonlyArray<{ readonly id: string; readonly of?: string }>;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const located = (id: string) => {
  const dot = id.indexOf('.');
  return { schema: id.slice(0, dot), name: id.slice(dot + 1) };
};
const qualified = (id: string) => `${ident(located(id).schema)}.${ident(located(id).name)}`;

/**
 * Which schemas, tables and sequences get which grants, and which tables get the policy, from the ownership the
 * start reads and what the database holds. A global table is read, never written: its ownership says read-only. A
 * platform table is the owner role's alone, so the runtime role is granted nothing on it.
 */
export function backstopPlan(ownership: TenantOwnershipSnapshot, runtime: string, live: BackstopLive): BackstopPlan {
  if (!runtime) throw new BackstopRefusal('the runtime role needs a name: --runtime <role>.');
  const tables = new Map<string, boolean>();
  const tenant: Array<{ id: string; column: string }> = [];
  const unfenced: string[] = [];
  for (const [logical, rule] of Object.entries(ownership.ownership)) {
    const id = ownership.resources[logical];
    if (id === undefined) continue;
    if (rule.kind === 'tenant') {
      tables.set(id, true);
      tenant.push({ id, column: rule.column });
    } else {
      unfenced.push(id);
      if (rule.kind === 'global') tables.set(id, false);
    }
  }
  for (const id of live.storeTables) tables.set(id, true);
  const ids = [...tables.keys()].sort(byCodeUnit);
  return {
    runtime,
    schemas: [...new Set(ids.map((id) => located(id).schema))].sort(byCodeUnit),
    tables: ids.map((id) => ({ id, write: tables.get(id)! })),
    // The sequences of the tables the runtime role writes, and every one of a store's own.
    sequences: live.sequences
      .filter((sequence) => sequence.of === undefined || tables.get(sequence.of) === true)
      .map((sequence) => sequence.id)
      .sort(byCodeUnit),
    tenant: tenant.sort((a, b) => byCodeUnit(a.id, b.id)),
    unfenced: unfenced.sort(byCodeUnit),
  };
}

/**
 * The plan as idempotent SQL, for a V file: the role (NOLOGIN, NOBYPASSRLS), the grants — never WITH GRANT OPTION,
 * never CREATE, never to PUBLIC — and, per tenant table, row security enabled (not FORCE) and the one policy, dropped
 * and made again so a changed one is replaced. PostgreSQL deparses the policy as TENANT_POLICY_TAIL says.
 */
export function backstopSql(plan: BackstopPlan): string {
  const role = ident(plan.runtime);
  const grant = (privileges: string, kind: string, ids: readonly string[]) =>
    ids.length ? [`GRANT ${privileges} ON ${kind} ${ids.map(qualified).join(', ')} TO ${role};`] : [];
  const writable = plan.tables.filter((table) => table.write).map((table) => table.id);
  const readable = plan.tables.filter((table) => !table.write).map((table) => table.id);
  const compare = (column: string) => `${ident(column)} = NULLIF(current_setting('mistri.tenant', true), '')`;
  return [
    '-- The row-security backstop (docs/postgresql.md), written by `mistri migrate backstop new`: the runtime role, what it',
    '-- may touch, and the one policy that binds it to its tenant. Idempotent: run again, it says the same.',
    '--',
    "-- The role is made NOLOGIN. Letting it sign in, and its password, are the operator's step, run once and never kept",
    '-- in a file that lands in git:  ALTER ROLE ' + role + " LOGIN PASSWORD '<secret>';",
    '--',
    '-- A sequence no table owns (a DEFAULT nextval(...) without OWNED BY) is not granted here: grant it by hand.',
    `DO $backstop$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${literal(plan.runtime)}) THEN CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; END IF; END $backstop$;`,
    ...(plan.schemas.length ? [`GRANT USAGE ON SCHEMA ${plan.schemas.map(ident).join(', ')} TO ${role};`] : []),
    ...grant('SELECT, INSERT, UPDATE, DELETE', 'TABLE', writable),
    ...grant('SELECT', 'TABLE', readable),
    ...grant('USAGE, SELECT', 'SEQUENCE', plan.sequences),
    ...plan.tenant.flatMap(({ id, column }) => [
      `ALTER TABLE ${qualified(id)} ENABLE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS ${TENANT_POLICY} ON ${qualified(id)};`,
      `CREATE POLICY ${TENANT_POLICY} ON ${qualified(id)} AS PERMISSIVE FOR ALL TO ${role} USING (${compare(column)}) WITH CHECK (${compare(column)});`,
    ]),
    '',
  ].join('\n');
}

/**
 * Reads the plan for `app` from the database at `url`: the physical schema as the start describes it, the policy's
 * ownership over the App's own resource catalog, and the store tables and sequences the grants reach. Refuses, with
 * the sentence to print, where the policy leaves a table unowned or names one the database lacks (a start refuses
 * both), and before PostgreSQL 15.
 */
export async function readBackstopPlan(input: {
  app: AppDef;
  policy: AppTenantPolicy;
  url: string;
  runtime: string;
}): Promise<BackstopPlan> {
  const { app, policy } = input;
  const source = homeSourceOf(app);
  if (!source) throw new BackstopRefusal('the App has no home source.');
  const adapter = new PostgresAdapter(input.url, 'Backstop plan');
  try {
    const { physical, version, stores, sequences } = await adapter.readSnapshot(async (snapshot) => {
      const version = Number(
        ((await snapshot.client.query(`SELECT pg_catalog.current_setting('server_version_num') AS v`)).rows[0] as { v: string }).v,
      );
      return { physical: await snapshot.describe(), version, ...(await readStores(snapshot.client)) };
    });
    if (version < MINIMUM_VERSION)
      throw new BackstopRefusal(
        `the backstop needs PostgreSQL 15 or later (this server is ${Math.floor(version / 10000)}): a view reads its tables as its owner before security_invoker, past the policy.`,
      );
    const catalog = appResourceCatalog(physical, physicalBindings(app, source), declaredReferences(app, source));
    const unowned = catalog.schema.tables.map((table) => table.id).filter((id) => !Object.hasOwn(policy.ownership, id));
    const missing = Object.keys(policy.ownership).filter((id) => !catalog.schema.tables.some((table) => table.id === id));
    if (unowned.length || missing.length)
      throw new BackstopRefusal(
        (unowned.length ? `the tenant policy's ownership does not name ${unowned.join(', ')}. ` : '') +
          (missing.length ? `the tenant policy's ownership names ${missing.join(', ')}, which the database does not have. ` : '') +
          'The backstop is planned from the ownership a start reads; make them agree first.',
      );
    // The policy compares the column to a text setting; PostgreSQL has no operator for another type, so CREATE POLICY
    // would fail, and the catalog check reads only these two types' deparsed form. Said before the capture, whose own
    // refusal of such a column is a bare "could not be verified".
    const mistyped = Object.entries(policy.ownership).flatMap(([logical, rule]) => {
      if (rule.kind !== 'tenant') return [];
      const id = catalog.toPhysical(logical);
      const type = physical.tables.find((table) => table.id === id)?.columns.find((each) => each.name === rule.column)?.type;
      return type === undefined || type === 'text' || type === 'character varying' ? [] : [`${id}.${rule.column} is ${type}`];
    });
    if (mistyped.length)
      throw new BackstopRefusal(
        `the ownership column of a tenant table must be text or varchar, which the policy compares to a text setting: ${mistyped.join('; ')}.`,
      );
    const profile = app.auth?.tenancy?.profile;
    const ownership = captureTenantOwnership({
      appId: app.id,
      source: { id: source, connection: app.sources![source].connection },
      physicalSchema: physical,
      schema: catalog.schema,
      resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
      ownership: policy.ownership,
      ...(profile === undefined ? {} : { profile }),
    });
    return backstopPlan(ownership, input.runtime, { storeTables: stores, sequences });
  } finally {
    await adapter.close();
  }
}

/** mistri's store tables, and each sequence with the table that owns it (none for a store's own). */
async function readStores(client: PgQuery) {
  const stores = (
    await client.query(
      `SELECT n.nspname || '.' || c.relname AS id FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY 1`,
      [RUNTIME_SCHEMA],
    )
  ).rows as Array<{ id: string }>;
  const sequences = (
    await client.query(
      `SELECT n.nspname || '.' || s.relname AS id, tn.nspname || '.' || t.relname AS "of"
         FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
         LEFT JOIN pg_catalog.pg_depend d ON d.objid = s.oid AND d.classid = 'pg_catalog.pg_class'::regclass
              AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
         LEFT JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
         LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
        WHERE s.relkind = 'S' AND (n.nspname = $1 OR t.oid IS NOT NULL) ORDER BY 1`,
      [RUNTIME_SCHEMA],
    )
  ).rows as Array<{ id: string; of: string | null }>;
  return {
    stores: stores.map((row) => row.id),
    sequences: sequences.map((row) => ({
      id: row.id,
      ...(row.of !== null && !row.id.startsWith(`${RUNTIME_SCHEMA}.`) ? { of: row.of } : {}),
    })),
  };
}

interface PolicyRow {
  name: string;
  cmd: string;
  permissive: boolean;
  roles: Array<string | null> | null;
  qual: string | null;
  check: string | null;
}

/** The policy expression PostgreSQL deparses for a text or varchar column (TENANT_POLICY_TAIL's two heads); null for another type. */
function expressionOf(type: string, quoted: string): string | null {
  if (type === 'text') return `(${quoted}${TENANT_POLICY_TAIL}`;
  if (/^character varying(\(\d+\))?$/.test(type)) return `((${quoted})::text${TENANT_POLICY_TAIL}`;
  return null;
}

/**
 * What the database lacks or has beside the plan, as sentences; empty when it matches. A missing or changed policy,
 * a second one, row security off or forced, a grant gone or one the plan does not make, a role that does not exist. Fails closed: a policy whose
 * text cannot be read, or that is not exactly the deparsed expression, is a changed policy, and a catalog that
 * cannot be read at all throws.
 */
export async function backstopDrift(plan: BackstopPlan, client: PgQuery): Promise<string[]> {
  const drift: string[] = [];
  const role = (
    await client.query(`SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_catalog.pg_roles WHERE rolname = $1`, [plan.runtime])
  ).rows[0] as { super: boolean; bypass: boolean } | undefined;
  if (!role) drift.push(`the role "${plan.runtime}" does not exist`);
  else if (role.super || role.bypass)
    drift.push(`the role "${plan.runtime}" is ${role.super ? 'a superuser' : 'BYPASSRLS'}, which no policy binds`);

  const fenced = [...plan.tenant.map(({ id, column }) => ({ id, column })), ...plan.unfenced.map((id) => ({ id, column: '' }))];
  const described = (
    await client.query(
      `SELECT w.id, c.oid IS NOT NULL AS found, COALESCE(c.relrowsecurity, false) AS rls, COALESCE(c.relforcerowsecurity, false) AS force,
            (SELECT json_build_object('type', pg_catalog.format_type(a.atttypid, a.atttypmod), 'quoted', pg_catalog.quote_ident(a.attname))
               FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = w.col AND NOT a.attisdropped) AS column,
            COALESCE((SELECT json_agg(json_build_object('name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive,
                'roles', (SELECT json_agg(CASE WHEN r.oid = 0 THEN NULL ELSE ro.rolname END ORDER BY r.ord)
                            FROM unnest(p.polroles) WITH ORDINALITY AS r(oid, ord) LEFT JOIN pg_catalog.pg_roles ro ON ro.oid = r.oid),
                'qual', pg_catalog.pg_get_expr(p.polqual, p.polrelid), 'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))
                ORDER BY p.polname)
               FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid), '[]'::json) AS policies
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS w(id, schema, name, col)
       LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
       LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name`,
      [
        fenced.map((each) => each.id),
        fenced.map((each) => located(each.id).schema),
        fenced.map((each) => located(each.id).name),
        fenced.map((each) => each.column),
      ],
    )
  ).rows as unknown as Array<{
    id: string;
    found: boolean;
    rls: boolean;
    force: boolean;
    column: { type: string; quoted: string } | null;
    policies: PolicyRow[] | null;
  }>;
  if (described.length !== fenced.length) throw new Error('the catalog did not describe every table the backstop plans for');
  const byId = new Map(described.map((row) => [row.id, row]));
  for (const { id, column } of fenced) {
    const row = byId.get(id);
    if (!row || !Array.isArray(row.policies)) throw new Error(`the catalog's policies of ${id} could not be read`);
    if (!row.found) {
      drift.push(`${id} does not exist`);
      continue;
    }
    if (column === '') {
      if (row.rls) drift.push(`${id} has row security on, and no tenant owns it`);
      for (const policy of row.policies) drift.push(`${id} has a policy "${policy.name}", and no tenant owns it`);
      continue;
    }
    if (!row.rls) drift.push(`${id} has row security off`);
    if (row.force) drift.push(`${id} has FORCE ROW LEVEL SECURITY on`);
    for (const policy of row.policies.filter((each) => each.name !== TENANT_POLICY))
      drift.push(`${id} has an extra policy "${policy.name}"`);
    const policy = row.policies.find((each) => each.name === TENANT_POLICY);
    if (!policy) {
      drift.push(`${id} lacks the policy ${TENANT_POLICY}`);
      continue;
    }
    const expected = row.column ? expressionOf(row.column.type, row.column.quoted) : null;
    const roles = Array.isArray(policy.roles) ? policy.roles : [];
    const changed: string[] = [];
    if (expected === null || policy.qual !== expected) changed.push(`USING ${policy.qual ?? '(unreadable)'}`);
    if (expected === null || policy.check !== expected) changed.push(`WITH CHECK ${policy.check ?? '(none)'}`);
    if (policy.cmd !== '*') changed.push('not for every command');
    if (policy.permissive !== true) changed.push('restrictive');
    if (roles.length !== 1 || roles[0] !== plan.runtime)
      changed.push(`to ${roles.map((each) => each ?? 'PUBLIC').join(', ') || 'no role'}`);
    if (changed.length) drift.push(`the policy ${TENANT_POLICY} on ${id} changed: ${changed.join('; ')}`);
  }
  if (!role) return drift;

  const targets = (ids: readonly string[]) => [ids, ids.map((id) => located(id).schema), ids.map((id) => located(id).name)];
  const schemas = (
    await client.query(
      `SELECT s AS id, n.oid IS NOT NULL AS found, COALESCE(pg_catalog.has_schema_privilege($1, n.oid, 'USAGE'), false) AS usage
         FROM unnest($2::text[]) AS w(s) LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.s`,
      [plan.runtime, plan.schemas],
    )
  ).rows as Array<{ id: string; found: boolean; usage: boolean }>;
  for (const row of schemas) if (row.found && !row.usage) drift.push(`the role lacks USAGE on schema ${row.id}`);
  const tables = (
    await client.query(
      `SELECT w.id, w.write, COALESCE(pg_catalog.has_table_privilege($1, c.oid, 'SELECT'), false) AS sel,
              COALESCE(pg_catalog.has_table_privilege($1, c.oid, 'INSERT'), false) AS ins,
              COALESCE(pg_catalog.has_table_privilege($1, c.oid, 'UPDATE'), false) AS upd,
              COALESCE(pg_catalog.has_table_privilege($1, c.oid, 'DELETE'), false) AS del, c.oid IS NOT NULL AS found
         FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[]) AS w(id, schema, name, write)
         LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
         LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name`,
      [plan.runtime, ...targets(plan.tables.map((table) => table.id)), plan.tables.map((table) => table.write)],
    )
  ).rows as Array<{ id: string; write: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean; found: boolean }>;
  for (const row of tables) {
    if (!row.found) continue;
    const lacking = [
      ...(row.sel ? [] : ['SELECT']),
      ...(row.write ? [...(row.ins ? [] : ['INSERT']), ...(row.upd ? [] : ['UPDATE']), ...(row.del ? [] : ['DELETE'])] : []),
    ];
    if (lacking.length) drift.push(`the role lacks ${lacking.join(', ')} on ${row.id}`);
  }
  const sequences = (
    await client.query(
      `SELECT w.id, COALESCE(pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE'), false) AS usage,
              COALESCE(pg_catalog.has_sequence_privilege($1, c.oid, 'SELECT'), false) AS sel
         FROM unnest($2::text[], $3::text[], $4::text[]) AS w(id, schema, name)
         LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = w.schema
         LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = w.name`,
      [plan.runtime, ...targets(plan.sequences)],
    )
  ).rows as Array<{ id: string; usage: boolean; sel: boolean }>;
  for (const row of sequences) if (!row.usage || !row.sel) drift.push(`the role lacks USAGE, SELECT on sequence ${row.id}`);
  drift.push(...(await extraGrants(plan, client)));
  return drift;
}

const TABLE_KINDS = new Set(['r', 'p', 'v', 'm', 'f']);

/**
 * Privileges the runtime role holds, itself, through a role it is a member of, or through PUBLIC, beyond what the plan
 * grants, from the ACLs in the catalog (an unset ACL read as its default, so an owner's implicit rights count, and a
 * column's own grants read beside its table's): any on a table the plan grants nothing, a write on a read-only one,
 * TRUNCATE, REFERENCES or TRIGGER on any, more than USAGE and SELECT on a planned sequence, anything WITH GRANT OPTION,
 * CREATE on a schema, and the runtime role being, or being a member of, the role that owns a tenant table. The
 * schemas read are the plan's and those of the tables it grants nothing on, so a platform table in a schema of its
 * own is read too. Two round trips, however many tables.
 */
async function extraGrants(plan: BackstopPlan, client: PgQuery): Promise<string[]> {
  const drift: string[] = [];
  const audited = [...new Set([...plan.schemas, ...plan.unfenced.map((id) => located(id).schema)])].sort(byCodeUnit);
  /* Whose an ACL entry is: PUBLIC, the runtime role, or a role it is a member of (named, so the line says through whom). */
  const holder = (grantee: string) => `CASE WHEN ${grantee} = 0 THEN true ELSE pg_catalog.pg_has_role($1::name, ${grantee}, 'MEMBER') END`;
  const via = (grantee: string) =>
    `CASE WHEN ${grantee} = 0 OR pg_catalog.pg_get_userbyid(${grantee}) = $1::name THEN NULL ELSE pg_catalog.pg_get_userbyid(${grantee}) END`;
  const grants = (
    await client.query(
      `SELECT n.nspname || '.' || c.relname AS id, c.relkind AS kind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
              pg_catalog.pg_has_role($1::name, c.relowner, 'MEMBER') AS member,
              a.col, a.privilege, a.grantable, a.public, a.via
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN LATERAL (
              SELECT e.col, e.privilege_type AS privilege, e.is_grantable AS grantable, e.grantee = 0 AS public, ${via('e.grantee')} AS via
                FROM (SELECT NULL::text AS col, x.grantee, x.privilege_type, x.is_grantable
                        FROM pg_catalog.aclexplode(COALESCE(c.relacl,
                             pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) x
                      UNION ALL
                      SELECT t.attname::text, x.grantee, x.privilege_type, x.is_grantable
                        FROM pg_catalog.pg_attribute t, pg_catalog.aclexplode(t.attacl) x
                       WHERE t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped AND t.attacl IS NOT NULL) e
               WHERE ${holder('e.grantee')}) a ON true
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND (n.nspname = ANY($2::text[]) OR n.nspname || '.' || c.relname = ANY($3::text[]))
        ORDER BY 1, a.col NULLS FIRST, a.privilege`,
      [plan.runtime, audited, plan.sequences],
    )
  ).rows as Array<{
    id: string;
    kind: string;
    owner: string;
    member: boolean;
    col: string | null;
    privilege: string | null;
    grantable: boolean | null;
    public: boolean | null;
    via: string | null;
  }>;
  const planned = new Map(plan.tables.map((table) => [table.id, table.write]));
  const sequences = new Set(plan.sequences);
  const owned = new Set(plan.tenant.map(({ id }) => id));
  const owners = new Set<string>();
  const whomOf = (row: { public: boolean | null; via: string | null }) =>
    row.public ? 'PUBLIC' : row.via ? `${plan.runtime} through "${row.via}"` : plan.runtime;
  const found = new Map<string, { what: string; whom: string; plain: string[]; option: string[] }>();
  for (const row of grants) {
    if (owned.has(row.id) && row.member) owners.add(row.owner);
    if (row.privilege === null) continue;
    const isSequence = row.kind === 'S';
    if (isSequence ? !sequences.has(row.id) : !TABLE_KINDS.has(row.kind)) continue;
    const whom = whomOf(row);
    // What the plan grants the runtime role itself: SELECT (and the write four on a writable table); a sequence's USAGE
    // and SELECT. Nothing to PUBLIC, and a column grant is judged as its table's would be.
    const write = planned.get(row.id);
    const allowed = row.public
      ? []
      : isSequence
        ? ['USAGE', 'SELECT']
        : write === undefined
          ? []
          : write
            ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
            : ['SELECT'];
    const what = row.col === null ? row.id : `${row.id} column ${row.col}`;
    const key = `${what}\0${whom}`;
    const entry = found.get(key) ?? { what, whom, plain: [], option: [] };
    found.set(key, entry);
    if (row.grantable) entry.option.push(row.privilege);
    else if (!allowed.includes(row.privilege)) entry.plain.push(row.privilege);
  }
  for (const { what, whom, plain, option } of found.values()) {
    if (plain.length) drift.push(`${what} grants ${whom} ${plain.join(', ')}, which the plan does not`);
    if (option.length) drift.push(`${what} grants ${whom} ${option.join(', ')} WITH GRANT OPTION, which the plan does not`);
  }
  for (const owner of [...owners].sort(byCodeUnit))
    drift.push(
      owner === plan.runtime
        ? `the role "${plan.runtime}" owns the tenant tables, which no policy binds`
        : `the role "${plan.runtime}" is a member of "${owner}", which owns tenant tables, so no policy binds it there`,
    );
  const schemaGrants = (
    await client.query(
      `SELECT n.nspname AS id, a.privilege_type AS privilege, a.is_grantable AS grantable, a.grantee = 0 AS public, ${via('a.grantee')} AS via
         FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
        WHERE n.nspname = ANY($2::text[]) AND ${holder('a.grantee')}
        ORDER BY 1, 2`,
      [plan.runtime, audited],
    )
  ).rows as Array<{ id: string; privilege: string; grantable: boolean; public: boolean; via: string | null }>;
  for (const row of schemaGrants) {
    const whom = whomOf(row);
    if (row.grantable) drift.push(`schema ${row.id} grants ${whom} ${row.privilege} WITH GRANT OPTION, which the plan does not`);
    else if (row.privilege === 'CREATE') drift.push(`schema ${row.id} grants ${whom} CREATE, which the plan does not`);
  }
  return drift;
}
