/** The SQLite layout of the analytics store: `__mistri_analytics_*` tables and triggers that make events insert-only. */
import type { MigrationDb } from '@mistriwork/engine/server/migrate/database.js';

export const SQLITE_ANALYTICS_PREFIX = '__mistri_analytics_';
const P = SQLITE_ANALYTICS_PREFIX;

export const sqliteAnalyticsDdl = (): string => `
CREATE TABLE "${P}meta" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  app_id TEXT NOT NULL CHECK (typeof(app_id) = 'text' AND length(CAST(app_id AS BLOB)) BETWEEN 1 AND 128),
  deployment_id TEXT NOT NULL CHECK (typeof(deployment_id) = 'text' AND length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 128)
);
CREATE TABLE "${P}events" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at BETWEEN 0 AND 9007199254740991),
  received_at INTEGER NOT NULL CHECK (typeof(received_at) = 'integer' AND received_at BETWEEN 0 AND 9007199254740991),
  environment TEXT NOT NULL CHECK (typeof(environment) = 'text' AND length(CAST(environment AS BLOB)) BETWEEN 1 AND 128),
  tenant_id TEXT CHECK (tenant_id IS NULL OR (typeof(tenant_id) = 'text' AND length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 128)),
  kind TEXT NOT NULL CHECK (kind IN ('view', 'action', 'form', 'event', 'business')),
  name TEXT NOT NULL CHECK (typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 128),
  step TEXT CHECK (step IS NULL OR (typeof(step) = 'text' AND length(CAST(step AS BLOB)) BETWEEN 1 AND 128)),
  unit_kind TEXT CHECK (unit_kind IS NULL OR unit_kind IN ('subject', 'visitor')),
  unit_id TEXT CHECK (unit_id IS NULL OR (typeof(unit_id) = 'text' AND length(CAST(unit_id AS BLOB)) BETWEEN 1 AND 128)),
  fields TEXT NOT NULL CHECK (typeof(fields) = 'text' AND json_valid(fields) AND json_type(fields) = 'object' AND length(CAST(fields AS BLOB)) <= 4096),
  source_event_id TEXT UNIQUE CHECK (source_event_id IS NULL OR (typeof(source_event_id) = 'text' AND length(CAST(source_event_id AS BLOB)) BETWEEN 1 AND 128)),
  CHECK ((unit_kind IS NULL) = (unit_id IS NULL))
);
CREATE INDEX "${P}events_name_unit" ON "${P}events" (name, unit_id, occurred_at);
CREATE INDEX "${P}events_occurred_at" ON "${P}events" (occurred_at);
CREATE TABLE "${P}sink_cursors" (
  sink_id TEXT PRIMARY KEY CHECK (typeof(sink_id) = 'text' AND length(CAST(sink_id AS BLOB)) BETWEEN 1 AND 128),
  after_id INTEGER NOT NULL CHECK (typeof(after_id) = 'integer' AND after_id >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991)
);
/* Retention's one door: prune holds a row here for the length of its delete. */
CREATE TABLE "${P}prune" (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));
CREATE TRIGGER "${P}events_no_update" BEFORE UPDATE ON "${P}events"
BEGIN SELECT RAISE(ABORT, 'Analytics events are append-only.'); END;
CREATE TRIGGER "${P}events_no_delete" BEFORE DELETE ON "${P}events" WHEN NOT EXISTS (SELECT 1 FROM "${P}prune")
BEGIN SELECT RAISE(ABORT, 'Analytics events are append-only; retention goes through prune.'); END;
`;

/** Tables that are not the store's own: a business or identity database is not ours. */
export async function sqliteForeignRelations(db: MigrationDb): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE ? ESCAPE '\\' ORDER BY name`,
    [`${P.replace(/_/g, '\\_')}%`],
  );
  return rows.map((row) => row.name);
}
