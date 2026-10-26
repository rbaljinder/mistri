/**
 * The quote fixture's database: the one table its command writes, empty, with the command journal.
 *
 *   node --import tsx test/fixtures/apps/quote/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `main`. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `BEGIN;
  CREATE TABLE quote_request (
    id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
    home_type TEXT NOT NULL, monthly_bill NUMERIC NOT NULL, battery TEXT NOT NULL, phone TEXT NOT NULL, received_at TEXT NOT NULL
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
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'main', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
