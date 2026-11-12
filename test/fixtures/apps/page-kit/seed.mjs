/**
 * The page-kit fixture's database: a few things for the pages to read, and the parts and notes a record page lists.
 *
 *   node --import tsx test/fixtures/apps/page-kit/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a connection named `page-kit`. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const file = resolve(process.argv[2] ?? '');
if (!process.argv[2] || existsSync(file)) throw new Error('Give a new database file to create.');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
try {
  db.exec(`BEGIN;
    CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO thing (id, name) VALUES (1, 'Anvil'), (2, 'Bellows'), (3, 'Chisel');
    CREATE TABLE part (id INTEGER PRIMARY KEY, thing_id INTEGER NOT NULL REFERENCES thing(id), name TEXT NOT NULL);
    INSERT INTO part (id, thing_id, name) VALUES (1, 1, 'Horn'), (2, 1, 'Heel');
    CREATE TABLE note (id INTEGER PRIMARY KEY, thing_id INTEGER NOT NULL REFERENCES thing(id), body TEXT NOT NULL);
    INSERT INTO note (id, thing_id, body) VALUES (1, 1, 'Ring tested');
    COMMIT;`);
} finally {
  db.close();
}
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'page-kit', url: file }] }, null, 2)}\n`);
