/**
 * The Kit desk fixture's database: two owners and two tasks, one open and one closed.
 *
 *   node test/fixtures/apps/kit-desk/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `desk`.
 * Refuses an existing file: every run of the gate gets a fresh one. The spec
 * names task 1 (open, Ada's) by id, so read it before changing a row.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `PRAGMA foreign_keys=ON;
  CREATE TABLE owner (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE task (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL,
    owner_id INTEGER REFERENCES owner(id), due DATE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
  );
  CREATE INDEX task_owner ON task(owner_id);`;

const file = process.argv[2] && resolve(process.argv[2]);
if (!file) throw new Error('Usage: node seed.mjs <new-file.db>');
if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(SCHEMA);
db.exec(`INSERT INTO owner VALUES (1, 'Ada Lovelace'), (2, 'Bea Birch');
  INSERT INTO task VALUES (1, 'Order paper', 1, '2026-03-02', 'open'), (2, 'File taxes', 2, '2026-01-15', 'closed');`);
db.close();
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'desk', url: file, writable: true }] }, null, 2)}\n`);
