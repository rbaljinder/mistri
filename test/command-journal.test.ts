import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
  isCommandJournalTable,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { groupAuditParts, splitAudit, stitchAudit } from '../packages/mistri/src/adapters/commands/commandAuditParts.js';

const receipt: StoredCommandReceipt = {
  id: 'receipt-1',
  appId: 'lending',
  actorId: 'reviewer',
  commandId: 'assign',
  commandVersion: 1,
  idempotencyKey: 'attempt-1',
  fingerprint: 'digest',
  resultJson: '{"assigned":true}',
  requestId: 'request-1',
  completedAt: '2026-09-07T12:00:00.000Z',
};
const audit = { target: 'loan', keyJson: '{"id":1}', changesJson: '[{"field":"name"}]' };
const update = { table: 'ticket', key: { id: 1 }, values: { name: 'Updated' } };
async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>, migrate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-command-journal-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO ticket VALUES (1, 'Original')");
  if (migrate) migrateSqliteCommandJournal(path);
  const adapter = new SqliteAdapter(path);
  try {
    await run(adapter, db, path);
  } finally {
    await adapter.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const name = (db: DatabaseSync) => db.prepare('SELECT name FROM ticket WHERE id = 1').get()?.name;
// A table by name, or a subquery (a receipt's targets, support/commandTargets.ts).
const count = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()?.n;
const failed = (outcome: 'not_applied' | 'unknown', cause?: unknown) => (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, outcome);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
};

test('command journal migration is explicit, existing-file only, idempotent and collision-safe', async () => {
  await fixture(async (_adapter, db, path) => {
    const absent = join(path, '..', 'absent.db');
    assert.throws(() => migrateSqliteCommandJournal(absent));
    assert.equal(existsSync(absent), false);
    assert.deepEqual(migrateSqliteCommandJournal(path), { version: 3, migrated: true });
    assert.deepEqual(migrateSqliteCommandJournal(path), { version: 3, migrated: false });
    assert.equal(name(db), 'Original');
    assert.equal(isCommandJournalTable(tables.receipt), true);
    assert.equal(isCommandJournalTable(tables.receipt.toUpperCase()), true);
    assert.equal(isCommandJournalTable('ticket'), false);
    db.exec(`CREATE TRIGGER unexpected AFTER INSERT ON "${tables.receipt}" BEGIN SELECT 1; END`);
    assert.throws(() => migrateSqliteCommandJournal(path), CommandJournalUnavailable);
    db.exec('DROP TRIGGER unexpected');
    db.exec(`ALTER TABLE "${tables.receipt}" ADD COLUMN unexpected TEXT`);
    assert.throws(() => migrateSqliteCommandJournal(path), CommandJournalUnavailable);
  }, false);
  await fixture(async (_adapter, db, path) => {
    db.exec(`CREATE TABLE "${tables.receipt}" (unrelated TEXT); INSERT INTO "${tables.receipt}" VALUES ('keep')`);
    assert.throws(() => migrateSqliteCommandJournal(path), CommandJournalUnavailable);
    assert.equal(db.prepare(`SELECT unrelated FROM "${tables.receipt}"`).get()?.unrelated, 'keep');
    assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(tables.meta), undefined);
  }, false);
});

test('unmigrated command store refuses before callback while ordinary transactions remain available', async () => {
  await fixture(async (adapter, db) => {
    let called = false;
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async () => {
        called = true;
      }),
      (error) => {
        failed('not_applied')(error);
        assert.ok((error as CommandTransactionFailure).cause instanceof CommandJournalUnavailable);
        return true;
      },
    );
    assert.equal(called, false);
    await adapter.transaction(async function (tx) {
      assert.equal(arguments.length, 1);
      assert.deepEqual(Object.keys(tx).sort(), [
        'aggregate',
        'count',
        'insert',
        'insertMany',
        'lockRecord',
        'query',
        'remove',
        'update',
        'updateMany',
      ]);
      await tx.update(update);
    });
    assert.equal(name(db), 'Updated');
    const cause = new Error('ordinary failure');
    await assert.rejects(
      adapter.transaction(async () => {
        throw cause;
      }),
      (error) => error === cause,
    );
  }, false);
});

