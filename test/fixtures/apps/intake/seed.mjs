/**
 * The intake fixture's database: the one table its commands write, empty, with
 * the command journal.
 *
 *   node --import tsx test/fixtures/apps/intake/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named
 * `members`. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `BEGIN;
  CREATE TABLE application (
    id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, date_of_birth DATE NOT NULL,
    account_type TEXT NOT NULL CHECK(account_type IN ('checking','savings','both')),
    joint BOOLEAN NOT NULL, ssn_last4 TEXT, received_at TEXT NOT NULL
  );
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
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'members', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
