/**
 * The write journal kept in its database (server/journalStore.ts): a
 * writable connection whose database holds the store reads its Undo history
 * back after a restart and can still undo from it; retention keeps the newest
 * fifty a connection and nothing past a week; an Undo a stopped process left
 * in progress comes back uncertain, never offered again; a hidden column's
 * value is no more in the store than it was in the journal. A connection
 * whose database does not hold the store keeps the journal in memory, as it
 * always did, and nothing is created for it.
 *
 * SQLite always; PostgreSQL in a database of its own when TABLEWALK_TEST_PG
 * names a server.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal, flushJournal, history, journalKept, lastRevertible, revert } from '../packages/engine/src/server/journal.js';
import { WRITE_JOURNAL_RETENTION, postgresWriteJournalReady, sqliteWriteJournalReady } from '../packages/engine/src/server/journalStore.js';
import { setProduct } from '../packages/engine/src/server/product.js';
import { recordedDelete, recordedInsert, recordedUpdate } from '../packages/engine/src/server/recordWriteOperations.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SECRET = 'SECRET_SENTINEL_5d81';
const ID = 'journal-kept';

/** What one engine lends the cases: its URL, a raw read of the store's rows, and a raw statement. */
interface Backend {
  url: string;
  rows(): Promise<Array<{ id: number; at: number; entry: string }>>;
  exec(sql: string, values?: unknown[]): Promise<void>;
}

const open = async (backend: Backend) => {
  const registry = new Registry();
  registry.onWarning = (message) => assert.fail(`unexpected warning: ${message}`);
  registry.add({ id: ID, name: 'Kept', url: backend.url, source: 'config', writable: true, hidden: { item: ['secret'] } });
  const { adapter } = await registry.open(ID);
  return { registry, adapter };
};
/** A revert's outcome, with its reasons where it has any, so a refusal says why. */
const undone = (result: { outcome: string; errors?: string[] }) => ({
  outcome: result.outcome,
  ...(result.errors?.length ? { errors: result.errors } : {}),
});
/** A process ending and another starting: the handles close and memory is gone; only the database remains. */
const restart = async (registry: Registry) => {
  await registry.closeAll();
  clearJournal();
};
const rowOf = async (backend: Backend, adapter: Awaited<ReturnType<typeof open>>['adapter'], table: string, id: number) =>
  (
    await adapter.query({
      table: backend.url.startsWith('postgres') ? `public.${table}` : table,
      filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
      limit: 1,
      offset: 0,
    })
  ).rows[0];

