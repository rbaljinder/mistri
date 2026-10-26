/**
 * Tenant branding on SQLite: the layout, its attestation, the explicit
 * provisioning step and the statements the runtime runs — a tenant's value, a
 * logo by hash, and a save on the writer's own handle inside its transaction.
 *
 * Attested as the inbox's is: SQLite keeps each CREATE statement's text, so
 * the reserved tables must read exactly as this version writes them, with no
 * index, trigger or view of any other kind under the prefix.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  BRANDING_LIMITS,
  BRANDING_PREFIX,
  BRANDING_TABLES,
  BRANDING_VERSION,
  BrandingUnavailable,
  assertBrandingLogoQuery,
  assertBrandingQuery,
  assertBrandingWrite,
  type BrandingLogoQuery,
  type BrandingQuery,
  type BrandingWrite,
  type StoredBranding,
  type StoredBrandingLogo,
} from './branding.js';

const { meta, value, logo } = BRANDING_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${BRANDING_VERSION})
)`,
  ],
  [
    value,
    `CREATE TABLE "${value}" (
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', BRANDING_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', BRANDING_LIMITS.tenant)}),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND ${bytes('value_json', BRANDING_LIMITS.value)}),
  logo_hash TEXT COLLATE BINARY,
  revision INTEGER NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (app, tenant)
)`,
  ],
  [
    logo,
    `CREATE TABLE "${logo}" (
  app TEXT COLLATE BINARY NOT NULL,
  hash TEXT COLLATE BINARY NOT NULL,
  type TEXT NOT NULL,
  bytes BLOB NOT NULL CHECK (length(bytes) <= ${BRANDING_LIMITS.logo}),
  PRIMARY KEY (app, hash)
)`,
  ],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function catalog(db: DatabaseSync): CatalogEntry[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`,
    )
    .all(BRANDING_PREFIX.length, BRANDING_PREFIX, BRANDING_PREFIX.length, BRANDING_PREFIX) as unknown as CatalogEntry[];
}

/** Exactly this version's three tables (and the automatic indexes of their keys), nothing else under the prefix, and its version row. */
export function sqliteBrandingReady(db: DatabaseSync): boolean {
  if (
    db
      .prepare(
        `SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`,
      )
      .get(BRANDING_PREFIX.length, BRANDING_PREFIX, BRANDING_PREFIX.length, BRANDING_PREFIX)
  )
    return false;
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && !(entry.type === 'index' && entry.sql === null && definitions.has(entry.tbl_name)))
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === BRANDING_VERSION;
}

function assertSqliteBranding(db: DatabaseSync): void {
  if (!sqliteBrandingReady(db))
    throw new BrandingUnavailable(layoutRefusal('The branding store', sqliteLayoutVersion(db, meta), BRANDING_VERSION));
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteBranding(existingPath: string): {
  version: typeof BRANDING_VERSION;
  provisioned: boolean;
} {
  if (!statSync(existingPath).isFile()) throw new Refusal('Branding store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(BRANDING_VERSION);
        provisioned = true;
      }
      assertSqliteBranding(db);
      db.exec('COMMIT');
      return { version: BRANDING_VERSION, provisioned };
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

/** One tenant's saved branding in one App, or null when it has saved none. */
/* `attested`: the caller holds an attestation of the layout it has not seen move. */
export function readSqliteBranding(db: DatabaseSync, query: BrandingQuery, attested = false): StoredBranding | null {
  assertBrandingQuery(query);
  if (!attested) assertSqliteBranding(db);
  const row = db
    .prepare(`SELECT value_json, revision, saved_by, saved_at FROM main."${value}" WHERE app = ? AND tenant = ?`)
    .get(query.app, query.tenant) as Record<string, unknown> | undefined;
  return row
    ? {
        value: String(row.value_json),
        revision: Number(row.revision),
        by: String(row.saved_by),
        at: String(row.saved_at),
      }
    : null;
}

/** A logo by the hash of its bytes. */
export function readSqliteBrandingLogo(db: DatabaseSync, query: BrandingLogoQuery, attested = false): StoredBrandingLogo | null {
  assertBrandingLogoQuery(query);
  if (!attested) assertSqliteBranding(db);
  const row = db.prepare(`SELECT type, bytes FROM main."${logo}" WHERE app = ? AND hash = ?`).get(query.app, query.hash) as
    | { type: string; bytes: Uint8Array }
    | undefined;
  return row ? { type: row.type, bytes: new Uint8Array(row.bytes) } : null;
}

/**
 * A save, on the writer's own handle inside a transaction the caller owns:
 * the new logo, the value at the next revision, and the removal of this App's
 * logos no tenant's value names any more. Returns the new revision.
 */
export function writeSqliteBranding(db: DatabaseSync, write: BrandingWrite, attested = false): number {
  assertBrandingWrite(write);
  if (!attested) assertSqliteBranding(db);
  if (write.logo) {
    db.prepare(`INSERT OR IGNORE INTO main."${logo}" (app, hash, type, bytes) VALUES (?, ?, ?, ?)`).run(
      write.app,
      write.logo.hash,
      write.logo.type,
      write.logo.bytes,
    );
  }
  if (write.darkLogo) {
    db.prepare(`INSERT OR IGNORE INTO main."${logo}" (app, hash, type, bytes) VALUES (?, ?, ?, ?)`).run(
      write.app,
      write.darkLogo.hash,
      write.darkLogo.type,
      write.darkLogo.bytes,
    );
  }
  const darkHash = (JSON.parse(write.value) as { logoDark?: { hash?: string } }).logoDark?.hash;
  if (darkHash && !db.prepare(`SELECT 1 FROM main."${logo}" WHERE app = ? AND hash = ?`).get(write.app, darkHash))
    throw new Refusal('Branding: the dark logo the value names is not stored.');
  if (write.logoHash !== null && !db.prepare(`SELECT 1 FROM main."${logo}" WHERE app = ? AND hash = ?`).get(write.app, write.logoHash))
    throw new Refusal('Branding: the logo the value names is not stored.');
  const saved = db
    .prepare(
      `INSERT INTO main."${value}" (app, tenant, value_json, logo_hash, revision, saved_by, saved_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (app, tenant) DO UPDATE SET value_json = excluded.value_json, logo_hash = excluded.logo_hash,
      revision = main."${value}".revision + 1, saved_by = excluded.saved_by, saved_at = excluded.saved_at
    RETURNING revision`,
    )
    .get(write.app, write.tenant, write.value, write.logoHash, write.by, write.at) as { revision: number };
  db.prepare(
    `DELETE FROM main."${logo}" WHERE app = ? AND hash NOT IN
    (SELECT logo_hash FROM main."${value}" WHERE app = ? AND logo_hash IS NOT NULL)
    AND hash NOT IN (SELECT json_extract(value_json, '$.logoDark.hash') FROM main."${value}" WHERE app = ?
      AND json_extract(value_json, '$.logoDark.hash') IS NOT NULL)`,
  ).run(write.app, write.app, write.app);
  return Number(saved.revision);
}
