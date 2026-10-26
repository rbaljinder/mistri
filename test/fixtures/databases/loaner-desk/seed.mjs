import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

/** A new, synthetic lending database; importing this module creates nothing. */
export function seed(file) {
  if (typeof file !== 'string' || !file || file.startsWith('--')) {
    throw new Error('Usage: node --import tsx test/fixtures/databases/loaner-desk/seed.mjs <new-database-path>');
  }
  file = resolve(file);
  const config = `${file}.json`;
  if ([file, config].some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
    throw new Error(`Refusing to replace ${file} or its config. Choose a new database path.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const configFd = openSync(config, 'wx', 0o600);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        BEGIN;
        CREATE TABLE borrower (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
          active BOOLEAN NOT NULL CHECK (active IN (0, 1))
        );
        CREATE TABLE equipment (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
          status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'checked_out')),
          version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0)
        );
        CREATE TABLE equipment_loan (
          id INTEGER PRIMARY KEY,
          equipment_id TEXT NOT NULL REFERENCES equipment(id),
          borrower_id TEXT NOT NULL REFERENCES borrower(id),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'returned')),
          checked_out_on DATE NOT NULL CHECK (date(checked_out_on, '+0 days') IS checked_out_on),
          due_on DATE NOT NULL CHECK (date(due_on, '+0 days') IS due_on),
          returned_on DATE CHECK (returned_on IS NULL OR date(returned_on, '+0 days') IS returned_on),
          version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0),
          CHECK ((status = 'open' AND returned_on IS NULL) OR (status = 'returned' AND returned_on IS NOT NULL)),
          CHECK (due_on >= checked_out_on),
          CHECK (returned_on IS NULL OR returned_on >= checked_out_on)
        );
        CREATE UNIQUE INDEX one_open_loan_per_item ON equipment_loan(equipment_id) WHERE returned_on IS NULL;
        CREATE INDEX loans_by_equipment ON equipment_loan(equipment_id);
        CREATE INDEX loans_by_borrower ON equipment_loan(borrower_id);
        INSERT INTO borrower VALUES ('ada', 'Ada Brooks', 1), ('ben', 'Ben Chen', 1), ('casey', 'Casey Diaz', 0);
        INSERT INTO equipment(id, name) VALUES ('camera', 'Camera kit'), ('projector', 'Projector');
        COMMIT;
      `);
    } finally {
      db.close();
    }
    migrateSqliteCommandJournal(file);
    writeFileSync(configFd, `${JSON.stringify({ connections: [{ name: 'loaner-desk', url: file, writable: true }] }, null, 2)}\n`);
  } finally {
    closeSync(configFd);
  }
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass one new database path.');
  const file = seed(process.argv[2]);
  console.log(`Seeded ${file}\nWritable config: ${file}.json`);
}