async function proofs(t: TestContext, backend: Backend, table: string, tags: string) {
  await t.test('Undo history survives a restart and can still undo', async () => {
    let { registry, adapter } = await open(backend);
    try {
      assert.equal(journalKept(ID), true);
      const updated = await recordedUpdate({ adapter, connection: ID }, { table, key: { id: 1 }, values: { name: 'Ada Lovelace' } });
      // An insert into a table with no hidden column: undoing one removes a row, which a table that hides one refuses.
      const inserted = await recordedInsert({ adapter, connection: ID }, { table: tags, values: { id: 3, label: 'kept' } });
      assert.ok(updated.undoId && inserted.undoId);
      await flushJournal(ID);
      const before = history(ID).map(({ id, summary, kind, revertible }) => ({ id, summary, kind, revertible }));

      // Redaction holds: the hidden column is in neither image, by name or by value.
      const kept = await backend.rows();
      assert.equal(kept.length, 2);
      for (const row of kept) assert.doesNotMatch(row.entry, /secret|SECRET_SENTINEL/i);

      await restart(registry);
      ({ registry, adapter } = await open(backend));
      assert.deepEqual(
        history(ID).map(({ id, summary, kind, revertible }) => ({ id, summary, kind, revertible })),
        before,
        'the history read back is the one written',
      );
      const newest = lastRevertible(ID);
      assert.equal(newest?.id, inserted.undoId);
      assert.deepEqual(undone(await revert(adapter, ID, newest!)), { outcome: 'applied' });
      assert.equal(await rowOf(backend, adapter, 'tag', 3), undefined);
      const next = lastRevertible(ID);
      assert.equal(next?.id, updated.undoId);
      assert.deepEqual(undone(await revert(adapter, ID, next!)), { outcome: 'applied' });
      assert.equal((await rowOf(backend, adapter, 'item', 1))?.name, 'Ada');
      assert.equal((await backend.rows()).length, 0, 'an applied Undo is forgotten in the store too');

      // A new write after the restart is numbered past what was kept.
      const later = await recordedUpdate({ adapter, connection: ID }, { table, key: { id: 2 }, values: { name: 'Grace Hopper' } });
      assert.ok(later.undoId! > inserted.undoId!);
      await flushJournal(ID);
      assert.deepEqual(
        (await backend.rows()).map((row) => Number(row.id)),
        [later.undoId],
      );
      assert.deepEqual(undone(await revert(adapter, ID, lastRevertible(ID)!)), { outcome: 'applied' });
    } finally {
      await restart(registry);
    }
  });

  await t.test('an Undo left in progress comes back uncertain and blocks older ones', async () => {
    let { registry, adapter } = await open(backend);
    try {
      const first = await recordedUpdate({ adapter, connection: ID }, { table, key: { id: 1 }, values: { name: 'A' } });
      const second = await recordedUpdate({ adapter, connection: ID }, { table, key: { id: 2 }, values: { name: 'B' } });
      await flushJournal(ID);
      // What a process that stopped between marking the Undo and settling it leaves behind.
      const stored = (await backend.rows()).find((row) => Number(row.id) === second.undoId)!;
      await backend.exec(
        backend.url.startsWith('postgres')
          ? `UPDATE mistri.undo_entry SET entry = $1::jsonb WHERE id = $2`
          : `UPDATE __mistri_undo_entry SET entry_json = ? WHERE id = ?`,
        [JSON.stringify({ ...JSON.parse(stored.entry), undoState: 'pending' }), second.undoId],
      );
      await restart(registry);
      ({ registry, adapter } = await open(backend));
      const back = history(ID).find((entry) => entry.id === second.undoId)!;
      assert.equal(back.undoState, 'unknown');
      assert.equal(back.revertible, false);
      assert.equal(lastRevertible(ID), undefined, 'no older Undo is offered past an uncertain one');
      await flushJournal(ID);
      const settled = (await backend.rows()).find((row) => Number(row.id) === second.undoId)!;
      assert.equal(JSON.parse(settled.entry).undoState, 'unknown', 'the store says it too');
      assert.ok(history(ID).some((entry) => entry.id === first.undoId));
    } finally {
      await restart(registry);
      await backend.exec(backend.url.startsWith('postgres') ? 'DELETE FROM mistri.undo_entry' : 'DELETE FROM __mistri_undo_entry');
      await backend.exec(
        `UPDATE ${backend.url.startsWith('postgres') ? 'public.' : ''}item SET name = CASE id WHEN 1 THEN 'Ada' ELSE 'Grace' END`,
      );
    }
  });

  await t.test('retention keeps the newest fifty and nothing past a week', async () => {
    let { registry, adapter } = await open(backend);
    try {
      const total = WRITE_JOURNAL_RETENTION.entries + 6;
      for (let n = 0; n < total; n++)
        await recordedUpdate({ adapter, connection: ID }, { table, key: { id: 2 }, values: { name: `Grace ${n}` } });
      await flushJournal(ID);
      const kept = await backend.rows();
      assert.equal(kept.length, WRITE_JOURNAL_RETENTION.entries);
      assert.equal(history(ID, 100).length, WRITE_JOURNAL_RETENTION.entries);
      assert.deepEqual(
        kept.map((row) => Number(row.id)),
        history(ID, 100)
          .map((entry) => entry.id)
          .reverse(),
        'the store holds what memory holds',
      );
      // Age: the oldest kept entries are made eight days old; the next process does not read them back.
      const aged = kept.slice(0, 5).map((row) => Number(row.id));
      const old = Date.now() - 8 * 86_400_000;
      for (const id of aged)
        await backend.exec(
          backend.url.startsWith('postgres')
            ? 'UPDATE mistri.undo_entry SET at = $1 WHERE id = $2'
            : 'UPDATE __mistri_undo_entry SET at = ? WHERE id = ?',
          [old, id],
        );
      await restart(registry);
      ({ registry, adapter } = await open(backend));
      assert.equal(history(ID, 100).length, WRITE_JOURNAL_RETENTION.entries - aged.length);
      assert.ok(!history(ID, 100).some((entry) => aged.includes(entry.id)));
      assert.equal((await backend.rows()).length, WRITE_JOURNAL_RETENTION.entries - aged.length, 'pruned from the store, not only skipped');
    } finally {
      await restart(registry);
      await backend.exec(backend.url.startsWith('postgres') ? 'DELETE FROM mistri.undo_entry' : 'DELETE FROM __mistri_undo_entry');
    }
  });

  await t.test('a delete on a table with a hidden column is refused before anything is kept', async () => {
    const { registry, adapter } = await open(backend);
    try {
      await assert.rejects(recordedDelete({ adapter, connection: ID }, { table, key: { id: 2 } }));
      await flushJournal(ID);
      for (const row of await backend.rows()) assert.doesNotMatch(row.entry, /SECRET_SENTINEL/);
    } finally {
      await restart(registry);
      await backend.exec(backend.url.startsWith('postgres') ? 'DELETE FROM mistri.undo_entry' : 'DELETE FROM __mistri_undo_entry');
    }
  });
}