test('records, receipt and paired audit commit together and receipt survives reopening', async () => {
  await fixture(async (adapter, db, path) => {
    await commandsOf(adapter).commandTransaction(async (tx, journal) => {
      assert.deepEqual(Object.keys(tx).sort(), [
        'aggregate',
        'count',
        'insert',
        'insertMany',
        'lockRecord',
        'query',
        'remove',
        'update',
        'updateMany',
      ]);
      assert.equal(await journal.find(receipt), undefined);
      await tx.update(update);
      await journal.commit(receipt, audit);
      assert.deepEqual(await journal.find(receipt), receipt);
      assert.equal(name(db), 'Original');
      assert.equal(count(db, tables.receipt), 0);
    });
    assert.equal(name(db), 'Updated');
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(count(db, sqliteAuditRows), 1);
    assert.deepEqual(
      { ...db.prepare(`SELECT * FROM ${sqliteAuditRows} a`).get() },
      {
        receipt_id: receipt.id,
        ordinal: 0,
        target: audit.target,
        key_json: audit.keyJson,
        changes_json: audit.changesJson,
        app_id: receipt.appId,
        actor_id: receipt.actorId,
        store_id: '',
        source_id: '',
        tenant_id: '',
        membership_id: '',
        membership_version: '',
        realm_version: '',
        roles_json: '[]',
        deployment: '',
        realm: 'tenant',
        owner_tenant_id: '',
      },
    );
    const reopened = new SqliteAdapter(path);
    try {
      await commandsOf(reopened).commandTransaction(async (_tx, journal) => {
        assert.deepEqual(await journal.find(receipt), receipt);
        for (const variant of [
          { appId: 'other' },
          { actorId: 'other' },
          { commandId: 'other' },
          { commandVersion: 2 },
          { idempotencyKey: 'other' },
        ]) {
          assert.equal(await journal.find({ ...receipt, ...variant }), undefined);
        }
      });
    } finally {
      await reopened.close();
    }
  });
});

/* A target's changes past the first 256 are continuation rows of the receipt: written in its transaction, one set per
   receipt (a replay writes none), stitched back in order, and gone with the receipt. */
const longAudit = (count: number) => ({
  ...audit,
  ...splitAudit(Array.from({ length: count }, (_, at) => ({ field: `f${at}` }))),
});
const partsOf = (db: DatabaseSync, id = receipt.id) =>
  db
    .prepare(
      `SELECT receipt_id, target_index, part, changes_json FROM "${tables.auditPart}" WHERE receipt_id = ? ORDER BY target_index, part`,
    )
    .all(id);

test('300 changes on one target are 256 in the receipt and 44 in audit part 1, and read back as 300 in order', async () => {
  await fixture(async (adapter, db) => {
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      await journal.commit(receipt, longAudit(300));
    });
    const row = db.prepare(`SELECT changes_json FROM "${tables.receipt}"`).get() as { changes_json: string };
    const [head] = JSON.parse(row.changes_json) as string[];
    assert.equal((JSON.parse(head) as unknown[]).length, 256);
    const parts = partsOf(db);
    assert.deepEqual(
      parts.map((part) => [part.target_index, part.part, (JSON.parse(part.changes_json as string) as unknown[]).length]),
      [[0, 1, 44]],
    );
    const whole = JSON.parse(stitchAudit(head, groupAuditParts(parts).get(0))) as Array<{ field: string }>;
    assert.deepEqual(
      whole.map((change) => change.field),
      Array.from({ length: 300 }, (_, at) => `f${at}`),
    );
    // A target with no more than 256 has no parts, and its text stitches to itself.
    assert.equal(stitchAudit(audit.changesJson), audit.changesJson);
    assert.equal(stitchAudit(head, []), head);
  });
});

