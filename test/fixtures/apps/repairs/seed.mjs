/**
 * The repairs fixture's database: a repair, its photos and its signature,
 * empty, with the command journal.
 *
 *   node --import tsx test/fixtures/apps/repairs/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named
 * `garage`. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const FILE_COLUMNS = `repair_id INTEGER NOT NULL REFERENCES repair(id), file_name TEXT NOT NULL,
    content_type TEXT, byte_size INTEGER, data BLOB NOT NULL`;
const SCHEMA = `BEGIN;
  CREATE TABLE repair (id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, title TEXT NOT NULL);
  CREATE TABLE repair_photo (id INTEGER PRIMARY KEY, ${FILE_COLUMNS}, caption TEXT);
  CREATE TABLE repair_signature (id INTEGER PRIMARY KEY, ${FILE_COLUMNS});
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
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'garage', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
