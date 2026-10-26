/**
 * The Order desk fixture's database: two orders, one in dollars with two
 * lines and one in yen with one, every amount in its currency's minor units.
 *
 *   node test/fixtures/apps/order-desk/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `shop`.
 * Refuses an existing file: every run of the gate gets a fresh one. The spec
 * names the orders by id (1 in USD, 2 in JPY), so read it before changing a row.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `PRAGMA foreign_keys=ON;
  CREATE TABLE sales_order (
    id INTEGER PRIMARY KEY, customer TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
    shipping INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE order_line (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
    position INTEGER, product TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL
  );
  CREATE INDEX line_order ON order_line(order_id);`;

const file = process.argv[2] && resolve(process.argv[2]);
if (!file) throw new Error('Usage: node seed.mjs <new-file.db>');
if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(SCHEMA);
db.exec(`INSERT INTO sales_order VALUES (1, 'Ada Lovelace', 'USD', 500), (2, 'Kenji Sato', 'JPY', 800);
  INSERT INTO order_line VALUES (1, 1, 1, 'Kettle', 2, 1999), (2, 1, 2, 'Mug', 3, 850), (3, 2, 1, 'Teapot', 1, 4200);`);
db.close();
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'shop', url: file, writable: true }] }, null, 2)}\n`);
