/**
 * The validation record's names and bounds, shared by its store
 * (postgresValidationRecord.ts) and the start that reads and writes it
 * (server/tenant/tenantValidationRecord.ts).
 *
 * One row per App and source: the build and the catalog a production start
 * last validated against, so the next start of the same build on the same
 * catalog — a restart, a second instance, a scale-out — reads one row instead
 * of checking the App against the database again.
 */
export const VALIDATION_RECORD_VERSION = 1;
export const VALIDATION_RECORD_PREFIX = '__mistri_validation_';
export const VALIDATION_RECORD_TABLES = Object.freeze({
  meta: `${VALIDATION_RECORD_PREFIX}meta`,
  record: `${VALIDATION_RECORD_PREFIX}record`,
});

/** Bounds, enforced by the layout: a digest is hex, the per-table set is one entry a resource. */
export const VALIDATION_RECORD_LIMITS = Object.freeze({ app: 128, source: 128, digest: 64, schema: 4096, migration: 128, mistri: 64 });
