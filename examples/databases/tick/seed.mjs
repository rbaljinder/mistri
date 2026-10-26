import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** Create deterministic synthetic tasks and a writable connection config. */
export function seed(file) {
  if (typeof file !== 'string' || !file || file.startsWith('--')) {
    throw new Error('Usage: node examples/databases/tick/seed.mjs <new-database-path>');
  }
  file = resolve(file);
  const config = `${file}.json`;
  if ([file, config].some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
    throw new Error(`Refusing to replace ${file} or its config. Choose a new database path.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  // Exclusive reservations also refuse files/symlinks created after preflight.
  const configFd = openSync(config, 'wx', 0o600);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE task (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          completed BOOLEAN NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
          due_on DATE,
          position REAL
        );
      `);
      // Each task's place in the list, a step apart so a move lands between two.
      const insert = db.prepare('INSERT INTO task (id, name, completed, due_on, position) VALUES (?, ?, ?, ?, ?)');
      insert.run(1, 'Plan the week', 0, '2026-09-07', 1024);
      insert.run(2, 'Water the plants', 0, null, 2048);
      insert.run(3, 'Return the library book', 0, '2026-09-10', 3072);
      insert.run(4, 'Clear the desk', 1, null, 4096);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    writeFileSync(
      configFd,
      `${JSON.stringify(
        {
          connections: [{ name: 'tick', url: file, writable: true }],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    closeSync(configFd);
  }
  return file;
}

// Importing the setup module is inert; only explicit CLI execution seeds data.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node examples/databases/tick/seed.mjs <new-database-path>');
  }
  const file = seed(process.argv[2]);
  console.log(`Seeded ${file}\nWritable config: ${file}.json`);
}
