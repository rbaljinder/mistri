import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';

const byId = (id: number): Filter => ({ groups: [[{ column: 'id', op: '=', value: id }]] });
const page = { limit: 20, offset: 0 };
async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sqlite-transaction-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, active BOOLEAN DEFAULT 1); INSERT INTO ticket (id,name) VALUES (1,'Original');",
  );
  const adapter = new SqliteAdapter(file);
  try {
    await run(adapter, db);
  } finally {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('SQLite transactional query/count and mutation preflights see earlier inserts and updates', async () => {
  await fixture(async (adapter) => {
    await adapter.transaction(async (tx) => {
      await tx.insert({ table: 'ticket', values: { id: 2, name: 'Inserted' } });
      assert.equal(await tx.count('ticket'), 2);
      assert.equal(await adapter.count('ticket'), 1, 'ordinary reader must not see uncommitted writes');
      assert.deepEqual((await tx.query({ ...page, table: 'ticket', columns: ['id', 'name'], filter: byId(2) })).rows, [
        { id: 2, name: 'Inserted' },
      ]);
      assert.equal(
        (
          await tx.update({
            table: 'ticket',
            key: { id: 2 },
            values: { name: 'Updated', version: 1 },
            expected: { name: 'Inserted', version: 0 },
          })
        ).affected,
        1,
      );
      assert.deepEqual((await tx.query({ ...page, table: 'ticket', columns: ['name', 'version'], filter: byId(2) })).rows, [
        { name: 'Updated', version: 1 },
      ]);
      await tx.insert({ table: 'ticket', values: { id: 3, name: 'Temporary' } });
      assert.equal((await tx.remove({ table: 'ticket', key: { id: 3 } })).affected, 1);
      assert.equal(await tx.count('ticket', byId(3)), 0);
      assert.deepEqual(
        (await tx.query({ table: 'ticket', columns: ['id'], orderBy: [{ column: 'id', direction: 'desc' }], limit: 1, offset: 1 })).rows,
        [{ id: 1 }],
      );
    });
    assert.equal(await adapter.count('ticket'), 2);
    assert.deepEqual((await adapter.query({ ...page, table: 'ticket', columns: ['name', 'version'], filter: byId(2) })).rows, [
      { name: 'Updated', version: 1 },
    ]);
  });
});

test('SQLite rollback discards reads-after-write work and keeps the ordinary reader read-only', async () => {
  await fixture(async (adapter) => {
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Changed' } });
        await tx.insert({ table: 'ticket', values: { id: 2, name: 'Rollback' } });
        assert.equal(await tx.count('ticket'), 2);
        assert.equal((await tx.query({ ...page, table: 'ticket', filter: byId(1) })).rows[0].name, 'Changed');
        throw new Error('Abort command');
      }),
      /Abort command/,
    );
    assert.equal(await adapter.count('ticket'), 1);
    assert.equal((await adapter.query({ ...page, table: 'ticket' })).rows[0].name, 'Original');
    await assert.rejects(adapter.runSql({ text: "UPDATE ticket SET name = 'Not allowed'", limit: 20 }), /readonly/);
  });
});

test('SQLite transaction handles expire after commit and rollback, including reads', async () => {
  await fixture(async (adapter) => {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const work = adapter.transaction(async (tx) => {
        escaped = tx;
        if (fail) throw new Error('Rollback');
      });
      if (fail) await assert.rejects(work, /Rollback/);
      else await work;
      for (const late of [
        () => escaped.query({ ...page, table: 'ticket' }),
        () => escaped.count('ticket'),
        () => escaped.insert({ table: 'ticket', values: { name: 'Late' } }),
        () => escaped.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Late' } }),
        () => escaped.remove({ table: 'ticket', key: { id: 1 } }),
      ])
        await assert.rejects(late, /no longer active/);
    }
    assert.equal(await adapter.count('ticket'), 1);
    assert.equal((await adapter.query({ ...page, table: 'ticket' })).rows[0].name, 'Original');
  });
});

test('SQLite transaction reserves the writer before its first read', async () => {
  await fixture(async (adapter, otherConnection) => {
    otherConnection.exec('PRAGMA busy_timeout = 1');
    await adapter.transaction(async (tx) => {
      assert.throws(() => otherConnection.exec('BEGIN IMMEDIATE'), /database is locked/);
      assert.equal(await tx.count('ticket'), 1);
    });
    otherConnection.exec('BEGIN IMMEDIATE');
    otherConnection.exec('ROLLBACK');
  });
});

test('SQLite caught and fire-and-forget operation failures roll back earlier writes without unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const notice = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', notice);
  try {
    await fixture(async (adapter) => {
      for (const caught of [false, true]) {
        await assert.rejects(
          adapter.transaction(async (tx) => {
            await tx.insert({ table: 'ticket', values: { id: 2, name: 'Must roll back' } });
            const failed = tx.update({ table: 'ticket', key: { id: 1 }, values: { absent_column: 'Invalid' } });
            if (caught) await failed.catch(() => {});
            return 'Must not commit';
          }),
          /no column called/,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(await adapter.count('ticket'), 1);
        assert.equal((await adapter.query({ ...page, table: 'ticket' })).rows[0].name, 'Original');
      }
    });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', notice);
  }
});
