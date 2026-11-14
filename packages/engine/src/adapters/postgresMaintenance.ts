/**
 * One maintenance transaction under the shared migration lock, on a private
 * client: every reserved store's migration, the schema epoch's provisioning
 * among them, runs its existence check and DDL inside it, so no two race.
 *
 * Engine, because the epoch store (postgresSchemaEpoch.ts) is the engine's
 * and provisions under this lock; the App stores' migrations import it too.
 */
import { Refusal } from './adapter.js';
import { pgConnectionOptions } from './postgresValues.js';
import type { PgQuery } from './postgresPool.js';
import { RUNTIME_CONTROL_PREFIXES, RUNTIME_SCHEMA, RUNTIME_SCHEMA_FUNCTIONS } from '../shared/runtimeTables.js';

/* A single key for every migration of every tablewalk journal on the server:
   two operators running the step at once serialise instead of racing the
   existence check. Arbitrary, fixed, and unlikely to collide with an
   application's own advisory locks. */
export const MIGRATION_LOCK = '7431627679384207';

const CONNECT_TIMEOUT_MS = 15_000;
/** How long a maintenance transaction waits for the shared migration lock before it says who it is waiting for: a holder that never lets go must not stall a boot forever. */
const LOCK_WAIT_MS = 60_000;

/** One private client for `run`, ended after it: a store's few statements outside any pool (the validation record's). */
export async function withPostgresClient<T>(url: string, run: (client: PgQuery) => Promise<T>): Promise<T> {
  return withClient(url, run);
}