test('audit parts belong to their receipt: a replay writes none, a rolled-back commit leaves none, deleting the receipt takes them', async () => {
  await fixture(async (adapter, db) => {
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      assert.equal(await journal.insert!(receipt, longAudit(600)), true);
    });
    assert.equal(partsOf(db).length, 2);
    // The same scope again finds its receipt taken: false, and the pieces already there are the only ones.
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      assert.equal(await journal.insert!({ ...receipt, id: 'receipt-replay' }, longAudit(600)), false);
      assert.equal(await journal.taken!(receipt), true);
    });
    assert.equal(partsOf(db).length, 2);
    assert.equal(partsOf(db, 'receipt-replay').length, 0);
    // A command that fails after its commit takes the pieces back with everything else.
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (_tx, journal) => {
        await journal.commit({ ...receipt, id: 'receipt-2', idempotencyKey: 'attempt-2' }, longAudit(300));
        throw new Error('business rule refused');
      }),
    );
    assert.equal(partsOf(db, 'receipt-2').length, 0);
    // Forgotten with its receipt (retention deletes with foreign keys on, as the job opens the file).
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(`DELETE FROM "${tables.receipt}" WHERE id = ?`).run(receipt.id);
    assert.equal(count(db, tables.auditPart), 0);
  });
});

/* The journal's own copy of what it is given is bounded by the receipt's bounds, not the scoped-read snapshot's
   1M characters: a long audit inside 4 MiB is kept whole, and one past every bound is refused by name. */
test('an audit of 4,096 changes and 2M characters is kept whole; a copy past the receipt bounds is refused by name', async () => {
  await fixture(async (adapter, db) => {
    const wide = (count: number, width: number) => ({
      ...audit,
      ...splitAudit(Array.from({ length: count }, (_, at) => ({ field: `f${at}`, note: 'n'.repeat(width) }))),
    });
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      await journal.commit(receipt, wide(4096, 480));
    });
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(partsOf(db).length, 15);
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (_tx, journal) => {
        await journal.commit({ ...receipt, id: 'receipt-2', idempotencyKey: 'attempt-2' }, wide(4096, 2048));
      }),
      (error: Error & { cause?: Error }) => /journal keeps at most 7,405,568 characters/.test(String(error.cause?.message)),
    );
    assert.equal(count(db, tables.receipt), 1);
  });
});

test('audit parts are refused when they are not whole pieces or run past 4,096 changes, and none of them is written', async () => {
  await fixture(async (adapter, db) => {
    const whole = (count: number) => JSON.stringify(Array.from({ length: count }, (_, at) => ({ field: `f${at}` })));
    const refusals: Array<[string, readonly string[]]> = [
      ['a piece that is not an array', ['{"field":"f0"}']],
      ['an empty piece', ['[]']],
      ['a piece of more than 256', [whole(257)]],
      ['a piece short of 256 before the last', [whole(10), whole(10)]],
      ['more than sixteen pieces in all', Array.from({ length: 16 }, () => whole(256))],
    ];
    for (const [, parts] of refusals)
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (_tx, journal) => {
          await journal.commit(receipt, { ...audit, changesParts: parts });
        }),
      );
    assert.equal(count(db, tables.receipt), 0);
    assert.equal(count(db, tables.auditPart), 0);
  });
});