test('the write journal on SQLite: kept across a restart, bounded, redacted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-journal-store-'));
  const file = join(dir, 'kept.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, secret TEXT);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    INSERT INTO item VALUES (1, 'Ada', '${SECRET}'), (2, 'Grace', '${SECRET}');`);
  db.close();
  try {
    const made = await provisionStores({ sqlite: file }, { only: ['undo-journal'] });
    assert.deepEqual(made.stores['undo-journal'], { version: 1, provisioned: true });
    const check = new DatabaseSync(file);
    assert.equal(sqliteWriteJournalReady(check), true);
    check.close();
    const backend: Backend = {
      url: file,
      rows: async () => {
        const handle = new DatabaseSync(file);
        try {
          return handle.prepare('SELECT id, at, entry_json AS entry FROM __mistri_undo_entry ORDER BY id').all() as never;
        } finally {
          handle.close();
        }
      },
      exec: async (sql, values = []) => {
        const handle = new DatabaseSync(file);
        try {
          handle.prepare(sql).run(...(values as never[]));
        } finally {
          handle.close();
        }
      },
    };
    await proofs(t, backend, 'item', 'tag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the write journal on PostgreSQL: kept across a restart, bounded, redacted', { skip: liveSkip('postgres', LIVE) }, async (t) => {
  const database = await uuidPostgresDatabase('rc_journal');
  const client = await pgClient(database.url);
  try {
    await client.query(`CREATE TABLE item (id integer PRIMARY KEY, name text NOT NULL, secret text);
      CREATE TABLE tag (id integer PRIMARY KEY, label text NOT NULL);
      INSERT INTO item VALUES (1, 'Ada', '${SECRET}'), (2, 'Grace', '${SECRET}')`);
    const made = await provisionStores({ postgres: database.url }, { only: ['undo-journal'] });
    assert.deepEqual(made.stores['undo-journal'], { version: 1, provisioned: true });
    assert.equal(await postgresWriteJournalReady(client), true);
    const again = await provisionStores({ postgres: database.url }, { only: ['undo-journal'] });
    assert.deepEqual(again.stores['undo-journal'], { version: 1, provisioned: false });
    const backend: Backend = {
      url: database.url,
      rows: async () =>
        (await client.query('SELECT id, at, entry::text AS entry FROM mistri.undo_entry ORDER BY id')).rows.map((row: any) => ({
          id: Number(row.id),
          at: Number(row.at),
          entry: row.entry,
        })),
      exec: async (sql, values) => {
        await client.query(sql, values);
      },
    };
    await proofs(t, backend, 'public.item', 'public.tag');
  } finally {
    await client.end();
    await database.drop();
  }
});

test('a database without the store keeps the journal in memory, says so once in the browser, and is not touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-journal-memory-'));
  const file = join(dir, 'plain.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO item VALUES (1, 'Ada');`);
  db.close();
  const said: string[] = [];
  // An App offers no Undo, so it opens the same database without a word (`mistri check` read the notice as a failure).
  const app = new Registry();
  app.onWarning = (message) => said.push(message);
  app.add({ id: 'journal-memory', name: 'Plain', url: file, source: 'config', writable: true });
  await app.open('journal-memory');
  await app.closeAll();
  assert.equal(said.length, 0, 'an App says nothing of a journal it offers no Undo from');
  // The browser is where Undo lives, and where a restart forgetting it is news.
  setProduct('tablewalk');
  const registry = new Registry();
  registry.onWarning = (message) => said.push(message);
  registry.add({ id: 'journal-memory', name: 'Plain', url: file, source: 'config', writable: true });
  try {
    await registry.open('journal-memory');
    assert.equal(journalKept('journal-memory'), false);
    assert.equal(said.length, 1, 'the missing store is said once');
    assert.match(
      said[0],
      /"journal-memory": Undo history is kept in memory.*no undo-journal store.*provisionStores\(\{ sqlite: .*only: \['undo-journal'\]/,
    );
    // A dial again (a schema refresh) does not say it again.
    const { adapter } = await registry.refresh('journal-memory');
    assert.equal(said.length, 1, 'and not again on the next dial');
    const { undoId } = await recordedUpdate(
      { adapter, connection: 'journal-memory' },
      { table: 'item', key: { id: 1 }, values: { name: 'Ada L' } },
    );
    assert.equal(lastRevertible('journal-memory')?.id, undoId);
    await registry.closeAll();
    const check = new DatabaseSync(file);
    assert.deepEqual(
      check.prepare(`SELECT name FROM sqlite_schema WHERE name LIKE '__mistri%'`).all(),
      [],
      'opening a connection provisions nothing',
    );
    check.close();
    clearJournal('journal-memory');
    assert.equal(lastRevertible('journal-memory'), undefined, 'and a restart forgets it, as before');
  } finally {
    setProduct('mistri');
    await registry.closeAll();
    clearJournal();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a layout that is not this build’s is said once and the journal stays in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-journal-foreign-'));
  const file = join(dir, 'foreign.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE __mistri_undo_meta (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO __mistri_undo_meta VALUES (1, 2);`);
  db.close();
  const said: string[] = [];
  const registry = new Registry();
  registry.onWarning = (message) => said.push(message);
  registry.add({ id: 'journal-foreign', name: 'Foreign', url: file, source: 'config', writable: true });
  try {
    await registry.open('journal-foreign');
    assert.equal(journalKept('journal-foreign'), false);
    assert.equal(said.length, 1);
    assert.match(said[0], /kept in memory.*layout version 2, newer than the version 1/);
  } finally {
    await registry.closeAll();
    clearJournal();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read-only connection without the store says nothing about the journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-journal-readonly-'));
  const file = join(dir, 'readonly.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO item VALUES (1, 'Ada');`);
  db.close();
  const registry = new Registry();
  registry.onWarning = (message) => assert.fail(`unexpected warning: ${message}`);
  registry.add({ id: 'journal-readonly', name: 'Read only', url: file, source: 'config' });
  try {
    await registry.open('journal-readonly');
    assert.equal(journalKept('journal-readonly'), false);
  } finally {
    await registry.closeAll();
    clearJournal();
    rmSync(dir, { recursive: true, force: true });
  }
});
