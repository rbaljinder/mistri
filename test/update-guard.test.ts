import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  ANSI_STYLE,
  MYSQL_STYLE,
  POSTGRES_STYLE,
  Refusal,
  WriteConflict,
  type UpdateRequest,
} from '../packages/engine/src/adapters/adapter.js';
import { buildUpdateGuard } from '../packages/engine/src/adapters/scoped/updateGuard.js';
import { clearJournal, recordWrite, revert } from '../packages/engine/src/server/journal.js';

let directory: string;
let db: DatabaseSync;
let adapter: SqliteAdapter;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-update-guard-'));
  const file = join(directory, 'fixture.db');
  db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE item (tenant INTEGER, id INTEGER, name TEXT COLLATE NOCASE, score INTEGER, note TEXT, payload JSON, PRIMARY KEY (tenant, id))',
  );
  db.exec("INSERT INTO item VALUES (1, 1, 'Ada', 1, NULL, '{}'), (2, 1, 'Grace', 2, NULL, '{}')");
  adapter = new SqliteAdapter(file, 'guard');
});
after(async () => {
  await adapter?.close();
  db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
const key = { tenant: 1, id: 1 };
const row = () => db.prepare('SELECT * FROM item WHERE tenant=1 AND id=1').get()!;

test('conditional updates handle NULL, composite keys and untouched fields in one statement', async () => {
  const result = await adapter.update({
    table: 'item',
    key,
    values: { name: 'Ada Lovelace', note: 'First note' },
    expected: { name: 'Ada', note: null },
  });
  assert.equal(result.affected, 1);
  assert.match(result.sql.text, /"name" COLLATE BINARY = \? AND "note" IS NULL/);
  assert.equal(row().name, 'Ada Lovelace');
  assert.equal(row().score, 1);
  assert.equal(db.prepare('SELECT name FROM item WHERE tenant=2 AND id=1').get()!.name, 'Grace');
});

test('a stale field refuses the entire update, including fields that still match', async () => {
  const before = row();
  await assert.rejects(
    adapter.update({
      table: 'item',
      key,
      values: { name: 'Overwritten', score: 99 },
      expected: { name: 'Old name', score: before.score as number },
    }),
    WriteConflict,
  );
  assert.deepEqual(row(), before);
});

test('a write between preflight count and UPDATE is caught by the statement predicate', async () => {
  const originalCount = adapter.count.bind(adapter);
  const before = row().name as string;
  adapter.count = async (...args) => {
    const count = await originalCount(...args);
    db.prepare('UPDATE item SET name=? WHERE tenant=1 AND id=1').run('Other writer');
    return count;
  };
  try {
    await assert.rejects(
      adapter.update({ table: 'item', key, values: { name: 'My overwrite' }, expected: { name: before } }),
      WriteConflict,
    );
    assert.equal(row().name, 'Other writer');
  } finally {
    adapter.count = originalCount;
  }
});

test("case-insensitive column collation cannot hide another writer's casing change", async () => {
  db.exec("UPDATE item SET name='ADA' WHERE tenant=1 AND id=1");
  await assert.rejects(adapter.update({ table: 'item', key, values: { name: 'Mine' }, expected: { name: 'Ada' } }), WriteConflict);
  assert.equal(row().name, 'ADA');
});

test('a genuine unchanged value is acknowledged, and a removed row conflicts', async () => {
  assert.equal((await adapter.update({ table: 'item', key, values: { name: 'ADA' }, expected: { name: 'ADA' } })).affected, 1);
  await assert.rejects(
    adapter.update({ table: 'item', key: { tenant: 99, id: 1 }, values: { name: 'Mine' }, expected: { name: 'Gone' } }),
    WriteConflict,
  );
});

test('SQLite untyped columns cannot hide a casing change behind their collation', async () => {
  db.exec('CREATE TABLE untyped(id INTEGER PRIMARY KEY, name COLLATE NOCASE, score)');
  db.prepare('INSERT INTO untyped VALUES(?,?,?)').run(1, 'ADA', 3);
  const key = { id: 1 };
  await assert.rejects(
    adapter.update({ table: 'untyped', key, values: { name: 'Mine', score: 4 }, expected: { name: 'Ada', score: 3 } }),
    WriteConflict,
  );
  assert.equal(db.prepare('SELECT name FROM untyped').get()!.name, 'ADA');
  assert.equal(db.prepare('SELECT score FROM untyped').get()!.score, 3);
  const result = await adapter.update({ table: 'untyped', key, values: { name: 'Next', score: 4 }, expected: { name: 'ADA', score: 3 } });
  assert.equal(result.affected, 1);
  assert.equal(db.prepare('SELECT score FROM untyped').get()!.score, 4);
});

test('incomplete, extra, invalid and unsupported expected values are refused before writing', async () => {
  const before = row();
  for (const expected of [null, [], {}, { name: 'ADA', score: 1 }, { name: undefined }, { name: {} }, { name: Infinity }]) {
    await assert.rejects(adapter.update({ table: 'item', key, values: { name: 'Invalid' }, expected } as UpdateRequest), Refusal);
  }
  await assert.rejects(
    adapter.update({ table: 'item', key, values: { payload: '{"x":1}' }, expected: { payload: '{}' } }),
    /cannot be compared safely/,
  );
  assert.deepEqual(row(), before);
});

test('guard compilation binds values, preserves numeric strings and continues Postgres numbering', () => {
  const request = {
    table: 'item',
    key,
    values: { name: 'Next', score: 3, note: null },
    expected: { name: "O'Brien", score: '9007199254740993', note: null },
  };
  const types = { name: 'TEXT', score: 'BIGINT', note: 'TEXT' };
  for (const [dialect, style] of [
    ['sqlite', ANSI_STYLE],
    ['postgres', POSTGRES_STYLE],
    ['mysql', MYSQL_STYLE],
  ] as const) {
    const guard = buildUpdateGuard(request, types, style, dialect, 6);
    assert.deepEqual(guard.params, ["O'Brien", '9007199254740993']);
    assert.ok(!guard.text.includes("O'Brien"));
    assert.match(guard.text, /IS NULL/);
    if (dialect === 'postgres') {
      assert.match(guard.text, /COLLATE "C" = \$6/);
      assert.match(guard.text, /"score" = \$7/);
    }
    if (dialect === 'mysql') assert.match(guard.text, /CAST\(`name` AS BINARY\) = CAST\(\? AS BINARY\)/);
  }
});

test('an update arriving after undo preflight is protected by the transactional restore predicate', async () => {
  const connection = 'guard-undo';
  const before = row().name as string;
  await adapter.update({ table: 'item', key, values: { name: 'Acknowledged' } });
  const entry = recordWrite(connection, {
    kind: 'update',
    summary: 'Guarded update',
    revertible: true,
    steps: [{ table: 'item', key, before: { name: before }, after: { name: 'Acknowledged' } }],
  });
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = async (work) => {
    db.prepare('UPDATE item SET name=? WHERE tenant=1 AND id=1').run('After preflight');
    return transaction(work);
  };
  try {
    const result = await revert(adapter, connection, entry);
    assert.equal(result.reverted, false);
    assert.equal(row().name, 'After preflight');
  } finally {
    adapter.transaction = transaction;
    clearJournal(connection);
  }
});
