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
    CREATE TABLE deal (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, stage TEXT NOT NULL,
      amount INTEGER NOT NULL, closed_on DATE NOT NULL
    );
    COMMIT;`);
  /* Dated from today, so the parts page's windowed figures have rows in every window the reader picks. */
  const deals = [
    ['Forge expansion', 'Ana Ruiz', 'won', 42000, 3],
    ['Quench line', 'Ben Okafor', 'proposal', 18000, 9],
    ['Tongs, bulk', 'Ana Ruiz', 'negotiation', 9500, 14],
    ['Swage block', 'Cy Marlow', 'won', 27500, 21],
    ['Hammer retrofit', 'Ben Okafor', 'lost', 12000, 26],
    ['Bellows service', 'Cy Marlow', 'proposal', 6400, 33],
    ['Anvil leasing', 'Ana Ruiz', 'won', 31000, 41],
    ['Vise order', 'Ben Okafor', 'negotiation', 15200, 52],
    ['Chisel set', 'Cy Marlow', 'lost', 3800, 63],
    ['Annual upkeep', 'Ana Ruiz', 'won', 22000, 77],
  ];
  const add = db.prepare("INSERT INTO deal (name, owner, stage, amount, closed_on) VALUES (?, ?, ?, ?, date('now', ?))");
  for (const [name, owner, stage, amount, ago] of deals) add.run(name, owner, stage, amount, `-${ago} days`);
} finally {
  db.close();
}
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'page-kit', url: file }] }, null, 2)}\n`);
