/**
 * The tenant switch on SQLite: its layout, its attestation, and the steps the
 * assistant and decision stores take inside their own provisioning (they
 * share one table, so neither provisions it alone). Attested as the
 * assistant's is: SQLite keeps each CREATE statement's text, so the two
 * tables must read exactly as this version writes them.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { TENANT_SWITCH_LIMITS, TENANT_SWITCH_PREFIX, TENANT_SWITCH_TABLES, TENANT_SWITCH_VERSION } from './tenantSwitch.js';

const { meta, tenant } = TENANT_SWITCH_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${TENANT_SWITCH_VERSION})
)`,
  ],
  [
    tenant,
    `CREATE TABLE "${tenant}" (
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', TENANT_SWITCH_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', TENANT_SWITCH_LIMITS.tenant)}),
  feature TEXT COLLATE BINARY NOT NULL CHECK (${bytes('feature', TENANT_SWITCH_LIMITS.feature)}),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  consent TEXT NOT NULL CHECK (${bytes('consent', TENANT_SWITCH_LIMITS.consent)}),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (app, tenant, feature)
)`,
  ],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const catalog = (db: DatabaseSync): CatalogEntry[] =>
  db
    .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(TENANT_SWITCH_PREFIX.length, TENANT_SWITCH_PREFIX, TENANT_SWITCH_PREFIX.length, TENANT_SWITCH_PREFIX) as unknown as CatalogEntry[];

/** Exactly this version's two tables, nothing else under the prefix, and its version row. */
export function sqliteTenantSwitchReady(db: DatabaseSync): boolean {
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    // The only index is the primary key's own, which carries no statement.
    entries.some((entry) => entry.type !== 'table' && !(entry.type === 'index' && entry.sql === null && definitions.has(entry.tbl_name)))
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === TENANT_SWITCH_VERSION;
}

/**
 * Inside the caller's transaction: creates the store where none is there,
 * changes nothing where it is, and refuses anything else under the prefix.
 * Returns whether this call made it.
 */
export function provisionSqliteTenantSwitch(db: DatabaseSync): boolean {
  let provisioned = false;
  if (catalog(db).length === 0) {
    for (const ddl of definitions.values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(TENANT_SWITCH_VERSION);
    provisioned = true;
  }
  if (!sqliteTenantSwitchReady(db))
    throw new Refusal(
      layoutRefusal('The tenant switch store', sqliteLayoutVersion(db, meta), TENANT_SWITCH_VERSION) ??
        'The tenant switch store is not the layout this version expects.',
    );
  return provisioned;
}

/** Explicit maintenance for the store on its own: the same step, in a transaction of its own over an existing file. */
export function provisionSqliteTenantSwitchAt(existingPath: string): { version: typeof TENANT_SWITCH_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Tenant switch store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const provisioned = provisionSqliteTenantSwitch(db);
      db.exec('COMMIT');
      return { version: TENANT_SWITCH_VERSION, provisioned };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve the provisioning failure. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}
