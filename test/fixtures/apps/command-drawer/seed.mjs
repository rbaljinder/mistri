/**
 * The Command drawer fixture's database: two patients and the notes written on them.
 *
 *   node --import tsx test/fixtures/apps/command-drawer/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `clinic`,
 * with the command journal migrated. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

export function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; BEGIN;
      CREATE TABLE patient (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, last_note TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0)
      );
      CREATE TABLE visit_note (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, patient_id INTEGER NOT NULL REFERENCES patient(id), body TEXT NOT NULL
      );
      INSERT INTO patient (id, name) VALUES (1, 'Ada Quill'), (2, 'Basil Hart');
      COMMIT;`);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'clinic', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/apps/command-drawer/seed.mjs <new-file.db>');
  console.log(seed(process.argv[2]));
}
