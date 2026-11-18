/**
 * The AI proposals fixture's database: two open claims, a migrated command
 * journal, the assistant's store and the record history.
 *
 *   node --import tsx test/fixtures/apps/ai-proposals/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `claims`.
 * Refuses an existing file.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal, provisionStores } from '@mistriwork/mistri/maintenance';

export async function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`BEGIN;
      CREATE TABLE claim (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0)
      );
      INSERT INTO claim (id, name) VALUES (1, 'Corner dental, crown'), (2, 'Hart family, cleaning');
      COMMIT;`);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  await provisionStores({ sqlite: file }, { only: ['assistant', 'record-history'] });
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'claims', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/apps/ai-proposals/seed.mjs <new-file.db>');
  console.log(await seed(process.argv[2]));
}
