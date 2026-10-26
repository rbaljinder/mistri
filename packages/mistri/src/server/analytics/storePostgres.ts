/** The PostgreSQL layout of the analytics store: three `analytics_*` tables in the runtime schema, a trigger that makes
 * events insert-only. The schema itself is made by ensurePostgresRuntimeSchema (adapters/postgresMaintenance.ts). */
import type { MigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';

const S = RUNTIME_SCHEMA;
/** The store's tables, indexes and trigger function are named under it, beside other stores' in the runtime schema. */
export const POSTGRES_ANALYTICS_PREFIX = 'analytics_';

export const postgresAnalyticsDdl = (): string => `
CREATE TABLE ${S}.analytics_meta (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = 1),
  app_id text COLLATE "C" NOT NULL CHECK (octet_length(app_id) BETWEEN 1 AND 128),
  deployment_id text COLLATE "C" NOT NULL CHECK (octet_length(deployment_id) BETWEEN 1 AND 128)
);
CREATE TABLE ${S}.analytics_events (
  id bigserial PRIMARY KEY,
  occurred_at bigint NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
  received_at bigint NOT NULL CHECK (received_at BETWEEN 0 AND 9007199254740991),
  environment text COLLATE "C" NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 128),
  tenant_id text COLLATE "C" CHECK (tenant_id IS NULL OR octet_length(tenant_id) BETWEEN 1 AND 128),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('view', 'action', 'form', 'event', 'business')),
  name text COLLATE "C" NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128),
  step text COLLATE "C" CHECK (step IS NULL OR octet_length(step) BETWEEN 1 AND 128),
  unit_kind text COLLATE "C" CHECK (unit_kind IS NULL OR unit_kind IN ('subject', 'visitor')),
  unit_id text COLLATE "C" CHECK (unit_id IS NULL OR octet_length(unit_id) BETWEEN 1 AND 128),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 4096),
  source_event_id text COLLATE "C" UNIQUE CHECK (source_event_id IS NULL OR octet_length(source_event_id) BETWEEN 1 AND 128),
  CHECK ((unit_kind IS NULL) = (unit_id IS NULL))
);
CREATE INDEX analytics_events_occurred_at ON ${S}.analytics_events USING brin (occurred_at);
CREATE INDEX analytics_events_name_unit ON ${S}.analytics_events USING btree (name, unit_id, occurred_at);
CREATE TABLE ${S}.analytics_sink_cursors (
  sink_id text COLLATE "C" PRIMARY KEY CHECK (octet_length(sink_id) BETWEEN 1 AND 128),
  after_id bigint NOT NULL CHECK (after_id >= 0),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);
CREATE FUNCTION ${S}.analytics_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('mistri.analytics_prune', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Analytics events are append-only; retention goes through prune.';
END $body$;
CREATE TRIGGER analytics_events_append_only BEFORE UPDATE OR DELETE ON ${S}.analytics_events FOR EACH ROW EXECUTE FUNCTION ${S}.analytics_append_only();
CREATE TRIGGER analytics_events_no_truncate BEFORE TRUNCATE ON ${S}.analytics_events FOR EACH STATEMENT EXECUTE FUNCTION ${S}.analytics_append_only();
`;

/** Relations other than the store's own tables that a database must not hold: a business or identity database is not
 * ours, and neither is another store's table beside them in the runtime schema. */
export async function postgresForeignRelations(db: MigrationDb): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      AND NOT (n.nspname = ? AND lower(c.relname) LIKE 'analytics\\_%') ORDER BY 1`,
    [RUNTIME_SCHEMA],
  );
  return rows.map((row) => row.name);
}

/** The migration connection as the PgQuery the shared runtime-schema helpers take: they write `$n` placeholders and
 * no `?`, which is the only thing the connection rewrites. */
export const postgresQueryOf = (db: MigrationDb): PgQuery =>
  ({ query: async (text: string, params?: unknown[]) => ({ rows: await db.all(text, params), rowCount: null }) }) as unknown as PgQuery;
