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

/* SQLite adds a decimal column as floats: 0.10 + 0.20 + 0.07 + 100,000,000,000,000.00 summed to …0.38 on a
   dashboard. The shared compiler sums it in hundredths and says it with the column's places (shared/decimals.ts),
   so a dashboard's total and PostgreSQL's agree to the cent. */
test('a breakdown sums a decimal column exactly, said with its places, and sorts by the amount', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sqlite-decimal-sum-'));
  let adapter: SqliteAdapter | undefined;
  try {
    const file = join(directory, 'ledger.db');
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE entry (id INTEGER PRIMARY KEY, account TEXT, amount NUMERIC(16,2), qty INTEGER);
        INSERT INTO entry (account, amount, qty) VALUES
          ('big', 0.10, 1), ('big', 0.20, 1), ('big', 0.07, 1), ('big', 100000000000000.00, 1),
          ('nine', 9, 1), ('ten', 4, 1), ('ten', 6, 1), ('owed', -0.05, 1), ('owed', NULL, 1), ('empty', NULL, 1);
      `);
    } finally {
      db.close();
    }
    adapter = new SqliteAdapter(file);
    const def = {
      base: 'entry',
      by: [{ path: 'account' }],
      measures: [
        { fn: 'sum' as const, path: 'amount' },
        { fn: 'sum' as const, path: 'qty' },
      ],
      orderBy: [{ name: 'sum(amount)', direction: 'desc' as const }],
    };
    const expected = [
      { account: 'big', 'sum(amount)': '100000000000000.37', 'sum(qty)': 4 },
      { account: 'ten', 'sum(amount)': '10.00', 'sum(qty)': 2 },
      { account: 'nine', 'sum(amount)': '9.00', 'sum(qty)': 1 },
      { account: 'owed', 'sum(amount)': '-0.05', 'sum(qty)': 2 },
      { account: 'empty', 'sum(amount)': null, 'sum(qty)': 1 },
    ];
    // Before: '100000000000000.38' (a REAL), and "9.00" sorted above "10.00" had the sum been text sorted as text.
    assert.deepEqual((await adapter.runBreakdown(def)).rows, expected);
    // A dashboard under a row policy reads through the scoped reads: the same statement, the same cents.
    const scoped = await adapter.scopeReads({ entry: true });
    assert.deepEqual((await scoped.runBreakdown(def)).rows, expected);
    // One number with no key, as a metric card asks it.
    const total = await adapter.runBreakdown({ base: 'entry', by: [], measures: [{ fn: 'sum', path: 'amount' }] });
    assert.deepEqual(total.rows, [{ 'sum(amount)': '100000000000019.32' }]);
    // A sum inside arithmetic still reads as a number: only a measure on its own is said as text.
    const ratio = await adapter.runBreakdown({
      base: 'entry',
      by: [{ path: 'account' }],
      filter: { groups: [[{ path: 'account', op: '=', value: 'ten' }]] },
      measures: [{ fn: 'sum', path: 'amount', steps: [{ op: '/', term: 2 }], alias: 'half' }],
    });
    assert.deepEqual(ratio.rows, [{ account: 'ten', half: 5 }]);
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
