/**
 * The door fixture's database: the makes its form offers, the photos its
 * landing shows, the two tables its commands write, and the command journal.
 *
 *   node --import tsx test/fixtures/apps/door/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `shop`.
 * Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

/* An 8×6 PNG in each of three colors: enough for the public image pipeline to read and serve. */
const PNG = [
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGM4GeOAFTEMpAQAt7NC8ZYDhU8AAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGNQa6jAihgGUgIAp/c1oRbMDGIAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGPQMEnAihgGUgIASmwjQcENvY4AAAAASUVORK5CYII=',
];

const file = resolve(process.argv[2] ?? '');
if (!process.argv[2] || existsSync(file)) throw new Error('Give a new database file to create.');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
try {
  db.exec(`BEGIN;
    CREATE TABLE make (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO make (id, name) VALUES (1, 'Harbor Gloss'), (2, 'Ridge Matte'), (3, 'Willow Satin');
    CREATE TABLE inquiry (id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, make_id INTEGER NOT NULL REFERENCES make(id),
      color TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE enrolment (id INTEGER PRIMARY KEY, name TEXT NOT NULL, make_id INTEGER NOT NULL REFERENCES make(id),
      reference TEXT NOT NULL UNIQUE);
    CREATE TABLE site_image (id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, data BLOB NOT NULL);
    COMMIT;`);
  const insert = db.prepare('INSERT INTO site_image (id, file_name, data) VALUES (?, ?, ?)');
  PNG.forEach((png, index) => insert.run(index + 1, `photo-${index + 1}.png`, Buffer.from(png, 'base64')));
} finally {
  db.close();
}
migrateSqliteCommandJournal(file);
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'shop', url: file, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
