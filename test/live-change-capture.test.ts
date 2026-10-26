import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { LIVE_CHANGE_TABLES, LiveChangeUnavailable, onLiveChanges } from '../packages/mistri/src/adapters/live/liveChange.js';
import {
  provisionSqliteLiveChange,
  pruneSqliteLiveChanges,
  readSqliteLiveChanges,
  sqliteLiveChangeReady,
  sqliteLiveHead,
  sqliteLiveKept,
} from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { bindLiveChanges } from '../packages/mistri/src/server/stores/writeCaptures.js';

async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>, provision = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-live-change-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, tenant_id TEXT, title TEXT NOT NULL, status TEXT, secret TEXT);
    INSERT INTO ticket VALUES (1, 'acme', 'Printer jam', 'open', 's1'), (2, 'globex', 'Badge', 'open', 's2');
    CREATE TABLE note (code TEXT PRIMARY KEY, body TEXT);
    INSERT INTO note VALUES ('a', 'first');`);
  if (provision) provisionSqliteLiveChange(path);
  const adapter = new SqliteAdapter(path);
  try {
    await run(adapter, db, path);
  } finally {
    bindLiveChanges(adapter, undefined);
    await adapter.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const changes = (db: DatabaseSync) => readSqliteLiveChanges(db, '0', 100);

test('provisioning is explicit, idempotent and refuses a foreign layout unchanged', async () => {
  await fixture(async (_adapter, db, path) => {
    assert.equal(sqliteLiveChangeReady(db), false);
    assert.deepEqual(provisionSqliteLiveChange(path), { version: 1, provisioned: true });
    assert.deepEqual(provisionSqliteLiveChange(path), { version: 1, provisioned: false });
    assert.equal(sqliteLiveChangeReady(db), true);
    db.exec(`CREATE TRIGGER "${LIVE_CHANGE_TABLES.change}_scrub" AFTER INSERT ON "${LIVE_CHANGE_TABLES.change}" BEGIN SELECT 1; END`);
    assert.equal(sqliteLiveChangeReady(db), false);
    assert.throws(() => provisionSqliteLiveChange(path), LiveChangeUnavailable);
  }, false);
});

test('an unbound adapter writes no change row, and a bound one writes one per transaction, at commit', async () => {
  await fixture(async (adapter, db) => {
    await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } }));
    assert.equal(changes(db).length, 0);

    bindLiveChanges(adapter, {});
    let nudged = 0;
    const off = onLiveChanges(() => nudged++);
    try {
      await attributeWrites({ actor: 'maya@example.com', via: 'app' }, () =>
        adapter.transaction(async (tx) => {
          await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open', title: 'Printer jammed' } });
          await tx.update({ table: 'ticket', key: { id: 2 }, values: { status: 'closed' } });
          await tx.insert({ table: 'note', values: { code: 'b', body: 'second' } });
          await tx.remove({ table: 'note', key: { code: 'a' } });
        }),
      );
      const [row] = changes(db);
      assert.equal(changes(db).length, 1, 'one row for the whole transaction');
      assert.equal(row.actor, 'maya@example.com');
      assert.equal(row.tenant, null);
      assert.deepEqual(
        row.entries.map((entry) => [entry.table, entry.kind, entry.keys, entry.columns]),
        [
          ['ticket', 'update', [{ id: 1 }, { id: 2 }], ['status', 'title']],
          ['note', 'insert', [{ code: 'b' }], undefined],
          ['note', 'delete', [{ code: 'a' }], undefined],
        ],
      );
      // No scoped table: no before image is kept.
      assert.ok(row.entries.every((entry) => !entry.before));
      assert.equal(nudged, 1, 'the nudge follows the commit');

      // A lone write outside a transaction is captured in one of its own.
      await adapter.update({ table: 'note', key: { code: 'b' }, values: { body: 'edited' } });
      assert.equal(changes(db).length, 2);
      assert.equal(nudged, 2);

      // A rollback writes nothing and nudges nobody; an update of no row says nothing.
      await assert.rejects(
        adapter.transaction(async (tx) => {
          await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'gone' } });
          throw new Error('abandon');
        }),
      );
      await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 99 }, values: { status: 'x' } })).catch(() => {});
      assert.equal(changes(db).length, 2);
      assert.equal(nudged, 2);
      assert.equal(db.prepare('SELECT status FROM ticket WHERE id = 1').get()?.status, 'open');
    } finally {
      off();
    }
  });
});

test('a tenant table names the owning tenant, and a scoped table keeps the row as it stood before', async () => {
  await fixture(async (adapter, db) => {
    bindLiveChanges(adapter, { owners: new Map([['ticket', 'tenant_id']]), scoped: new Set(['ticket']) });
    await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } }));
    await adapter.transaction(async (tx) => {
      await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } });
      await tx.update({ table: 'ticket', key: { id: 2 }, values: { status: 'open' } });
    });
    await adapter.transaction((tx) => tx.insert({ table: 'ticket', values: { id: 3, tenant_id: 'acme', title: 'New' } }));
    const [one, two, three] = changes(db);
    assert.equal(one.tenant, 'acme');
    assert.deepEqual(one.entries[0].before, [{ id: 1, tenant_id: 'acme', title: 'Printer jam', status: 'open', secret: 's1' }]);
    // Two tenants in one transaction: one entry each, and the row names neither.
    assert.equal(two.tenant, null);
    assert.deepEqual(
      two.entries.map((entry) => [entry.tenant, entry.keys]),
      [
        ['acme', [{ id: 1 }]],
        ['globex', [{ id: 2 }]],
      ],
    );
    assert.equal(three.tenant, 'acme');
    assert.equal(three.entries[0].before, undefined, 'an insert has no before');
  });
});

test('a table left out of live sync writes no change row alone, and a mixed transaction names only the live table', async () => {
  await fixture(async (adapter, db) => {
    bindLiveChanges(adapter, { skip: new Set(['note']) });
    let nudged = 0;
    const off = onLiveChanges(() => nudged++);
    try {
      await adapter.transaction((tx) => tx.insert({ table: 'note', values: { code: 'b', body: 'quiet' } }));
      await adapter.update({ table: 'note', key: { code: 'a' }, values: { body: 'quieter' } });
      await adapter.transaction((tx) => tx.remove({ table: 'note', key: { code: 'b' } }));
      assert.equal(changes(db).length, 0, 'no row for writes only to the excluded table');
      assert.equal(nudged, 0, 'and no nudge');

      await adapter.transaction(async (tx) => {
        await tx.insert({ table: 'note', values: { code: 'c', body: 'mixed' } });
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } });
      });
      const [row] = changes(db);
      assert.equal(changes(db).length, 1);
      assert.deepEqual(
        row.entries.map((entry) => [entry.table, entry.kind, entry.keys]),
        [['ticket', 'update', [{ id: 1 }]]],
      );
      assert.equal(nudged, 1);
    } finally {
      off();
    }
  });
});

test('a transaction past the key limit says many', async () => {
  await fixture(async (adapter, db) => {
    bindLiveChanges(adapter, { scoped: true });
    await adapter.transaction(async (tx) => {
      for (let id = 10; id < 220; id++) await tx.insert({ table: 'ticket', values: { id, title: `t${id}` } });
    });
    const [many] = changes(db);
    assert.equal(many.entries[0].keys, 'many');
    assert.equal(many.entries[0].before, undefined);
  });
});

test('retention keeps the newest row, and a cursor past what was pruned is no longer kept', async () => {
  await fixture(async (adapter, db) => {
    bindLiveChanges(adapter, {});
    for (const body of ['one', 'two', 'three']) await adapter.update({ table: 'note', key: { code: 'a' }, values: { body } });
    assert.equal(sqliteLiveHead(db), '3');
    assert.equal(sqliteLiveKept(db, '0'), true);
    assert.equal(pruneSqliteLiveChanges(db, Date.now() + 60_000), 2);
    assert.equal(changes(db).length, 1, 'the newest is kept');
    assert.equal(sqliteLiveKept(db, '0'), false);
    assert.equal(sqliteLiveKept(db, '1'), false);
    assert.equal(sqliteLiveKept(db, '2'), true);
    assert.equal(sqliteLiveKept(db, '3'), true);
    assert.equal(sqliteLiveKept(db, '4'), false, 'a cursor from the future is not this store');
    // AUTOINCREMENT: a pruned id is never handed out again.
    await adapter.update({ table: 'note', key: { code: 'a' }, values: { body: 'four' } });
    assert.deepEqual(
      readSqliteLiveChanges(db, '3', 10).map((row) => row.id),
      ['4'],
    );
  });
});
