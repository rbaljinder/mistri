/** Private journal storage projection only; no bearer or executor recovery. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
  recoverSqliteCommandReceipt,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const receipt: StoredCommandReceipt = {
  id: 'receipt',
  appId: 'app',
  actorId: 'actor',
  commandId: 'edit',
  commandVersion: 1,
  idempotencyKey: 'attempt',
  fingerprint: 'digest',
  resultJson: '{"ok":true}',
  requestId: 'request',
  completedAt: '2026-09-14T12:00:00.000Z',
};
const audits = [
  { target: 'ticket', keyJson: '{"id":2}', changesJson: '[{"secret":"do not expose"}]' },
  { target: 'ticket', keyJson: '{"id":1}', changesJson: '[]' },
];
async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-recovery-projection-'));
  const path = join(dir, 'business.db');
  const db = new DatabaseSync(path);
  let adapter: SqliteAdapter | undefined;
  try {
    db.exec("CREATE TABLE ticket(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO ticket VALUES(1,'before')");
    migrateSqliteCommandJournal(path);
    adapter = new SqliteAdapter(path);
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => journal.commit(receipt, audits));
    await run(adapter, db);
  } finally {
    await adapter?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ordinary private recovery shares find and returns immutable ordered target/key text only', async () => {
  await fixture(async (adapter, _db) => {
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      assert.deepEqual(Object.keys(journal).sort(), ['commit', 'find', 'insert', 'kept', 'nextNumber', 'taken']);
      assert.deepEqual(await journal.find(receipt), receipt);
      const recovered = await recoverSqliteCommandReceipt(journal, receipt);
      assert.ok(recovered);
      assert.deepEqual(recovered, { receipt, targets: audits.map(({ target, keyJson }) => ({ target, keyJson })) });
      assert.ok(Object.isFrozen(recovered));
      assert.ok(Object.isFrozen(recovered.receipt));
      assert.ok(Object.isFrozen(recovered.targets));
      assert.ok(recovered.targets.every(Object.isFrozen));
      assert.equal(JSON.stringify(recovered).includes('do not expose'), false);
      for (const change of [
        { appId: 'other' },
        { actorId: 'other' },
        { commandId: 'other' },
        { commandVersion: 2 },
        { idempotencyKey: 'other' },
      ]) {
        assert.equal(await recoverSqliteCommandReceipt(journal, { ...receipt, ...change }), undefined);
      }
    });
  });
});

test('private recovery is not duck typed and retained journal operations expire', async () => {
  await fixture(async (adapter, db) => {
    let retained: CommandJournal | undefined;
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      retained = journal;
      for (const candidate of [{ ...journal }, new Proxy(journal, {})]) {
        await assert.rejects(recoverSqliteCommandReceipt(candidate, receipt), CommandJournalUnavailable);
      }
    });
    await assert.rejects(recoverSqliteCommandReceipt(retained!, receipt));
    const tenant = createSqliteCommandJournal(db, new TransactionOperations(), {
      appId: 'app',
      storeId: 'store',
      sourceId: 'source',
      tenantId: 'north',
      actorId: 'actor',
      membershipId: 'member',
      membershipVersion: '1',
      tenantVersion: '1',
      roles: ['reader'],
      deployment: 'deployment',
    });
    await assert.rejects(recoverSqliteCommandReceipt(tenant, receipt), CommandJournalUnavailable);
  });
});

test('raw stored key JSON is preserved without pretending to validate command-key types', async () => {
  await fixture(async (adapter, db) => {
    for (const keyJson of ['42', '{"id":"9007199254740993"}', '{ "id": 9007199254740993 }']) {
      db.prepare('UPDATE "' + tables.receipt + `" SET keys_json=json_array(?, json_extract(keys_json, '$[1]'))`).run(keyJson);
      await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
        assert.deepEqual(await journal.find(receipt), receipt);
        assert.equal((await recoverSqliteCommandReceipt(journal, receipt))?.targets[0].keyJson, keyJson);
      });
    }
  });
});

test('malformed later targets poison recovery and roll back earlier transaction work', async () => {
  await fixture(async (adapter, db) => {
    // The later target's key is gone: the receipt's arrays no longer line up.
    db.prepare('UPDATE "' + tables.receipt + `" SET keys_json=json_array(json_extract(keys_json, '$[0]'))`).run();
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (tx, journal) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { value: 'changed' } });
        await recoverSqliteCommandReceipt(journal, receipt).catch(() => {});
      }),
      (error) => error instanceof CommandTransactionFailure && error.outcome === 'not_applied',
    );
    assert.equal(db.prepare('SELECT value FROM ticket').get()?.value, 'before');
    await assert.rejects(commandsOf(adapter).commandTransaction(async (_tx, journal) => journal.find(receipt)));
  });
});
