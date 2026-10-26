import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  RECORD_HISTORY_TABLES,
  RecordHistoryUnavailable,
  historyKey,
  sayableActorName,
} from '../packages/mistri/src/adapters/history/recordHistory.js';
import { attributeAction, attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { provisionSqliteRecordHistory, sqliteRecordHistoryReady } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { bindRecordHistory } from '../packages/mistri/src/server/stores/writeCaptures.js';

async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>, provision = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-record-history-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT, salary INTEGER, notes TEXT);
    INSERT INTO ticket VALUES (1, 'Printer jam', 'open', 100, NULL);
    CREATE TABLE plain (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO plain VALUES (1, 'untouched');`);
  if (provision) provisionSqliteRecordHistory(path);
  const adapter = new SqliteAdapter(path);
  try {
    await run(adapter, db, path);
  } finally {
    await adapter.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const rows = (db: DatabaseSync) =>
  db.prepare(`SELECT * FROM "${RECORD_HISTORY_TABLES.change}" ORDER BY id`).all() as Array<Record<string, unknown>>;
const history = (adapter: SqliteAdapter, id = 1, before?: number) =>
  appStoresOf(adapter).readRecordHistory({ resource: 'ticket', key: historyKey({ id }), limit: 20, ...(before ? { before } : {}) });

test('provisioning is explicit, idempotent and refuses a foreign layout unchanged', async () => {
  await fixture(async (adapter, db, path) => {
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    assert.deepEqual(provisionSqliteRecordHistory(path), { version: 1, provisioned: true });
    assert.deepEqual(provisionSqliteRecordHistory(path), { version: 1, provisioned: false });
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), true);
    // A trigger could rewrite or drop what a write appends.
    db.exec(`CREATE TRIGGER "${RECORD_HISTORY_TABLES.change}_scrub" AFTER INSERT ON "${RECORD_HISTORY_TABLES.change}" BEGIN SELECT 1; END`);
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    assert.throws(() => provisionSqliteRecordHistory(path), RecordHistoryUnavailable);
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = '${RECORD_HISTORY_TABLES.change}_scrub'`).get(), 'refused unchanged');
  }, false);
  await fixture(async (_adapter, db, path) => {
    db.exec(`CREATE TABLE "${RECORD_HISTORY_TABLES.meta}" (singleton INTEGER PRIMARY KEY)`);
    assert.throws(() => provisionSqliteRecordHistory(path), RecordHistoryUnavailable);
    assert.equal(sqliteRecordHistoryReady(db), false);
  }, false);
});

test('a bound table records each write in its own transaction, attributed by the code around it', async () => {
  await fixture(async (adapter, db) => {
    bindRecordHistory(adapter, new Map([['ticket', { redact: new Set(['salary']) }]]));
    await attributeWrites({ actor: 'maya@example.com', name: 'Maya Chen', via: 'app' }, () =>
      adapter.transaction((tx) =>
        tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed', salary: 7_319_426, title: 'Printer jam' } }),
      ),
    );
    await attributeWrites({ actor: 'maya@example.com', via: 'app' }, () =>
      attributeAction('Reopen', () =>
        adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } })),
      ),
    );
    // An untouched table keeps nothing; the same value again is not a change.
    await adapter.transaction((tx) => tx.update({ table: 'plain', key: { id: 1 }, values: { name: 'changed' } }));
    await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } }));
    const stored = rows(db);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].actor, 'maya@example.com');
    // The name the account had when it wrote is kept beside it; a write that names none keeps ''.
    assert.equal(stored[0].actor_name, 'Maya Chen');
    assert.equal(stored[1].actor_name, '');
    assert.equal(stored[0].via, 'app');
    assert.equal(stored[0].action, '');
    // The redacted salary says it changed and nothing else; the untouched title is not a change.
    assert.deepEqual(JSON.parse(String(stored[0].changes_json)), [
      { c: 'status', b: 'open', a: 'closed' },
      { c: 'salary', r: 1 },
    ]);
    assert.equal(stored[1].action, 'Reopen');
    const read = await history(adapter);
    assert.deepEqual(
      read.map((row) => row.action),
      ['Reopen', ''],
    );
    // A value no timestamp or id can hold by chance: '120' once matched a time's milliseconds.
    assert.ok(!JSON.stringify(read).includes('7319426'), 'a redacted value never reaches the store');
  });
});

