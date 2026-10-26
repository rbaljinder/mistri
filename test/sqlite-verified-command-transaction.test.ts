/** Private ordinary transaction verifier only; no bearer admission. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const receipt: StoredCommandReceipt = {
  id: 'receipt-verified',
  appId: 'app',
  actorId: 'account',
  commandId: 'edit',
  commandVersion: 1,
  idempotencyKey: 'attempt-verified',
  fingerprint: 'digest',
  resultJson: '{"ok":true}',
  requestId: 'request-verified',
  completedAt: '2026-09-14T12:00:00.000Z',
};
const audit = { target: 'ticket', keyJson: '{"id":1}', changesJson: '[]' };
const update = { table: 'ticket', key: { id: 1 }, values: { name: 'Changed' } };
async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync) => Promise<void>, migrate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-verified-command-'));
  const path = join(dir, 'business.db');
  const db = new DatabaseSync(path);
  let adapter: SqliteAdapter | undefined;
  try {
    db.exec("CREATE TABLE ticket(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO ticket VALUES(1,'Original')");
    if (migrate) migrateSqliteCommandJournal(path);
    adapter = new SqliteAdapter(path);
    await run(adapter, db);
  } finally {
    await adapter?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const failed = (outcome: 'not_applied' | 'unknown', cause?: unknown) => (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, outcome);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
};
const unchanged = (db: DatabaseSync) => {
  assert.equal(db.prepare('SELECT name FROM ticket').get()?.name, 'Original');
  assert.equal(db.prepare('SELECT count(*) AS n FROM "' + tables.receipt + '"').get()?.n, 0);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM ${sqliteAuditRows} a`).get()?.n, 0);
};

test('private ordinary verifier surrounds handler and drained journal operations without changing receipt scope', async () => {
  await fixture(async (adapter, db) => {
    const order: string[] = [];
    let records: WriteTransaction | undefined, journal: CommandJournal | undefined;
    await commandsOf(adapter).verifiedCommandTransaction(
      () => {
        order.push('verify');
        const writer = Reflect.get(adapter, 'writeDb') as DatabaseSync;
        assert.equal(writer.isTransaction, true);
        if (order.length > 1) assert.equal(writer.prepare('SELECT name FROM ticket').get()?.name, 'Changed');
      },
      async (tx, store) => {
        records = tx;
        journal = store;
        order.push('handler');
        assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'lockRecord', 'query', 'remove', 'update']);
        void tx.update(update);
        void store.commit(receipt, audit);
        order.push('return');
      },
    );
    assert.deepEqual(order, ['verify', 'handler', 'return', 'verify']);
    assert.equal(db.prepare('SELECT name FROM ticket').get()?.name, 'Changed');
    await commandsOf(adapter).commandTransaction(async (_tx, store) => assert.deepEqual(await store.find(receipt), receipt));
    const namespace = db.prepare('SELECT store_id,source_id,tenant_id FROM "' + tables.receipt + '"').get();
    assert.deepEqual({ ...namespace }, { store_id: '', source_id: '', tenant_id: '' });
    await assert.rejects(records!.update(update));
    await assert.rejects(journal!.find(receipt));
  });
});

test('entry and final owner refusal preserve ordinary not_applied rollback outcomes', async () => {
  for (const phase of ['entry', 'final'])
    await fixture(async (adapter, db) => {
      let checks = 0,
        called = false;
      const cause = new Error('owner retired');
      await assert.rejects(
        commandsOf(adapter).verifiedCommandTransaction(
          () => {
            if (++checks === (phase === 'entry' ? 1 : 2)) throw cause;
          },
          async (tx, journal) => {
            called = true;
            await tx.update(update);
            await journal.commit(receipt, audit);
          },
        ),
        failed('not_applied', cause),
      );
      assert.equal(called, phase === 'final');
      unchanged(db);
    });
});

test('nonvoid and async owner verifiers refuse before handler and rejected promises are observed', async () => {
  for (const verify of [() => true, () => 1, () => ({}), () => Promise.resolve(), () => Promise.reject(new Error('private'))]) {
    await fixture(async (adapter, db) => {
      let called = false;
      await assert.rejects(
        commandsOf(adapter).verifiedCommandTransaction(verify, async () => {
          called = true;
        }),
        failed('not_applied'),
      );
      assert.equal(called, false);
      unchanged(db);
    });
  }
  await fixture(async (adapter) => {
    let calls = 0;
    const proxy = new Proxy(() => {}, {
      apply() {
        calls++;
      },
    });
    await assert.rejects(commandsOf(adapter).verifiedCommandTransaction(proxy, async () => {}));
    assert.equal(calls, 0);
  });
});

test('unawaited rejected record operation poisons transaction before final verifier', async () => {
  await fixture(async (adapter, db) => {
    let checks = 0;
    await assert.rejects(
      commandsOf(adapter).verifiedCommandTransaction(
        () => {
          checks++;
        },
        async (tx, journal) => {
          await tx.update(update);
          await journal.commit(receipt, audit);
          void tx.insert({ table: 'ticket', values: { id: 1, name: 'Duplicate' } });
        },
      ),
      failed('not_applied'),
    );
    assert.equal(checks, 1);
    unchanged(db);
  });
});

test('unmigrated journal still refuses without calling native verifier or handler', async () => {
  await fixture(async (adapter) => {
    let calls = 0;
    await assert.rejects(
      commandsOf(adapter).verifiedCommandTransaction(
        () => {
          calls++;
        },
        async () => {
          calls++;
        },
      ),
      failed('not_applied'),
    );
    assert.equal(calls, 0);
  }, false);
});

test('lost COMMIT acknowledgement keeps unknown and durable ordinary receipt', async (t) => {
  await fixture(async (adapter, db) => {
    await commandsOf(adapter).commandTransaction(async () => {});
    const writer = Reflect.get(adapter, 'writeDb') as DatabaseSync;
    const exec = writer.exec.bind(writer);
    const cause = new Error('lost acknowledgement');
    t.mock.method(writer, 'exec', (sql: string) => {
      exec(sql);
      if (sql === 'COMMIT') throw cause;
    });
    await assert.rejects(
      commandsOf(adapter).verifiedCommandTransaction(
        () => {},
        async (tx, journal) => {
          await tx.update(update);
          await journal.commit(receipt, audit);
        },
      ),
      failed('unknown', cause),
    );
    assert.equal(db.prepare('SELECT name FROM ticket').get()?.name, 'Changed');
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => assert.deepEqual(await journal.find(receipt), receipt));
  });
});

test('owner retired during queued acquisition refuses before handler', async () => {
  await fixture(async (adapter, db) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = adapter.transaction(async () => {
      entered();
      await blocked;
    });
    await started;
    let retired = false,
      called = false,
      checks = 0;
    const cause = new Error('owner retired while queued');
    const pending = commandsOf(adapter).verifiedCommandTransaction(
      () => {
        checks++;
        if (retired) throw cause;
      },
      async () => {
        called = true;
      },
    );
    assert.equal(checks, 0, 'queued request must not verify against stale acquisition state');
    retired = true;
    release();
    await held;
    await assert.rejects(pending, failed('not_applied', cause));
    assert.equal(checks, 1);
    assert.equal(called, false);
    unchanged(db);
  });
});
