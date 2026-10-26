/**
 * The PostgreSQL catalog's epoch: one row that moves whenever the schema does.
 *
 * Every transaction that trusts catalog metadata — the command journal's
 * layout, the tables a row scope pins, a table's columns and key — used to
 * read it again (six to eight catalog statements a command), or read the
 * catalog digest (postgresCatalogDigest.ts), one statement that walks every
 * catalog row and costs milliseconds of server time. With this store
 * provisioned, the transaction reads one row instead, and every catalog
 * answer is kept in memory under the epoch it was read at (epochCache.ts).
 *
 * How it moves: an event trigger on `ddl_command_end` appends a row inside
 * the DDL's own transaction, so the change is visible exactly when the DDL
 * commits, and the epoch is a digest of the rows there are, each with its row
 * version (`xmin`). Appending rather than bumping one counter is deliberate:
 * an UPDATE of one row would make every DDL transaction in the database wait
 * on every other, and two migrations that each touch the other's table would
 * then deadlock where today one simply waits. Inserts never wait on each
 * other, and the trigger keeps the newest 64 rows, deleting older ones with
 * SKIP LOCKED so that it never waits either. Any committed DDL adds a row the
 * digest has not seen, and a row put back by hand has a new version, so an
 * old epoch can never come round again. The function is SECURITY DEFINER,
 * owned by whoever provisioned it, so DDL by a role that cannot write the
 * table still moves the epoch — nobody's DDL fails because of this store.
 * ENABLE ALWAYS keeps it firing under `session_replication_role = replica`.
 *
 * What the epoch statement reads besides the rows, so that nothing that could
 * make a cached answer wrong goes unseen:
 * - the event trigger (present, `ENABLE ALWAYS`, on `ddl_command_end`) and its
 *   function's row version: dropped, disabled or replaced, and the statement
 *   answers nothing, which is a miss;
 * - role membership and the attributes privileges depend on: roles are
 *   shared objects, and event triggers do not fire for them.
 *
 * Outside the contract, as for the digest: a superuser who turns event
 * triggers off in a session (`event_triggers = off`) and changes the schema
 * there. That is the superuser deliberately stepping around the database's
 * own notification; a restart, or any other DDL, moves the epoch again.
 *
 * Provisioning is explicit maintenance, never startup (like the journal and
 * the inbox), and needs a role that may create event triggers — a superuser
 * on PostgreSQL 16. Where it is absent, the adapter reads the digest per
 * transaction as before: slower, never less correct.
 */
import { Refusal } from './adapter.js';
import type { PgQuery } from './postgresPool.js';
import { withPostgresMaintenanceTransaction } from './postgresMaintenance.js';
import { RUNTIME_SCHEMA, runtimeTable } from '../shared/runtimeTables.js';

export const SCHEMA_EPOCH_TABLE = 'schema_epoch';
/* The function sits in the runtime schema beside the table (RUNTIME_SCHEMA_FUNCTIONS allows it there).
   An event trigger belongs to the whole database, not to a schema, so its name keeps the reserved prefix. */
const FUNCTION = 'schema_epoch_bump';
const TRIGGER = '__mistri_schema_epoch';

const definitions: readonly string[] = [
  `CREATE TABLE ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
)`,
  `INSERT INTO ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} DEFAULT VALUES`,
  `CREATE FUNCTION ${runtimeTable('postgres', FUNCTION)}() RETURNS event_trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  temporary boolean;
BEGIN
  -- A session's own temporary objects are nobody else's catalog (the digest
  -- skips them too); anything else, or a command that names nothing, moves it.
  SELECT count(*) > 0 AND bool_and(c.schema_name = 'pg_temp') INTO temporary FROM pg_event_trigger_ddl_commands() c;
  IF temporary THEN RETURN; END IF;
  INSERT INTO ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} DEFAULT VALUES;
  DELETE FROM ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} WHERE id IN (
    SELECT id FROM ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} ORDER BY id DESC OFFSET 64 FOR UPDATE SKIP LOCKED);
END
$$`,
  `REVOKE ALL ON FUNCTION ${runtimeTable('postgres', FUNCTION)}() FROM PUBLIC`,
  `CREATE EVENT TRIGGER "${TRIGGER}" ON ddl_command_end EXECUTE FUNCTION ${runtimeTable('postgres', FUNCTION)}()`,
  `ALTER EVENT TRIGGER "${TRIGGER}" ENABLE ALWAYS`,
];

