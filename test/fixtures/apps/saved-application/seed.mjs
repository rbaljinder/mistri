/**
 * The saved application fixture's database: the application root and the
 * three tables its later steps write, empty, with the command journal.
 *
 *   node --import tsx test/fixtures/apps/saved-application/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named
 * `lending`. Every column a later step fills is nullable on the root, and the
 * platform's three resume columns are nullable text and a timestamp, as the
 * load check requires, as are the link's owner, provenance and claim columns.
 * Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `PRAGMA foreign_keys=ON; BEGIN;
  CREATE TABLE application (
    id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('in_progress','submitted','in_review')),
    reference TEXT UNIQUE, first_name TEXT, last_name TEXT, email TEXT, submitted_at TEXT,
    resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT,
    account_id TEXT, linked_at TEXT, linked_via TEXT, claim_token_hash TEXT, claim_expires_at TEXT
  );
  CREATE TABLE applicant_address (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id),
    line1 TEXT NOT NULL, city TEXT NOT NULL, postal_code TEXT NOT NULL);
  CREATE TABLE income (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id),
    employer TEXT NOT NULL, annual_income INTEGER NOT NULL);
  CREATE TABLE co_applicant (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id),
    position INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL);
  COMMIT;`;

const file = resolve(process.argv[2] ?? '');
if (!process.argv[2] || existsSync(file)) throw new Error('Give a new database file to create.');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
try {
  db.exec(SCHEMA);
} finally {
  db.close();
}
migrateSqliteCommandJournal(file);
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'lending', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
