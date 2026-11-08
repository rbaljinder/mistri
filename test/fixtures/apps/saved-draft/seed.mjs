/**
 * The saved draft fixture's database: two people (whose emails the browser
 * test signs up with), the membership root a draft is kept in, and its
 * contact rows, with the command journal.
 *
 *   node --import tsx test/fixtures/apps/saved-draft/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `club`.
 * Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `PRAGMA foreign_keys=ON; BEGIN;
  CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
  INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
  CREATE TABLE membership (
    id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('in_progress','submitted')),
    person_id INTEGER NOT NULL REFERENCES person(id), reference TEXT UNIQUE, full_name TEXT, tier TEXT,
    resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT
  );
  CREATE TABLE contact (id INTEGER PRIMARY KEY, membership_id INTEGER NOT NULL REFERENCES membership(id), label TEXT NOT NULL);
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
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'club', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
