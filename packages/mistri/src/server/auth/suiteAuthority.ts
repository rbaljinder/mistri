/** What each App of a suite granted, start by start: the authority.lock text
 * a start served, recorded when it differs from the one before, so the
 * Console's Governance room can say what changed and when. It is a record of
 * starts, never authority: a server's grants are still its App's own, checked
 * against the lock beside it. The suite owner opens/closes
 * `${identity.store}.authority` and keeps it apart from identity, grant,
 * preference and business stores before passing this handle. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';

const ddl = [
  'CREATE TABLE suite_authority_binding (suite_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK(version = 1))',
  'CREATE TABLE suite_authority (id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, sha256 TEXT NOT NULL, report TEXT NOT NULL)',
  'CREATE INDEX suite_authority_app ON suite_authority (app_id, id)',
  "CREATE TRIGGER suite_authority_no_update BEFORE UPDATE ON suite_authority BEGIN SELECT RAISE(ABORT, 'Suite authority history is append-only.'); END",
  "CREATE TRIGGER suite_authority_no_delete BEFORE DELETE ON suite_authority BEGIN SELECT RAISE(ABORT, 'Suite authority history is append-only.'); END",
] as const;
const SUITE_AUTHORITY_VERSION = 1;
/** A report is a few kilobytes; a lock this large is not one mistri wrote. */
export const MAX_REPORT = 1024 * 1024;

class SuiteAuthorityUnavailable extends Error {
  constructor(message = 'Suite authority history is unavailable.') {
    super(message);
    this.name = 'SuiteAuthorityUnavailable';
  }
}
export const unavailable = (message?: string): never => {
  throw new SuiteAuthorityUnavailable(message);
};
export const invalid = (): never => {
  throw new Error('Invalid suite authority record.');
};
export const appName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export const digest = (report: string) => createHash('sha256').update(report).digest('hex');

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
export function provisionSuiteAuthorityStore(db: DatabaseSync, suiteId: string): void {
  if (!appName(suiteId)) return invalid();
  transaction(db, () => {
    isolated(db);
    if (db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get()) return unavailable();
    for (const sql of ddl) db.exec(sql);
    db.prepare('INSERT INTO main.suite_authority_binding VALUES (?, 1)').run(suiteId);
  });
}

interface Recorded {
  readonly report: string;
  readonly at: number;
}

/** Recognize exactly; opening never provisions, migrates or repairs storage. */
export function openSuiteAuthorityStore(db: DatabaseSync, suiteId: string) {
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
          layoutRefusal('The suite authority store', sqliteLayoutVersion(db, 'suite_authority_binding'), SUITE_AUTHORITY_VERSION),
        );
      const rows = db.prepare('SELECT suite_id, version FROM main.suite_authority_binding').all();
      if (rows.length !== 1 || rows[0].suite_id !== suiteId || rows[0].version !== SUITE_AUTHORITY_VERSION)
        return unavailable(
          layoutRefusal('The suite authority store', rows.length === 1 ? rows[0].version : undefined, SUITE_AUTHORITY_VERSION),
        );
    } catch (error) {
      if (error instanceof SuiteAuthorityUnavailable) throw error;
      return unavailable();
    }
  };
  recognize();
  /** The App's last two distinct reports, newest first; a row whose text does not match its digest is unreadable. */
  const latest = (appId: string): Recorded[] =>
    db
      .prepare('SELECT recorded_at, sha256, report FROM main.suite_authority WHERE app_id = ? ORDER BY id DESC LIMIT 2')
      .all(appId)
      .map((row) => {
        if (typeof row.report !== 'string' || typeof row.recorded_at !== 'number' || row.sha256 !== digest(row.report))
          return unavailable();
        return Object.freeze({ report: row.report, at: row.recorded_at });
      });
  return Object.freeze({
    /** This start's authority: recorded when it differs from the App's last, so a restart with the same lock adds nothing. */
    record: (appId: string, report: string, at = Date.now()): void => {
      if (!appName(appId) || typeof report !== 'string' || report.length > MAX_REPORT || !Number.isSafeInteger(at)) return invalid();
      transaction(db, () => {
        recognize();
        if (latest(appId)[0]?.report === report) return;
        db.prepare('INSERT INTO main.suite_authority (app_id, recorded_at, sha256, report) VALUES (?, ?, ?, ?)').run(
          appId,
          at,
          digest(report),
          report,
        );
      });
    },
    /**
     * What the App granted before its current authority, and when the current
     * one was first served; undefined when only one has been recorded.
     */
    previous: (appId: string): { readonly report: string; readonly at: number } | undefined => {
      if (!appName(appId)) return invalid();
      recognize();
      const [current, before] = latest(appId);
      return before ? Object.freeze({ report: before.report, at: current.at }) : undefined;
    },
  });
}
