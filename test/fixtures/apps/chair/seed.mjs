/**
 * The Chair fixture's database: two visits and what the dentist wrote of each.
 *
 *   node --import tsx test/fixtures/apps/chair/seed.mjs <new-file.db>
 *
 * Writes the database with the command journal `bookVisit` runs under, and `<file>.json`, a writable connection
 * named `chair`. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../../../../packages/mistri/src/adapters/commands/commandJournal.js';

export function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; BEGIN;
      CREATE TABLE visit (id INTEGER PRIMARY KEY, patient TEXT NOT NULL);
      CREATE TABLE note (id INTEGER PRIMARY KEY, visit_id INTEGER NOT NULL REFERENCES visit(id), body TEXT NOT NULL, follow_up TEXT);
      INSERT INTO visit (id, patient) VALUES (1, 'Ada'), (2, 'Grace');
      INSERT INTO note (id, visit_id, body, follow_up) VALUES
        (1, 1, 'Crown on 14, sensitive', 'Recall in 6 months'), (2, 2, 'Routine', NULL);
      COMMIT;`);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  writeFileSync(
    `${file}.json`,
    `${JSON.stringify({ connections: [{ id: 'chair', name: 'chair', url: file, writable: true }] }, null, 2)}\n`,
  );
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error('Name a new database file: node --import tsx test/fixtures/apps/chair/seed.mjs <new-file.db>');
  console.log(seed(target));
}
