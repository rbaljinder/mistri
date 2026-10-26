/**
 * Atelier on SQLite: the shop's six months (data.mjs) in a new file, for the
 * sample tests and a quick local try. PostgreSQL is the target and has its own
 * seed (seed-postgres.mjs) over the same rows and schema.
 *
 *   node --import tsx test/fixtures/databases/atelier/seed.mjs <new-file.db>
 *
 * The day is today in New York, the shop's, or `ATELIER_TODAY=YYYY-MM-DD`. Writes the database
 * and `<file>.json`, a writable connection named `atelier`: orders, payments,
 * fulfillments, returns and stock change through the App's commands, and its
 * grants keep every other write to the catalog and the customers. The
 * command journal and the record history are provisioned into the new file.
 * Refuses an existing file or config.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';
import { provisionStores } from '@mistriwork/mistri/maintenance';
import { generate, shopToday } from './data.mjs';
import { ddl, INDEXES } from './schema.mjs';

const value = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);

export async function seed(file, { today = process.env.ATELIER_TODAY, photos = true } = {}) {
  if (typeof file !== 'string' || !file || file.startsWith('--')) {
    throw new Error('Usage: node --import tsx test/fixtures/databases/atelier/seed.mjs <new-database-path>');
  }
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`))
    throw new Error(`Refusing to replace ${file} or its config. Choose a new database path.`);
  const day = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : shopToday();
  const { tables } = generate({ today: day, photos });
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN');
    for (const [, statement] of ddl('sqlite')) db.exec(statement);
    for (const index of INDEXES) db.exec(index);
    for (const [name, rows] of Object.entries(tables)) {
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const insert = db.prepare(`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      for (const row of rows) insert.run(...columns.map((column) => value(row[column])));
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  await provisionStores({ sqlite: file }, { only: ['record-history'] });
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'atelier', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass one new database path.');
  const file = await seed(process.argv[2]);
  console.log(`Seeded ${file}\nWritable config: ${file}.json`);
}
