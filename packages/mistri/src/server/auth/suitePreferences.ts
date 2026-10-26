/** Account preferences are navigation hints, never App authority. The suite
 * owner opens/closes `${identity.store}.preferences` and enforces separation
 * from identity, grant and business stores before passing this handle. */
import type { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { captureTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';

const ddl = [
  'CREATE TABLE suite_preferences_binding (suite_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK(version = 1))',
  'CREATE TABLE suite_preference (subject_id TEXT PRIMARY KEY NOT NULL, default_app TEXT, revision INTEGER NOT NULL CHECK(revision > 0))',
] as const;
/** The message says which way the layout differs where the version row does (layoutRefusal.ts); otherwise only that the store is unavailable. */
class SuitePreferencesUnavailable extends Error {
  constructor(message = 'Suite preferences storage is unavailable.') {
    super(message);
    this.name = 'SuitePreferencesUnavailable';
  }
}
export const unavailable = (message?: string): never => {
  throw new SuitePreferencesUnavailable(message);
};
const SUITE_PREFERENCES_VERSION = 1;
export const invalid = (): never => {
  throw new Error('Invalid suite preference.');
};
export const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value);
export const appName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

function isolated(db: DatabaseSync): void {
  if (
    db
      .prepare('PRAGMA database_list')
      .all()
      .some((row) => row.name !== 'main' && row.name !== 'temp') ||
    db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()
  )
    return unavailable();
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  // Never commit or roll back a caller's transaction, including on refusal.
  if (db.isTransaction) return unavailable();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Explicit installation into an empty, isolated caller-owned database only. */
export function provisionSuitePreferencesStore(db: DatabaseSync, suiteId: string): void {
  if (!appName(suiteId)) return invalid();
  transaction(db, () => {
    isolated(db);
    if (db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get()) return unavailable();
    for (const sql of ddl) db.exec(sql);
    db.prepare('INSERT INTO main.suite_preferences_binding VALUES (?, 1)').run(suiteId);
  });
}

export class SuitePreferencesConflict extends Error {
  constructor() {
    super('The App preference changed. Read its current revision before trying again.');
  }
}

/** Recognize exactly; opening never provisions, migrates or repairs storage. */
export function openSuitePreferencesStore(db: DatabaseSync, suiteId: string) {
  if (!appName(suiteId)) return invalid();
  const recognize = () => {
    try {
      isolated(db);
      const schema = db
        .prepare('SELECT sql FROM main.sqlite_schema WHERE sql IS NOT NULL')
        .all()
        .map((row) => row.sql)
        .sort();
      const expected = [...ddl].sort();
      if (schema.length !== expected.length || schema.some((sql, index) => sql !== expected[index]))
        return unavailable(
          layoutRefusal('The suite preferences store', sqliteLayoutVersion(db, 'suite_preferences_binding'), SUITE_PREFERENCES_VERSION),
        );
      const rows = db.prepare('SELECT suite_id, version FROM main.suite_preferences_binding').all();
      if (rows.length !== 1 || rows[0].suite_id !== suiteId || rows[0].version !== SUITE_PREFERENCES_VERSION)
        return unavailable(
          layoutRefusal('The suite preferences store', rows.length === 1 ? rows[0].version : undefined, SUITE_PREFERENCES_VERSION),
        );
    } catch (error) {
      if (error instanceof SuitePreferencesUnavailable) throw error;
      return unavailable();
    }
  };
  recognize();
  const read = (subjectId: string): { readonly defaultApp: string | null; readonly revision: number } => {
    if (!identifier(subjectId)) return invalid();
    recognize();
    try {
      const row = db.prepare('SELECT default_app, revision FROM main.suite_preference WHERE subject_id = ?').get(subjectId);
      if (!row) return Object.freeze({ defaultApp: null, revision: 0 });
      if (
        (row.default_app !== null && !appName(row.default_app)) ||
        typeof row.revision !== 'number' ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        return unavailable();
      return Object.freeze({ defaultApp: row.default_app as string | null, revision: row.revision });
    } catch {
      return unavailable();
    }
  };
  return Object.freeze({
    read,
    /** Trusted caller establishes the native subject and checks current App
     * authority. Null means Ask each time; its revision is never discarded. */
    change: (input: { subjectId: string; defaultApp: string | null; expectedRevision: number }): number => {
      const value = captureTenantData(input);
      tenantRecord(value, ['subjectId', 'defaultApp', 'expectedRevision']);
      if (
        !identifier(value.subjectId) ||
        (value.defaultApp !== null && !appName(value.defaultApp)) ||
        !Number.isSafeInteger(value.expectedRevision) ||
        value.expectedRevision < 0 ||
        value.expectedRevision >= Number.MAX_SAFE_INTEGER
      )
        return invalid();
      return transaction(db, () => {
        const previous = read(value.subjectId);
        if (previous.revision !== value.expectedRevision) throw new SuitePreferencesConflict();
        const revision = previous.revision + 1;
        db.prepare(`INSERT INTO main.suite_preference VALUES (?, ?, ?)
          ON CONFLICT(subject_id) DO UPDATE SET default_app = excluded.default_app, revision = excluded.revision`).run(
          value.subjectId,
          value.defaultApp,
          revision,
        );
        return revision;
      });
    },
  });
}
