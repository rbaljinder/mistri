import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal, TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
  assertSqliteCommandJournal,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
  type CommandAudit,
  type CommandReceiptScope,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

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
const audit: CommandAudit = { target: 'ticket', keyJson: '{"id":1}', changesJson: '[{"field":"name"}]' };
const update = { table: 'ticket', key: { id: 1 }, values: { name: 'Updated' } };

async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync) => Promise<void>, migrate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-command-boundaries-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  let adapter: SqliteAdapter | undefined;
  try {
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO ticket VALUES (1, 'Original')");
    if (migrate) migrateSqliteCommandJournal(path);
    adapter = new SqliteAdapter(path);
    await run(adapter, db);
  } finally {
    await adapter?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const writer = (adapter: SqliteAdapter) => Reflect.get(adapter, 'writeDb') as DatabaseSync;
// A table by name, or a subquery (a receipt's targets, support/commandTargets.ts).
const count = (db: DatabaseSync, table: string, schema = 'main') =>
  db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `${schema}."${table}"`}`).get()?.n;
const notApplied = (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, 'not_applied');
  return true;
};
const unchanged = (db: DatabaseSync) => {
  assert.equal(db.prepare('SELECT name FROM main.ticket').get()?.name, 'Original');
  assert.equal(count(db, tables.receipt), 0);
  assert.equal(count(db, sqliteAuditRows), 0);
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tempObjects = [
  ...Object.values(tables).flatMap((table) => [
    { name: `table shadow of ${table}`, sql: `CREATE TEMP TABLE "${table.toUpperCase()}" AS SELECT * FROM main."${table}"` },
    { name: `view shadow of ${table}`, sql: `CREATE TEMP VIEW "${table}" AS SELECT * FROM main."${table}"` },
    {
      name: `unreserved TEMP trigger on main ${table}`,
      sql: `CREATE TEMP TRIGGER hook AFTER INSERT ON main."${table}" BEGIN SELECT 1; END`,
    },
  ]),
  {
    name: 'reserved TEMP trigger on unrelated main table',
    sql: `CREATE TEMP TRIGGER "${tables.receipt.toUpperCase()}" AFTER INSERT ON main.ticket BEGIN SELECT 1; END`,
  },
  {
    name: 'reserved TEMP index on unrelated TEMP table',
    sql: `CREATE TEMP TABLE scratch (id INTEGER); CREATE INDEX temp."${tables.meta}" ON scratch(id)`,
  },
  { name: 'unknown reserved TEMP table', sql: 'CREATE TEMP TABLE __mistri_command_future (id INTEGER)' },
  { name: 'unknown reserved TEMP view', sql: 'CREATE TEMP VIEW __MISTRI_COMMAND_FUTURE AS SELECT 1' },
];

for (const variant of tempObjects) {
  test(`journal refuses ${variant.name} before invoking callback`, async () => {
    await fixture(async (adapter, db) => {
      await commandsOf(adapter).commandTransaction(async () => {});
      const handle = writer(adapter);
      handle.exec(variant.sql);
      assert.throws(() => assertSqliteCommandJournal(handle), CommandJournalUnavailable);
      let called = false;
      await assert.rejects(
        commandsOf(adapter).commandTransaction(async () => {
          called = true;
        }),
        (error) => {
          notApplied(error);
          assert.ok((error as CommandTransactionFailure).cause instanceof CommandJournalUnavailable);
          return true;
        },
      );
      assert.equal(called, false);
      unchanged(db);
    });
  });
}

test('journal permits unrelated TEMP tables, views and triggers', async () => {
  await fixture(async (adapter, db) => {
    await commandsOf(adapter).commandTransaction(async () => {});
    writer(adapter).exec(`CREATE TEMP TABLE scratch (id INTEGER);
      CREATE TEMP VIEW scratch_view AS SELECT * FROM scratch;
      CREATE TEMP TRIGGER scratch_hook AFTER INSERT ON main.ticket BEGIN SELECT 1; END`);
    assertSqliteCommandJournal(writer(adapter));
    await commandsOf(adapter).commandTransaction(async (_tx, journal) => {
      await journal.commit(receipt, audit);
    });
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(count(db, sqliteAuditRows), 1);
  });
});

test('TEMP journal lookalikes cannot supply a missing main journal or trigger request migration', async () => {
  await fixture(async (adapter, db) => {
    await adapter.transaction(async () => {});
    writer(adapter).exec(`CREATE TEMP TABLE "${tables.meta}" (singleton INTEGER, version INTEGER);
      INSERT INTO temp."${tables.meta}" VALUES (1, 1);
      CREATE TEMP TABLE "${tables.receipt}" (id TEXT)`);
    let called = false;
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async () => {
        called = true;
      }),
      notApplied,
    );
    assert.equal(called, false);
    assert.deepEqual(db.prepare("SELECT name FROM main.sqlite_schema WHERE name GLOB '__mistri_command_*'").all(), []);
  }, false);
});

for (const kind of ['TABLE', 'VIEW']) {
  test(`main-qualified runtime journal survives TEMP ${kind.toLowerCase()} shadows created in trusted callback`, async () => {
    await fixture(async (adapter, db) => {
      const result = await commandsOf(adapter).commandTransaction(async (tx, journal) => {
        const handle = writer(adapter);
        // This is trusted raw SQL outside the capability, not a sandbox escape.
        for (const table of Object.values(tables)) {
          handle.exec(`CREATE TEMP ${kind} "${table}" AS SELECT * FROM main."${table}" WHERE 0`);
        }
        if (kind === 'TABLE') {
          handle.exec(`CREATE TEMP TRIGGER shadow_insert BEFORE INSERT ON "${tables.receipt}"
            BEGIN SELECT RAISE(ABORT, 'TEMP receipt used'); END`);
        }
        assert.equal(await journal.find(receipt), undefined);
        await tx.update(update);
        await journal.commit(receipt, audit);
        assert.equal(count(handle, tables.receipt, 'main'), 1);
        if (kind === 'TABLE') {
          assert.equal(count(handle, tables.receipt, 'temp'), 0);
          assert.equal(count(handle, tables.meta, 'temp'), 0);
        }
        return journal.find(receipt);
      });
      assert.deepEqual(result, receipt);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(db.prepare('SELECT name FROM main.ticket').get()?.name, 'Updated');
      assert.equal(count(db, tables.receipt), 1);
      assert.equal(count(db, sqliteAuditRows), 1);
    });
  });
}

test('find captures every receipt membership field before waiting in the shared queue', async () => {
  await fixture(async (_adapter, db) => {
    const operations = new TransactionOperations();
    const journal = createSqliteCommandJournal(db, operations);
    await journal.commit(receipt, audit);
    const variants: Partial<CommandReceiptScope>[] = [
      { appId: 'other-app' },
      { actorId: 'other-actor' },
      { commandId: 'other-command' },
      { commandVersion: 2 },
      { idempotencyKey: 'other-attempt' },
    ];
    for (const [i, variant] of variants.entries()) {
      const other = { ...receipt, ...variant, id: `other-${i}`, resultJson: '{"private":"other"}' };
      await journal.commit(other, audit);
      const scope = { ...receipt };
      const pause = gate();
      const blocked = operations.run(() => pause.promise);
      const pending = journal.find(scope);
      Object.assign(scope, variant);
      pause.resolve();
      await blocked;
      const found = await pending;
      assert.deepEqual(found, receipt);
      assert.equal(Object.isFrozen(found), true);
      assert.deepEqual(await journal.find(scope), other);
    }
    await operations.finish();
  });
});

test('commit captures receipt and audit before queuing and returned receipts stay detached and frozen', async () => {
  await fixture(async (_adapter, db) => {
    const operations = new TransactionOperations();
    const journal = createSqliteCommandJournal(db, operations);
    const input = { ...receipt };
    const auditInput = { ...audit };
    const pause = gate();
    const blocked = operations.run(() => pause.promise);
    const pending = journal.commit(input, auditInput);
    Object.assign(input, {
      id: 'mutated',
      appId: 'other',
      actorId: 'other',
      commandId: 'other',
      commandVersion: 2,
      idempotencyKey: 'other',
      fingerprint: 'other',
      resultJson: '{"other":true}',
      requestId: 'other',
      completedAt: '2026-09-08T12:00:00.000Z',
    });
    Object.assign(auditInput, { target: 'other', keyJson: 'null', changesJson: '[]' });
    pause.resolve();
    await blocked;
    await pending;
    const found = await journal.find(receipt);
    assert.deepEqual(found, receipt);
    assert.equal(await journal.find(input), undefined);
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
    assert.equal(Reflect.set(found!, 'resultJson', 'null'), false);
    db.prepare(`UPDATE main."${tables.receipt}" SET result_json = 'null'`).run();
    assert.deepEqual(found, receipt);
    assert.equal((await journal.find(receipt))?.resultJson, 'null');
    await operations.finish();
    assert.deepEqual(found, receipt);
  });
});

const malformed = [
  {
    name: 'accessor',
    make: () =>
      Object.defineProperty({}, 'extra', {
        enumerable: true,
        get() {
          throw new Error('must not invoke getter');
        },
      }),
  },
  {
    name: 'cycle',
    make: () => {
      const value: Record<string, unknown> = {};
      value.extra = value;
      return value;
    },
  },
  { name: 'symbol', make: () => ({ [Symbol('extra')]: true }) },
  { name: 'nonfinite data', make: () => ({ extra: Infinity }) },
];
for (const target of ['find', 'receipt', 'audit'] as const) {
  for (const variant of malformed) {
    test(`caught malformed ${target} ${variant.name} poisons queued journal and record operations and rolls back`, async () => {
      await fixture(async (adapter, db) => {
        let caught: unknown;
        await assert.rejects(
          commandsOf(adapter).commandTransaction(async (tx, journal) => {
            await tx.update(update);
            await journal.commit(receipt, audit);
            const bad = Object.defineProperties(
              { ...(target === 'audit' ? audit : receipt) },
              Object.getOwnPropertyDescriptors(variant.make()),
            );
            let pending!: Promise<unknown>;
            assert.doesNotThrow(() => {
              pending =
                target === 'find'
                  ? journal.find(bad as StoredCommandReceipt)
                  : target === 'receipt'
                    ? journal.commit(bad as StoredCommandReceipt, audit)
                    : journal.commit(receipt, bad as CommandAudit);
            });
            const handle = writer(adapter);
            const prepare = handle.prepare.bind(handle);
            const statements: string[] = [];
            handle.prepare = (sql) => {
              statements.push(sql);
              return prepare(sql);
            };
            try {
              const later = [
                tx.query({ table: 'ticket', limit: 10, offset: 0 }),
                tx.count('ticket'),
                tx.update(update),
                journal.find(receipt),
                journal.commit({ ...receipt, id: 'later', idempotencyKey: 'later' }, audit),
              ];
              await pending.catch((error) => {
                caught = error;
              });
              assert.ok(caught instanceof Refusal);
              assert.match(caught.message, /Invalid structured operation/);
              await Promise.all(later.map((operation) => assert.rejects(operation, (error) => error === caught)));
              assert.deepEqual(statements, []);
            } finally {
              handle.prepare = prepare;
            }
            return 'must not report success';
          }),
          (error) => {
            notApplied(error);
            assert.equal((error as CommandTransactionFailure).cause, caught);
            return true;
          },
        );
        unchanged(db);
      });
    });
  }
}

test('main receipt storage failure rolls back the receipt and business write', async () => {
  await fixture(async (adapter, db) => {
    await assert.rejects(
      commandsOf(adapter).commandTransaction(async (tx, journal) => {
        await tx.update(update);
        writer(adapter).exec(`DROP TABLE main."${tables.receipt}"`);
        await journal.commit(receipt, audit).catch(() => {});
      }),
      notApplied,
    );
    unchanged(db);
    assertSqliteCommandJournal(db);
  });
});
