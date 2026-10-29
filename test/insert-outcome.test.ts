import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { insertFailureOutcome, writeFailureKind } from '../packages/engine/src/server/constraints.js';

test('actual SQLite constraint failures acknowledge rejection', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, quantity INTEGER CHECK(quantity > 0)); INSERT INTO item VALUES (1, 'Ada', 1)",
    );
    for (const sql of [
      "INSERT INTO item VALUES (1, 'Grace', 1)",
      "INSERT INTO item VALUES (2, 'Ada', 1)",
      'INSERT INTO item VALUES (2, NULL, 1)',
      "INSERT INTO item VALUES (2, 'Grace', 0)",
    ]) {
      assert.throws(
        () => db.exec(sql),
        (error: unknown) => insertFailureOutcome(error) === 'rejected',
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item').get()!.n, 1);
  } finally {
    db.close();
  }
});

test('recognized PostgreSQL constraint codes acknowledge rejection', () => {
  for (const code of ['23502', '23503', '23505', '23514', '23P01']) assert.equal(insertFailureOutcome({ code }), 'rejected');
});

test('transport, generic, trigger and message-only failures remain unknown', () => {
  for (const error of [
    null,
    'UNIQUE constraint failed',
    new Error('Duplicate key'),
    { code: 'ECONNRESET' },
    { code: '08006' },
    { errno: 2013 },
    { errcode: 1811 },
    { errcode: 19 },
  ]) {
    assert.equal(insertFailureOutcome(error), 'unknown');
  }
});

/* Which rule was broken, from the same codes that decide whether the write was
   rejected at all — so "was this permanent?" and "which rule?" can never
   disagree, and a refusal can say something better than "retry later". */
test('a real SQLite failure names the rule it broke', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      quantity INTEGER CHECK(quantity > 0), maker INTEGER REFERENCES item(id));
      INSERT INTO item VALUES (1, 'Ada', 1, NULL); PRAGMA foreign_keys = ON`);
    const kindOf = (sql: string) => {
      try {
        db.exec(sql);
        return 'applied';
      } catch (error) {
        return writeFailureKind(error);
      }
    };
    assert.equal(kindOf("INSERT INTO item VALUES (1, 'Grace', 1, NULL)"), 'unique', 'primary key');
    assert.equal(kindOf("INSERT INTO item VALUES (2, 'Ada', 1, NULL)"), 'unique', 'unique index');
    assert.equal(kindOf('INSERT INTO item VALUES (2, NULL, 1, NULL)'), 'required');
    assert.equal(kindOf("INSERT INTO item VALUES (2, 'Grace', 0, NULL)"), 'check');
    assert.equal(kindOf("INSERT INTO item VALUES (2, 'Grace', 1, 99)"), 'reference');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item').get()!.n, 1);
  } finally {
    db.close();
  }
});

test('every engine reports the same kinds, and what the codes do not name has none', () => {
  const named = [
    [{ errcode: 1555 }, 'unique'],
    [{ errcode: 2067 }, 'unique'],
    [{ errcode: 787 }, 'reference'],
    [{ errcode: 1299 }, 'required'],
    [{ errcode: 275 }, 'check'],
    [{ code: '23505' }, 'unique'],
    [{ code: '23P01' }, 'unique'],
    [{ code: '23503' }, 'reference'],
    [{ code: '23502' }, 'required'],
    [{ code: '23514' }, 'check'],
  ] as const;
  for (const [error, kind] of named) {
    assert.equal(writeFailureKind(error), kind, JSON.stringify(error));
    assert.equal(insertFailureOutcome(error), 'rejected', JSON.stringify(error));
  }
  for (const error of [
    null,
    'UNIQUE constraint failed',
    new Error('Duplicate key'),
    { code: 'ECONNRESET' },
    { code: '08006' },
    { errno: 2013 },
    { errcode: 1811 },
    { errcode: 19 },
  ]) {
    assert.equal(writeFailureKind(error), undefined);
  }
});