test('a rolled-back write leaves no history, and a history that cannot be written fails the write', async () => {
  await fixture(async (adapter, db) => {
    bindRecordHistory(adapter, new Map([['ticket', { redact: new Set() }]]));
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } });
        throw new Error('handler failed');
      }),
      /handler failed/,
    );
    assert.equal(rows(db).length, 0);
    assert.equal(db.prepare('SELECT status FROM ticket WHERE id = 1').get()?.status, 'open');
    db.exec(`DROP TABLE "${RECORD_HISTORY_TABLES.change}"`);
    await assert.rejects(adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } }));
    assert.equal(db.prepare('SELECT status FROM ticket WHERE id = 1').get()?.status, 'open', 'no business write without its history');
  });
});

test('inserts record their values, deletes only that the record went, and a reused key starts a new history', async () => {
  await fixture(async (adapter, db) => {
    bindRecordHistory(adapter, new Map([['ticket', { redact: new Set() }]]));
    // The public writes route through a transaction for a recorded table.
    const created = await adapter.insert({ table: 'ticket', values: { title: 'Scanner', status: 'open' } });
    assert.equal(rows(db).at(-1)?.kind, 'insert');
    assert.deepEqual(JSON.parse(String(rows(db).at(-1)?.changes_json)), [
      { c: 'title', a: 'Scanner' },
      { c: 'status', a: 'open' },
    ]);
    await adapter.update({ table: 'ticket', key: created.key, values: { status: 'closed' } });
    await adapter.remove({ table: 'ticket', key: created.key });
    assert.deepEqual(JSON.parse(String(rows(db).at(-1)?.changes_json)), []);
    // SQLite hands the freed rowid to the next insert: the new record's history is its own.
    const again = await adapter.insert({ table: 'ticket', values: { title: 'New scanner' } });
    assert.deepEqual(again.key, created.key);
    const read = await appStoresOf(adapter).readRecordHistory({ resource: 'ticket', key: historyKey(again.key), limit: 20 });
    assert.deepEqual(
      read.map((row) => row.kind),
      ['insert'],
    );
    assert.equal(read[0].changes[0].a, 'New scanner');
  });
});

test('reads page newest first by cursor, and long values are kept cut', async () => {
  await fixture(async (adapter) => {
    bindRecordHistory(adapter, new Map([['ticket', { redact: 'values' as const }]]));
    for (const status of ['a', 'b', 'c']) await adapter.update({ table: 'ticket', key: { id: 1 }, values: { status } });
    const first = await appStoresOf(adapter).readRecordHistory({ resource: 'ticket', key: historyKey({ id: 1 }), limit: 2 });
    assert.equal(first.length, 2);
    const rest = await history(adapter, 1, first[1].id);
    assert.equal(rest.length, 1);
    assert.ok(rest[0].id < first[1].id);
    assert.deepEqual(first[0].changes, [{ c: 'status', r: 1 }]);
    bindRecordHistory(adapter, new Map([['ticket', { redact: new Set() }]]));
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { notes: 'x'.repeat(5000) } });
    const [latest] = await history(adapter);
    assert.equal(latest.changes[0].t, 1);
    assert.equal(String(latest.changes[0].a).length, 1001);
  });
});

test('an unbound adapter records nothing, and keys read the same whatever their JSON type', async () => {
  await fixture(async (adapter, db) => {
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } });
    assert.equal(rows(db).length, 0);
    assert.equal(historyKey({ id: 3 }), historyKey({ id: '3' }));
    assert.equal(historyKey({ b: 1, a: 2 }), historyKey({ a: 2, b: 1 }));
  });
});

test('the name a history keeps is one plain line within its bound, and never an email address', () => {
  assert.equal(sayableActorName('  Maya\n Chen\u0000 '), 'Maya Chen');
  assert.equal(sayableActorName('maya@example.com'), '');
  assert.equal(sayableActorName('Maya <maya@example.com>'), '');
  assert.equal(sayableActorName(undefined), '');
  assert.equal(sayableActorName(''), '');
  // Bounded in bytes and cut between characters, as the stores and the inbox measure it.
  const long = sayableActorName('é'.repeat(150));
  assert.ok(Buffer.byteLength(long, 'utf8') <= 200);
  assert.equal(long, 'é'.repeat(100));
});
