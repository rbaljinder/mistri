/**
 * A SQLite read that could hold the server runs in the statement process
 * (sqliteCostlyReads.ts): a filtered read of a large table no longer blocks
 * a cheap one asked while it runs, and gives the same rows it gave in process.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { heavyRelations, PROCESS_ROWS, stalls } from '../packages/engine/src/adapters/sqliteCostlyReads.js';

const BIG = PROCESS_ROWS + 50_000;

function fixture(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-costly-'));
  const file = join(directory, 'big.db'),
    db = new DatabaseSync(file);
  db.exec(`CREATE TABLE big (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bucket INTEGER NOT NULL);
    CREATE TABLE small (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO small VALUES (1, 'one'), (2, 'two');`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BIG})
    INSERT INTO big SELECT i, 'row ' || i, i % 97 FROM n`);
  db.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file;
}

test('only a read of a large relation that cannot stop at its page is a stalling one', async (t) => {
  const file = fixture(t),
    adapter = new SqliteAdapter(file);
  try {
    const schema = await adapter.introspect();
    const heavy = heavyRelations(schema);
    assert.deepEqual(heavy, ['"big"']);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        stalls(db, 'SELECT * FROM "big" ORDER BY "id" DESC LIMIT 20 OFFSET 0', [], heavy, false),
        false,
        'a page in key order stops at its limit',
      );
      assert.equal(stalls(db, 'SELECT * FROM "big" WHERE "name" LIKE ? LIMIT 20', ['%9%'], heavy, false), true);
      assert.equal(stalls(db, 'SELECT * FROM "big" ORDER BY "name" LIMIT 20', [], heavy, false), true, 'a sort of the whole table');
      assert.equal(
        stalls(db, 'SELECT * FROM "big" WHERE "id" < ? ORDER BY "id" DESC LIMIT 20', [900], heavy, false),
        false,
        'a page by key searches its range',
      );
      assert.equal(stalls(db, 'SELECT COUNT(*) AS n FROM "big"', [], heavy, true), true);
      assert.equal(stalls(db, 'SELECT * FROM "small" WHERE "name" LIKE ? LIMIT 20', ['%o%'], heavy, false), false);
    } finally {
      db.close();
    }
  } finally {
    await adapter.close();
  }
});

test('a filtered scan of a large table runs beside a cheap read rather than in front of it', async (t) => {
  const adapter = new SqliteAdapter(fixture(t));
  try {
    await adapter.introspect();
    const filter = { groups: [[{ column: 'name', op: 'contains' as const, value: 'no such row' }]] };
    /* A request that arrives while the scan runs: asked 5 ms in. In process
       the scan held the thread, so it could not even be asked until the scan
       was over, and it answered after the scan did. How long it waited is a
       measure of the machine as much as of the read (under a loaded gate it
       once took half a slow scan), so what is asserted is the order. */
    const started = performance.now();
    const cheap = new Promise<{ rows: unknown[]; waited: number; done: number }>((resolve, reject) => {
      const asked = started + 5;
      setTimeout(() => {
        adapter.query({ table: 'small', orderBy: [{ column: 'id', direction: 'asc' }], limit: 20, offset: 0 }).then((answer) => {
          const done = performance.now();
          resolve({ rows: answer.rows, waited: done - asked, done });
        }, reject);
      }, 5);
    });
    const costly = Promise.all([
      adapter.query({ table: 'big', filter, orderBy: [{ column: 'name', direction: 'desc' }], limit: 20, offset: 0 }),
      adapter.count('big', filter),
    ]).then((answer) => ({ answer, at: performance.now() }));
    const [
      {
        answer: [rows, counted],
        at,
      },
      small,
    ] = await Promise.all([costly, cheap]);
    const took = at - started;
    assert.equal(rows.rows.length, 0);
    assert.equal(counted, 0);
    assert.equal(small.rows.length, 2);
    assert.ok(small.done < at, `the cheap read waited ${small.waited.toFixed(1)} ms, past the end of a ${took.toFixed(1)} ms scan`);
    // The same rows as in process, bigints and all.
    const found = await adapter.query({
      table: 'big',
      filter: { groups: [[{ column: 'name', op: '=', value: 'row 77' }]] },
      limit: 5,
      offset: 0,
    });
    assert.deepEqual(found.rows, [{ id: 77, name: 'row 77', bucket: 77 }]);
    const view = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'big',
      columns: [{ path: 'id' }, { path: 'bucket' }],
      filter: { groups: [[{ path: 'bucket', op: '=', value: 3 }]] },
      orderBy: [{ path: 'id', direction: 'asc' }],
      limit: 2,
    });
    assert.deepEqual(view.rows, [
      { id: 3, bucket: 3 },
      { id: 100, bucket: 3 },
    ]);
  } finally {
    await adapter.close();
  }
});