test('body failures and caught journal validation errors roll back every earlier write', async () => {
  await fixture(async (adapter, db) => {
    const cause = new Error('business rule refused');
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (tx, journal) => {
        await tx.update(update);
        await journal.commit(receipt, audit);
        throw cause;
      }),
      failed('not_applied', cause),
    );
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 0);
    for (const bad of [
      { ...receipt, resultJson: 'broken' },
      { ...receipt, resultJson: JSON.stringify('é'.repeat(8192)) },
      { ...receipt, appId: '' },
      { ...receipt, commandVersion: 0 },
      { ...receipt, completedAt: 'yesterday' },
    ]) {
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (tx, journal) => {
          await tx.update(update);
          await journal.commit(bad, audit).catch(() => {});
        }),
        failed('not_applied'),
      );
      assert.equal(name(db), 'Original');
    }
    for (const bad of [
      { ...audit, keyJson: JSON.stringify('x'.repeat(8192)) },
      { ...audit, changesJson: JSON.stringify('x'.repeat(4_194_304)) },
    ]) {
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (tx, journal) => {
          await tx.update(update);
          await journal.commit(receipt, bad);
        }),
        failed('not_applied'),
      );
    }
    assert.equal(count(db, tables.receipt), 0);
    assert.equal(count(db, sqliteAuditRows), 0);
  });
});

test('duplicate scoped receipts never overwrite and a caught failure remains transaction-fatal', async () => {
  await fixture(async (adapter, db) => {
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      await journal.commit(receipt, audit);
    });
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (tx, journal) => {
        await tx.update(update);
        await journal.commit({ ...receipt, id: 'different', resultJson: 'null' }, audit).catch(() => {});
      }),
      failed('not_applied'),
    );
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(count(db, sqliteAuditRows), 1);
  });
});

test('journal and record handles expire after both commit and rollback', async () => {
  await fixture(async (adapter) => {
    for (const abort of [false, true]) {
      let journal!: CommandJournal;
      let tx!: WriteTransaction;
      const result = commandsOf(adapter).commandTransaction(async (records, store) => {
        journal = store;
        tx = records;
        if (abort) throw new Error('stop');
      });
      if (abort) await assert.rejects(result, failed('not_applied'));
      else await result;
      await assert.rejects(journal.find(receipt), /no longer active/);
      await assert.rejects(journal.commit(receipt, audit), /no longer active/);
      await assert.rejects(tx.update(update), /no longer active/);
    }
  });
});

test('failure inserting the receipt row rolls back earlier business writes', async () => {
  await fixture(async (adapter, db) => {
    let restore = () => {};
    const cause = new Error('receipt storage failure');
    try {
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (tx, journal) => {
          await tx.update(update);
          const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
          const original = handle.prepare.bind(handle);
          handle.prepare = (sql) => {
            if (sql.startsWith(`INSERT INTO main."${tables.receipt}"`)) throw cause;
            return original(sql);
          };
          restore = () => {
            handle.prepare = original;
          };
          await journal.commit(receipt, audit).catch(() => {});
        }),
        failed('not_applied', cause),
      );
    } finally {
      restore();
    }
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 0);
    assert.equal(count(db, sqliteAuditRows), 0);
  });
});

test('commit or rollback acknowledgement loss reports unknown rather than claiming no writes', async () => {
  for (const acknowledgement of ['COMMIT', 'ROLLBACK']) {
    await fixture(async (adapter, db) => {
      let restore = () => {};
      const cause = new Error('acknowledgement lost');
      try {
        await assert.rejects(
          commandsOf(adapter).commandTransaction(async (tx, journal) => {
            await tx.update(update);
            await journal.commit(receipt, audit);
            const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
            const original = handle.exec.bind(handle);
            handle.exec = (sql) => {
              original(sql);
              if (sql === acknowledgement) throw cause;
            };
            restore = () => {
              handle.exec = original;
            };
            if (acknowledgement === 'ROLLBACK') throw cause;
          }),
          failed('unknown', cause),
        );
      } finally {
        restore();
      }
      assert.equal(name(db), acknowledgement === 'COMMIT' ? 'Updated' : 'Original');
      assert.equal(count(db, tables.receipt), acknowledgement === 'COMMIT' ? 1 : 0);
      assert.equal(count(db, sqliteAuditRows), acknowledgement === 'COMMIT' ? 1 : 0);
    });
  }
});