async function withClient<T>(url: string, run: (client: PgQuery) => Promise<T>): Promise<T> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Command journal migration requires a postgres:// URL.');
  const specifier = 'pg';
  const pg = (await import(specifier).catch(() => {
    throw new Error('Postgres support needs the "pg" package. Install it with: npm install pg');
  })) as {
    Client?: new (
      options: unknown,
    ) => PgQuery & { connect(): Promise<void>; end(): Promise<void>; on(event: 'error', listener: (error: Error) => void): unknown };
  };
  const Client = pg.Client ?? (pg as { default?: typeof pg }).default?.Client;
  if (!Client) throw new Error('Could not find a Client export in the "pg" package.');
  /* A host that does not answer fails the connect instead of stalling a boot. */
  const client = new Client({ ...pgConnectionOptions(url), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  /* pg emits 'error' on a connection that drops while it is idle between statements (a failover, a proxy reset); with
     no listener that is an uncaught exception and takes the server down. A statement running on it, or the next one,
     rejects with the same loss, so nothing is swallowed that the caller would not see. */
  client.on('error', () => {});
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** One maintenance transaction under the shared migration lock, on a private
 * client: the journal migration and the event-store provisioning both run
 * their existence check and DDL inside it, so neither can race the other. */
export async function withPostgresMaintenanceTransaction<T>(url: string, run: (client: PgQuery) => Promise<T>): Promise<T> {
  return withClient(url, async (client) => {
    await client.query('BEGIN');
    try {
      // lock_timeout bounds an advisory-lock wait too; it ends with this transaction.
      await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`);
      try {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK]);
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') {
          throw new Refusal(
            `Another migration or maintenance step has held the shared migration lock for ${LOCK_WAIT_MS / 1000}s. Try again when it has finished.`,
          );
        }
        throw error;
      }
      // Every store this runs provisions into the runtime schema; a refusal rolls the schema back with the rest.
      await ensurePostgresRuntimeSchema(client);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        /* Preserve the maintenance failure. */
      });
      throw error;
    }
  });
}

/**
 * The runtime schema (shared/runtimeTables.ts), created where it is absent and
 * private to the role that made it: a new schema grants PUBLIC nothing, and the
 * REVOKE says so whatever the server's default privileges add. Existence is read
 * first because CREATE SCHEMA checks the database privilege before IF NOT EXISTS,
 * and a suite's control role, granted CREATE on the schema, may hold none.
 * Returns whether this call created it.
 */
export async function ensurePostgresRuntimeSchema(client: PgQuery): Promise<boolean> {
  if ((await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [RUNTIME_SCHEMA])).rows.length) return false;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${RUNTIME_SCHEMA}`);
  await client.query(`REVOKE ALL ON SCHEMA ${RUNTIME_SCHEMA} FROM PUBLIC`);
  return true;
}

/* The tenant backstop's role pairs, runtime to owner (declareBackstopRoles), once a tenant App's startup has
   attested them: none without the backstop, and then every statement below is the one it was. */
const backstopRoles = new Map<string, string>();

/**
 * Under the tenant row-security backstop, the App connects as `runtime` and its stores belong to `owner`, which
 * migrated them. Declared once the startup attestation has proved the pair (two roles, the runtime neither
 * superuser, BYPASSRLS nor a member of the owner): from then on a store attestation on either role's connection
 * takes the owner's view of ownership and allows the runtime its DML (postgresRuntimeSchemaProblems). A runtime paired with a second, different owner is refused: a store has one owner.
 */
export function declareBackstopRoles(runtime: string, owner: string): void {
  if (typeof runtime !== 'string' || !runtime || typeof owner !== 'string' || !owner || runtime === owner)
    throw new TypeError('A backstop pairs two role names.');
  const held = backstopRoles.get(runtime);
  if (held !== undefined && held !== owner) throw new Refusal(`The role "${runtime}" already runs as the runtime of another owner.`);
  backstopRoles.set(runtime, owner);
}

/** Forget every declared pair: a process's tenant pools closing (tenantConnections.forgetTenantPools). */
export function forgetBackstopRoles(): void {
  backstopRoles.clear();
}

/* The pair the connecting role belongs to, as SQL over two text-array parameters at `at`: a CTE `bk(rt, owner)`
   holding it, or nothing. */
const backstopPair = (at: number) =>
  `bk AS (SELECT p.rt, p.owner FROM pg_catalog.unnest($${at}::text[], $${at + 1}::text[]) AS p(rt, owner)
           WHERE CURRENT_USER IN (p.rt, p.owner) LIMIT 1)`;
const backstopValues = () => [[...backstopRoles.keys()], [...backstopRoles.values()]];

/* A role the store may belong to: the connecting role itself, or a role
   whose privileges it inherits, so a deployment can migrate as one member
   of an owning group and run as another. A superuser is an implicit member
   of every role, which would make every owner pass, so for a superuser
   only itself counts. PUBLIC (grantee 0) is never ours. */
/* What the runtime role may hold on a store's relation or column: reading and writing its rows, and a sequence's nextval. */
const DML = `'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'USAGE'`;

const ours = (role: string) =>
  `COALESCE(${role} = me.oid OR (NOT me.rolsuper AND ${role} <> 0 AND pg_catalog.pg_has_role(me.oid, ${role}, 'USAGE')), false)`;

/**
 * What makes a store's part of the runtime schema not this role's alone, as
 * sentences; empty when it is. The schema: owned by this role (or, for a
 * suite's flag or experiment control running as its own role, `delegated`,
 * granted USAGE and CREATE on it by the owner); no privilege on it for PUBLIC
 * or any other role, except the roles that own a control store's tables
 * (RUNTIME_CONTROL_PREFIXES), whose grant is that delegation; and nothing in it
 * but tables, sequences and the runtime's own trigger functions, since Better
 * Auth resolves its unqualified names through it. The store's own relations,
 * the ones named under `prefix`: owned by this role, with no privilege held on
 * them or their columns by any other. A grant on `public`, a reporting role's
 * `SELECT ON ALL TABLES IN SCHEMA public`, reaches none of this.
 *
 * `runtime`, under the tenant row-security backstop: the role the App runs
 * as, which is not this one and needs the store too. It alone may hold USAGE
 * on the schema and SELECT, INSERT, UPDATE, DELETE or a sequence's USAGE on
 * the store's relations and columns, never with GRANT OPTION — never CREATE,
 * never ownership, and PUBLIC and every other role are refused as before.
 */
export async function postgresRuntimeSchemaProblems(
  client: PgQuery,
  prefix: string,
  options: { delegated?: boolean; runtime?: string } = {},
): Promise<string[]> {
  if (options.runtime !== undefined && (typeof options.runtime !== 'string' || !options.runtime))
    throw new TypeError('A runtime role is a role name.');
  /* `rt.oid` is null without a runtime role, so nothing, PUBLIC included, is the runtime's and every grant counts as before. */
  const runtime = (grantee: string, privilege: string, kinds: string) =>
    `COALESCE(${grantee} = rt.oid AND ${privilege} IN (${kinds}), false)`;
  /* Under a declared backstop pair (declareBackstopRoles) the checks take the owner's view, on either role's
     connection, and the runtime is the pair's unless the caller named one. */
  const paired = backstopRoles.size > 0;
  const roles = paired
    ? `${backstopPair(7)},
          me AS (SELECT r.oid, r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = COALESCE((SELECT owner FROM bk), CURRENT_USER)),
          rt AS (SELECT (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = COALESCE($6::text, (SELECT bk.rt FROM bk))) AS oid),`
    : `me AS (SELECT r.oid, r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER),
          rt AS (SELECT (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = $6::text) AS oid),`;
  const row = (
    await client.query(
      `WITH ${roles}
          ns AS (SELECT n.oid, n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
          acl AS (SELECT a.grantee, a.privilege_type FROM ns, pg_catalog.aclexplode(COALESCE(ns.nspacl, pg_catalog.acldefault('n', ns.nspowner))) a),
          control AS (SELECT DISTINCT c.relowner AS role FROM ns, pg_catalog.pg_class c
                       WHERE c.relnamespace = ns.oid AND pg_catalog.lower(c.relname) LIKE ANY ($4::text[])),
          rel AS (SELECT c.oid, c.relowner, c.relacl FROM ns, pg_catalog.pg_class c
                   WHERE c.relnamespace = ns.oid AND pg_catalog.lower(pg_catalog.substr(c.relname, 1, $3)) = $2)
     SELECT EXISTS (SELECT 1 FROM ns) AS present,
            COALESCE((SELECT ${ours('ns.nspowner')} FROM ns, me), false) AS owned,
            COALESCE((SELECT pg_catalog.has_schema_privilege(ns.oid, 'CREATE') AND pg_catalog.has_schema_privilege(ns.oid, 'USAGE') FROM ns), false) AS granted,
            EXISTS (SELECT 1 FROM acl, ns, me WHERE acl.privilege_type = 'CREATE' AND acl.grantee <> ns.nspowner AND NOT ${ours('acl.grantee')}
                     AND acl.grantee NOT IN (SELECT role FROM control)) AS "foreignCreate",
            EXISTS (SELECT 1 FROM acl, ns, me, rt WHERE acl.grantee <> ns.nspowner AND NOT ${ours('acl.grantee')}
                     AND acl.grantee NOT IN (SELECT role FROM control)
                     AND NOT ${runtime('acl.grantee', 'acl.privilege_type', "'USAGE'")}) AS "foreignUsage",
            EXISTS (SELECT 1 FROM rel, me WHERE NOT ${ours('rel.relowner')}) AS "foreignOwner",
            EXISTS (SELECT 1 FROM rel, me, rt, pg_catalog.aclexplode(rel.relacl) a WHERE NOT ${ours('a.grantee')}
                     AND NOT (${runtime('a.grantee', 'a.privilege_type', DML)} AND NOT a.is_grantable))
            OR EXISTS (SELECT 1 FROM rel, me, rt, pg_catalog.pg_attribute t, pg_catalog.aclexplode(t.attacl) a
                        WHERE t.attrelid = rel.oid AND NOT ${ours('a.grantee')}
                          AND NOT (${runtime('a.grantee', 'a.privilege_type', DML)} AND NOT a.is_grantable)) AS "foreignGrant",
            COALESCE((SELECT (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = ns.oid AND proname <> ALL ($5::text[]))
                           + (SELECT count(*) FROM pg_catalog.pg_operator WHERE oprnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typnamespace = ns.oid AND t.typrelid = 0
                                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e
                                                 WHERE e.oid = t.typelem AND e.typrelid <> 0 AND e.typarray = t.oid))
                           + (SELECT count(*) FROM pg_catalog.pg_collation WHERE collnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_conversion WHERE connamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_opclass WHERE opcnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_opfamily WHERE opfnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_ts_config WHERE cfgnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_ts_dict WHERE dictnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_ts_parser WHERE prsnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_ts_template WHERE tmplnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_statistic_ext WHERE stxnamespace = ns.oid)
                           + (SELECT count(*) FROM pg_catalog.pg_extension WHERE extnamespace = ns.oid)
                        FROM ns), 0)::int AS objects,
            EXISTS (SELECT 1 FROM ns, pg_catalog.pg_constraint k JOIN pg_catalog.pg_class f ON f.oid = k.confrelid
                     WHERE k.contype = 'f' AND (k.connamespace = ns.oid) <> (f.relnamespace = ns.oid)) AS "crossing"`,
      [
        RUNTIME_SCHEMA,
        prefix.toLowerCase(),
        prefix.length,
        RUNTIME_CONTROL_PREFIXES.map((each) => `${each.replaceAll('_', '\\_')}%`),
        RUNTIME_SCHEMA_FUNCTIONS,
        options.runtime ?? null,
        ...(paired ? backstopValues() : []),
      ],
    )
  ).rows[0] as
    | {
        present: boolean;
        owned: boolean;
        granted: boolean;
        foreignCreate: boolean;
        foreignUsage: boolean;
        foreignOwner: boolean;
        foreignGrant: boolean;
        objects: number;
        crossing: boolean;
      }
    | undefined;
  if (!row) return ['its catalog could not be read'];
  if (row.present !== true) return [`the "${RUNTIME_SCHEMA}" schema is missing`];
  const problems: string[] = [];
  if (row.owned !== true && !(options.delegated === true && row.granted === true)) problems.push('it is owned by another role');
  if (row.foreignCreate !== false) problems.push('another role may create objects in it');
  else if (row.foreignUsage !== false) problems.push('another role may use it');
  if (row.foreignOwner !== false) problems.push('a relation in it is owned by another role');
  if (row.foreignGrant !== false) problems.push('another role holds privileges on its tables');
  if (row.objects !== 0) problems.push("it holds functions, operators, types or other objects besides the store's tables");
  // No store's table references a business table or is referenced by one: such a key would be a dependency between the
  // App's data and the runtime's that neither catalog shows, and could hold back a delete the App never sees refused.
  if (row.crossing !== false) problems.push('a foreign key crosses between it and another schema');
  return problems;
}
