import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { declaredScale } from '../packages/engine/src/adapters/sqliteDecimals.js';

test('a declared scale is read from the type, and only a scale above zero counts', () => {
  assert.equal(declaredScale('numeric(12,2)'), 2);
  assert.equal(declaredScale('DECIMAL(10, 3)'), 3);
  assert.equal(declaredScale('decimal(10,0)'), 0);
  assert.equal(declaredScale('numeric(10)'), 0);
  assert.equal(declaredScale('numeric'), 0);
  assert.equal(declaredScale('INTEGER'), 0);
  assert.equal(declaredScale(null), 0);
});

test('a DECIMAL/NUMERIC column with a scale reads as Postgres says a numeric', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sqlite-decimal-'));
  let adapter: SqliteAdapter | undefined;
  try {
    const file = join(directory, 'prices.db');
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE item (id INTEGER PRIMARY KEY, price NUMERIC(12,2), weight DECIMAL(10,3), qty INTEGER, loose NUMERIC, note TEXT);
        INSERT INTO item VALUES (1, 38, 2, 5, 38, 'a'), (2, 19.9, 0.25, 6, 19.9, 'b'), (3, NULL, NULL, 7, NULL, 'c');
      `);
    } finally {
      db.close();
    }
    adapter = new SqliteAdapter(file);
    const read = await adapter.query({ table: 'item', orderBy: [{ column: 'id', direction: 'asc' }], limit: 10, offset: 0 });
    assert.deepEqual(
      read.rows.map((r) => [r.price, r.weight, r.qty, r.loose]),
      [
        ['38.00', '2.000', 5, 38],
        ['19.90', '0.250', 6, 19.9],
        [null, null, 7, null],
      ],
    );

    const raw = await adapter.runSql({ text: 'SELECT price, price + 1 AS bumped FROM item WHERE id = 1', limit: 10 });
    assert.deepEqual(raw.rows, [['38.00', 39]]);

    const written = await adapter.insert({ table: 'item', values: { id: 4, price: 7, qty: 1 } });
    assert.equal(JSON.stringify(written).includes('"price":"7.00"'), true);
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