test('failed rollback discards the uncertain connection before accepting another write', async () => {
  await fixture(async (adapter, db) => {
    const cause = new Error('business refusal');
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (tx, journal) => {
        await tx.update(update);
        await journal.commit(receipt, audit);
        const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
        const original = handle.exec.bind(handle);
        handle.exec = (sql) => {
          if (sql === 'ROLLBACK') throw new Error('rollback failed');
          original(sql);
        };
        throw cause;
      }),
      failed('unknown', cause),
    );
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    assert.equal(name(db), 'Original');
    assert.equal(count(db, tables.receipt), 0);
    await adapter.transaction(async (tx) => {
      await tx.update(update);
    });
    assert.equal(name(db), 'Updated');
  });
});

test('unawaited journal failures are observed and roll back accepted record work', async () => {
  const unhandled: unknown[] = [];
  const notice = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', notice);
  try {
    await fixture(async (adapter, db) => {
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (tx, journal) => {
          await tx.update(update);
          void journal.commit({ ...receipt, resultJson: 'invalid' }, audit);
        }),
        failed('not_applied'),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(name(db), 'Original');
      assert.equal(count(db, tables.receipt), 0);
      assert.deepEqual(unhandled, []);
    });
  } finally {
    process.off('unhandledRejection', notice);
  }
});

for (const queued of [false, true]) {
  test(`automatic SQLite rollback blocks ${queued ? 'already queued' : 'subsequent caught-error'} journal commit`, async () => {
    await fixture(async (adapter, db) => {
      // INSERT OR ABORT overrides a schema conflict policy. An explicit
      // trigger rollback still ends the transaction underneath the queue.
      db.exec(`CREATE TABLE unique_item (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
        INSERT INTO unique_item VALUES (1, 'existing');
        CREATE TRIGGER rollback_unique_item BEFORE INSERT ON unique_item
        WHEN EXISTS (SELECT 1 FROM unique_item WHERE name = NEW.name)
        BEGIN SELECT RAISE(ROLLBACK, 'forced automatic rollback'); END;`);
      let originalFailure: unknown;
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async (tx, journal) => {
          await tx.update(update);
          const rejectedWrite = tx.insert({ table: 'unique_item', values: { id: 2, name: 'existing' } });
          // In the queued case, enqueue the receipt before the constraint runs.
          // In the caught case, deliberately try to continue after it has failed.
          const queuedCommit = queued ? journal.commit(receipt, audit) : undefined;
          await assert.rejects(rejectedWrite, (error) => {
            originalFailure = error;
            assert.match((error as Error).message, /forced automatic rollback/);
            assert.equal(
              Reflect.get(Reflect.get(adapter, 'writeDb'), 'isTransaction'),
              false,
              'the trigger ended the transaction before callback settlement',
            );
            return true;
          });
          await assert.rejects(queuedCommit ?? journal.commit(receipt, audit), (error) => error === originalFailure);
        }),
        (error) => {
          assert.notEqual(originalFailure, undefined);
          return failed('unknown', originalFailure)(error);
        },
      );
      assert.equal(name(db), 'Original', 'the engine rolled back the earlier business write');
      assert.equal(count(db, 'unique_item'), 1);
      assert.equal(count(db, tables.receipt), 0, 'no receipt may escape into autocommit');
      assert.equal(count(db, sqliteAuditRows), 0, 'no audit may escape into autocommit');
      assert.equal(Reflect.get(adapter, 'writeDb'), null, 'the uncertain writer is retired');

      await commandsOf(adapter).commandTransaction(async (tx, journal) => {
        assert.equal(await journal.find(receipt), undefined);
        await tx.update(update);
        await journal.commit(receipt, audit);
      });
      assert.equal(name(db), 'Updated');
      assert.equal(count(db, tables.receipt), 1);
      assert.equal(count(db, sqliteAuditRows), 1);
    });
  });
}
