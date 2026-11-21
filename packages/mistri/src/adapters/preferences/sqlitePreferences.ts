/**
 * The preferences store on SQLite: the layout, its attestation, the explicit provisioning step, and a private
 * connection the store's statements run on.
 *
 * Attested as the assistant's is: SQLite keeps each CREATE statement's text, so the reserved tables must read exactly
 * as this version writes them, with nothing else under the prefix. The connection is its own — a preference is never
 * written inside a business write, so it has no handle of the adapter's to share.
 */
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  PREFERENCES_LIMITS,
  PREFERENCES_PREFIX,
  PREFERENCES_TABLES,
  PREFERENCES_VERSION,
  PreferencesUnavailable,
  createPreferencesStore,
  type Db,
  type PreferencesStore,
  type Row,
} from './preferences.js';

const { meta, value } = PREFERENCES_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${PREFERENCES_VERSION})
)`,
  ],
  [
    value,
    `CREATE TABLE "${value}" (
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', PREFERENCES_LIMITS.app)}),
  subject_id TEXT COLLATE BINARY NOT NULL CHECK (${bytes('subject_id', PREFERENCES_LIMITS.subject)}),
  scope TEXT COLLATE BINARY NOT NULL CHECK (${bytes('scope', PREFERENCES_LIMITS.scope)}),
  pref_key TEXT COLLATE BINARY NOT NULL CHECK (${bytes('pref_key', PREFERENCES_LIMITS.key)}),
  pref_value TEXT NOT NULL CHECK (${bytes('pref_value', PREFERENCES_LIMITS.value)}),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (app, subject_id, scope, pref_key)
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
    .all(PREFERENCES_PREFIX.length, PREFERENCES_PREFIX, PREFERENCES_PREFIX.length, PREFERENCES_PREFIX) as unknown as CatalogEntry[];

/** Exactly this version's two tables (and the automatic index of the key), nothing else under the prefix, and its version row. */
export function sqlitePreferencesReady(db: DatabaseSync): boolean {
  try {
    if (
      db
        .prepare(`SELECT 1 FROM temp.sqlite_schema
      WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
        .get(PREFERENCES_PREFIX.length, PREFERENCES_PREFIX, PREFERENCES_PREFIX.length, PREFERENCES_PREFIX)
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
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === PREFERENCES_VERSION;
  } catch {
    return false;
  }
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the store gets this version; the same layout
 * again changes nothing; anything else under the prefix is refused unchanged.
 */
export function provisionSqlitePreferences(existingPath: string): { version: typeof PREFERENCES_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Preferences store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(PREFERENCES_VERSION);
        provisioned = true;
      }
      if (!sqlitePreferencesReady(db))
        throw new PreferencesUnavailable(layoutRefusal('The preferences store', sqliteLayoutVersion(db, meta), PREFERENCES_VERSION));
      db.exec('COMMIT');
      return { version: PREFERENCES_VERSION, provisioned };
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

/** One private connection over an existing, provisioned file; opening attests, and a store that cannot be is not returned. */
export function openSqlitePreferences(existingPath: string): PreferencesStore {
  const db = new DatabaseSync(realpathSync(existingPath));
  db.exec('PRAGMA busy_timeout = 5000');
  if (!sqlitePreferencesReady(db)) {
    const message = layoutRefusal('The preferences store', sqliteLayoutVersion(db, meta), PREFERENCES_VERSION);
    db.close();
    throw new PreferencesUnavailable(message);
  }
  let closed = false;
  const driver: Db = {
    all: async (sql, ...params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, ...params) => Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };
  /* Each call is one synchronous transaction behind a promise, as the assistant's is: nothing else runs on this
     connection between BEGIN and COMMIT. */
  let queue = Promise.resolve();
  const transaction = <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      if (closed) throw new PreferencesUnavailable();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(driver);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return createPreferencesStore(
    transaction,
    (name) => `main."${name}"`,
    async () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  );
}
