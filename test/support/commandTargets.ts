/**
 * A receipt row's targets read back one row per target, under the columns the
 * old audit table had (receipt_id, ordinal, owner_tenant_id, key_json,
 * changes_json beside the row's provenance), so a test can ask what a command
 * recorded per target. The journal keeps them in one row
 * (adapters/commands/commandJournalSchema.ts); this is the view a test reads.
 *
 * Each is a parenthesised subquery to put after FROM, with an alias of the
 * caller's choosing: `FROM ${sqliteAuditRows} a`.
 */
import { COMMAND_JOURNAL_TABLES } from '../../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import { runtimeTable } from '../../packages/engine/src/shared/runtimeTables.js';

const provenance = `r.app_id, r.store_id, r.source_id, r.realm, r.tenant_id, r.actor_id, r.membership_id, r.membership_version,
  r.realm_version, r.roles_json, r.deployment, r.target`;

export const sqliteAuditRows = `(SELECT r.id AS receipt_id, CAST(o.key AS INTEGER) AS ordinal, ${provenance},
  o.value AS owner_tenant_id, json_extract(r.keys_json, '$[' || o.key || ']') AS key_json,
  json_extract(r.changes_json, '$[' || o.key || ']') AS changes_json
  FROM ${runtimeTable('sqlite', COMMAND_JOURNAL_TABLES.receipt)} r, json_each(r.owners_json) o)`;

export const postgresAuditRows = `(SELECT r.id AS receipt_id, (o.n - 1)::int AS ordinal, ${provenance},
  o.owner AS owner_tenant_id, r.keys_json::json ->> (o.n - 1)::int AS key_json,
  r.changes_json::json ->> (o.n - 1)::int AS changes_json
  FROM ${runtimeTable('postgres', COMMAND_JOURNAL_TABLES.receipt)} r
  CROSS JOIN LATERAL json_array_elements_text(r.owners_json::json) WITH ORDINALITY AS o(owner, n))`;

export const auditRows = (dialect: 'sqlite' | 'postgres') => (dialect === 'sqlite' ? sqliteAuditRows : postgresAuditRows);

/** The event batches a receipt carries (its manifest, count and digest), read back one row per batch under the old batch table's columns. */
export const sqliteBatchRows = `(SELECT id AS receipt_id, manifest_json, event_count, digest
  FROM ${runtimeTable('sqlite', COMMAND_JOURNAL_TABLES.receipt)} WHERE manifest_json IS NOT NULL)`;
