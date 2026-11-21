/**
 * The Choose fixture's database: two sites and the visits at each.
 *
 *   node --import tsx test/fixtures/apps/choose/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a read-only connection named `clinic`, with the preferences store the
 * App's `choose` keeps a person's pick in. Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { provisionSqlitePreferences } from '../../../../packages/mistri/src/adapters/preferences/sqlitePreferences.js';

export function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; BEGIN;
      CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES site(id), note TEXT NOT NULL);
      INSERT INTO site (id, name) VALUES (1, 'Northside'), (2, 'Southside');
      INSERT INTO visit (id, site_id, note) VALUES
        (1, 1, 'North flu shot'), (2, 1, 'North checkup'), (3, 2, 'South sprain');
      COMMIT;`);
  } finally {
    db.close();
  }
  provisionSqlitePreferences(file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'clinic', url: file }] }, null, 2)}\n`, { flag: 'wx' });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/apps/choose/seed.mjs <new-file.db>');
  console.log(seed(process.argv[2]));
}