/* With no epoch store a write has no version to file its catalog answers under and asked again every time.
   They are filed under the clock instead: a column changed elsewhere goes unnoticed this long, unless a
   write fails on a missing table or column (schemaMoved), which forgets them at once. The tenant read sources keep a
   passed catalog attestation this long too (tenantReadSource.ts, tenantPlatformSource.ts). */
export const EPOCHLESS_TTL_MS = 5_000;
export const epochlessEpoch = (): string => `ttl:${Math.floor(Date.now() / EPOCHLESS_TTL_MS)}`;

/** Whether a statement failed for a table (42P01) or column (42703) that is not there: the kept catalog is wrong. */
export function schemaMoved(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42P01' || code === '42703';
}

/**
 * The statement that reads the epoch: one row, or none when the store is not
 * whole (trigger disabled or gone). No parameters, so it rides in the
 * message that begins a transaction. A missing store makes the statement
 * fail, which the caller treats as a miss.
 */
export function schemaEpochStatement(): string {
  return `SELECT md5((SELECT coalesce(string_agg(e.id || ':' || e.xmin, ',' ORDER BY e.id), '') FROM ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)} e)
         || '|' || t.xmin::text || '|' || f.xmin::text
         || '|' || (SELECT coalesce(string_agg(m.roleid || '>' || m.member || ':' || m.xmin, ',' ORDER BY m.roleid, m.member), '')
                       FROM pg_catalog.pg_auth_members m)
         || '|' || (SELECT coalesce(string_agg(r.oid || ':' || r.rolname || ':' || r.rolsuper || ':' || r.rolinherit || ':' || r.rolbypassrls, ',' ORDER BY r.oid), '')
                       FROM pg_catalog.pg_roles r)
         || '|' || current_user) AS epoch
  FROM pg_catalog.pg_event_trigger t
  JOIN pg_catalog.pg_proc f ON f.oid = t.evtfoid AND f.proname = '${FUNCTION}' AND f.pronamespace = (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = '${RUNTIME_SCHEMA}')
 WHERE t.evtname = '${TRIGGER}' AND t.evtevent = 'ddl_command_end' AND t.evtenabled = 'A'`;
}

/** The epoch an epoch statement answered, or undefined when the store is not whole. */
export function schemaEpochOf(result: { rows: readonly Record<string, unknown>[] } | undefined): string | undefined {
  const value = result?.rows.length === 1 ? result.rows[0].epoch : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

/** Whether this database holds the epoch store, whole. */
async function postgresSchemaEpochReady(client: PgQuery): Promise<boolean> {
  try {
    return schemaEpochOf(await client.query(schemaEpochStatement())) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Explicit maintenance, under the shared migration lock: creates the store
 * where none exists, changes nothing where it is whole, refuses a partial
 * one. Needs a role that may create event triggers.
 */
export async function provisionPostgresSchemaEpoch(url: string): Promise<{ provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Schema epoch provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const present = await client.query(`SELECT to_regclass('${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)}') IS NOT NULL AS table,
      EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = '${TRIGGER}') AS trigger,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = '${FUNCTION}' AND pronamespace = (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = '${RUNTIME_SCHEMA}')) AS function`);
    const found = present.rows[0] as {
      table: boolean;
      trigger: boolean;
      function: boolean;
    };
    let provisioned = false;
    if (!found.table && !found.trigger && !found.function) {
      try {
        for (const ddl of definitions) await client.query(ddl);
      } catch (error) {
        throw new Refusal(
          `The schema epoch needs a role that may create event triggers (a superuser on PostgreSQL 16): ${(error as Error).message}`,
        );
      }
      provisioned = true;
    }
    if (!(await postgresSchemaEpochReady(client))) {
      throw new Refusal(
        `The schema epoch store is partial or disabled: drop ${runtimeTable('postgres', SCHEMA_EPOCH_TABLE)}, its function and event trigger, then provision again.`,
      );
    }
    return { provisioned };
  });
}
