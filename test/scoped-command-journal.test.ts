import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type Filter, type QueryRequest, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
  isCommandJournalTable,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeA = (): RowScope => ({ item: eq('tenant', 'a'), owner: eq('tenant', 'a'), unique_item: true });
const page = (table = 'item', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const update = { table: 'item', key: { id: 1 }, values: { name: 'Updated' } };
const receipt: StoredCommandReceipt = {
  id: 'receipt-1',
  appId: 'scoped-app',
  actorId: 'actor-a',
  commandId: 'assign',
  commandVersion: 1,
  idempotencyKey: 'attempt-1',
  fingerprint: 'digest',
  resultJson: '{"assigned":true}',
  requestId: 'request-1',
  completedAt: '2026-09-07T12:00:00.000Z',
};
const audit = { target: 'item', keyJson: '{"id":1}', changesJson: '[{"field":"name"}]' };

function fixture(t: TestContext, migrate = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-command-journal-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  let adapter: SqliteAdapter | undefined;
  t.after(async () => {
    try {
      await adapter?.close();
    } finally {
      try {
        db.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  db.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, name TEXT);
    CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL DEFAULT 'a', name TEXT NOT NULL,
      owner_id INTEGER DEFAULT 1 REFERENCES owner(id));
    CREATE TABLE unique_item (id INTEGER PRIMARY KEY, name TEXT UNIQUE ON CONFLICT ROLLBACK);
    INSERT INTO owner VALUES (1, 'a', 'Alice'), (2, 'b', 'Bob');
    INSERT INTO item VALUES (1, 'a', 'Original', 1), (2, 'b', 'Hidden', 2), (3, 'a', 'Hidden parent', 2);
    INSERT INTO unique_item VALUES (1, 'existing');
  `);
  if (migrate) migrateSqliteCommandJournal(path);
  adapter = new SqliteAdapter(path);
  return { adapter, db, path };
}

const name = (db: DatabaseSync) => db.prepare('SELECT name FROM item WHERE id = 1').get()?.name;
// A table by name, or a subquery (a receipt's targets, support/commandTargets.ts).
const count = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()?.n;
function unchanged(db: DatabaseSync) {
  assert.deepEqual(
    db
      .prepare('SELECT * FROM item ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, tenant: 'a', name: 'Original', owner_id: 1 },
      { id: 2, tenant: 'b', name: 'Hidden', owner_id: 2 },
      { id: 3, tenant: 'a', name: 'Hidden parent', owner_id: 2 },
    ],
  );
  assert.equal(count(db, tables.receipt), 0);
  assert.equal(count(db, sqliteAuditRows), 0);
}
const failed = (outcome: 'not_applied' | 'unknown', cause?: unknown) => (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, outcome);
  if (cause !== undefined) assert.equal(error.cause, cause);
  return true;
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function writer(adapter: SqliteAdapter): Promise<DatabaseSync> {
  await adapter.transaction(async () => {});
  const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync | null;
  assert.ok(handle);
  return handle;
}

test('scoped command capability requires explicit migration before entering the callback', async (t) => {
  const { adapter, db, path } = fixture(t, false);
  const capability: Adapter = adapter;
  assert.equal(typeof commandsOf(capability).scopeCommandTransaction, 'function');
  let called = false;
  await assert.rejects(
    commandsOf(adapter).scopeCommandTransaction(scopeA(), async () => {
      called = true;
    }),
    (error) => {
      failed('not_applied')(error);
      assert.ok((error as CommandTransactionFailure).cause instanceof CommandJournalUnavailable);
      return true;
    },
  );
  assert.equal(called, false);
  assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name LIKE ?').all('__mistri_command_%').length, 0);
  assert.equal(name(db), 'Original');
  assert.deepEqual(migrateSqliteCommandJournal(path), { version: 1, migrated: true });
  assert.deepEqual(migrateSqliteCommandJournal(path), { version: 1, migrated: false });
  await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
    await tx.update(update);
    await journal.commit(receipt, audit);
  });
  assert.equal(name(db), 'Updated');
  assert.equal(count(db, tables.receipt), 1);
  assert.equal(count(db, sqliteAuditRows), 1);
});

for (const [label, sql] of [
  ['missing receipt table', `DROP TABLE "${tables.receipt}"`],
  ['altered receipt schema', `ALTER TABLE "${tables.receipt}" ADD COLUMN injected TEXT`],
  ['missing version row', `DELETE FROM "${tables.meta}"`],
  ['unexpected journal trigger', `CREATE TRIGGER journal_trigger AFTER INSERT ON "${tables.receipt}" BEGIN SELECT 1; END`],
  ['extra reserved table', 'CREATE TABLE __mistri_command_extra (id INTEGER PRIMARY KEY)'],
] as const) {
  test(`scoped commands refuse ${label} before callback`, async (t) => {
    const { adapter, db } = fixture(t);
    db.exec(sql);
    let called = false;
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction(scopeA(), async () => {
        called = true;
      }),
      (error) => {
        failed('not_applied')(error);
        assert.ok((error as CommandTransactionFailure).cause instanceof CommandJournalUnavailable);
        return true;
      },
    );
    assert.equal(called, false);
    assert.equal(name(db), 'Original');
  });
}

test('scoped reads and CRUD share one atomic commit with the receipt and paired audit', async (t) => {
  const { adapter, db, path } = fixture(t);
  const result = await commandsOf(adapter).scopeCommandTransaction(scopeA(), async function (tx, journal, catalog) {
    assert.equal(arguments.length, 3);
    assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    assert.deepEqual(Object.keys(journal).sort(), ['commit', 'find', 'insert', 'kept', 'nextNumber', 'taken']);
    assert.ok(Object.isFrozen(tx) && Object.isFrozen(journal));
    assert.ok(catalog.tables.some((table) => table.id === 'item'));
    assert.equal(await tx.count('item'), 2);
    assert.equal(await tx.count('item', eq('id', 2)), 0);
    assert.deepEqual((await tx.query(page('item', { filter: eq('id', 2) }))).rows, []);
    assert.equal(await journal.find(receipt), undefined);
    await tx.update(update);
    await tx.insert({ table: 'item', values: { id: 4, name: 'Created' } });
    await tx.remove({ table: 'item', key: { id: 3 } });
    assert.deepEqual((await tx.query(page('item', { columns: ['id', 'name'], orderBy: [{ column: 'id', direction: 'asc' }] }))).rows, [
      { id: 1, name: 'Updated' },
      { id: 4, name: 'Created' },
    ]);
    await journal.commit(receipt, audit);
    assert.deepEqual(await journal.find(receipt), receipt);
    unchanged(db);
    return { committed: true };
  });
  assert.deepEqual(result, { committed: true });
  assert.equal(name(db), 'Updated');
  assert.equal(count(db, 'item'), 3);
  assert.equal(count(db, tables.receipt), 1);
  assert.equal(count(db, sqliteAuditRows), 1);
  assert.deepEqual(
    { ...db.prepare(`SELECT * FROM ${sqliteAuditRows} a`).get() },
    {
      receipt_id: receipt.id,
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
      ordinal: 0,
    },
  );
  const reopened = new SqliteAdapter(path);
  try {
    await commandsOf(reopened).scopeCommandTransaction(scopeA(), async (_tx, journal) => {
      assert.deepEqual(await journal.find(receipt), receipt);
      for (const other of [
        { actorId: 'other' },
        { appId: 'other' },
        { commandId: 'other' },
        { commandVersion: 2 },
        { idempotencyKey: 'other' },
      ]) {
        assert.equal(await journal.find({ ...receipt, ...other }), undefined);
      }
    });
  } finally {
    await reopened.close();
  }
});

const denied: [string, (tx: WriteTransaction) => Promise<unknown>][] = [
  ['hidden row update', (tx) => tx.update({ table: 'item', key: { id: 2 }, values: { name: 'Forbidden' } })],
  ['hidden row delete', (tx) => tx.remove({ table: 'item', key: { id: 2 } })],
  ['out-of-scope insert', (tx) => tx.insert({ table: 'item', values: { id: 4, tenant: 'b', name: 'Forbidden' } })],
  ['ownership change', (tx) => tx.update({ table: 'item', key: { id: 1 }, values: { tenant: 'b' } })],
  ['hidden parent insert', (tx) => tx.insert({ table: 'item', values: { id: 4, name: 'Forbidden', owner_id: 2 } })],
  ['hidden parent reassignment', (tx) => tx.update({ table: 'item', key: { id: 1 }, values: { owner_id: 2 } })],
  ['unchanged hidden parent', (tx) => tx.update({ table: 'item', key: { id: 3 }, values: { name: 'Forbidden' } })],
];
for (const [label, operation] of denied) {
  test(`caught ${label} rolls back earlier records, receipt and audit`, async (t) => {
    const { adapter, db } = fixture(t);
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
        await tx.update(update);
        await journal.commit(receipt, audit);
        await assert.rejects(operation(tx), Refusal);
        await assert.rejects(tx.query(page()));
        await assert.rejects(journal.find(receipt));
      }),
      failed('not_applied'),
    );
    unchanged(db);
  });
}

for (const engineRollback of [false, true])
  for (const queued of [false, true]) {
    test(`receipt ${queued ? 'already queued' : 'submitted after a caught error'} cannot escape ${engineRollback ? 'engine rollback' : 'a failed scoped record'}`, async (t) => {
      const { adapter, db } = fixture(t);
      const handle = await writer(adapter);
      const prepare = handle.prepare.bind(handle);
      if (engineRollback) {
        // Scoped INSERT OR ABORT normally keeps rollback confirmable. Inject the
        // driver's engine-rollback path on this one statement to prove that a
        // queued receipt cannot run in autocommit after the transaction vanishes.
        handle.prepare = (sql) =>
          prepare(sql.startsWith('INSERT OR ABORT INTO "unique_item"') ? sql.replace('INSERT OR ABORT INTO', 'INSERT INTO') : sql);
      }
      let cause: unknown;
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
          await tx.update(update);
          const rejected = tx.insert({ table: 'unique_item', values: { id: 2, name: 'existing' } });
          const commit = queued ? journal.commit(receipt, audit) : undefined;
          await assert.rejects(rejected, (error) => {
            cause = error;
            assert.match((error as Error).message, /UNIQUE constraint failed/);
            return true;
          });
          await assert.rejects(commit ?? journal.commit(receipt, audit), (error) => error === cause);
        }),
        (error) => {
          assert.notEqual(cause, undefined);
          return failed(engineRollback ? 'unknown' : 'not_applied', cause)(error);
        },
      );
      handle.prepare = prepare;
      unchanged(db);
      assert.equal(count(db, 'unique_item'), 1);
      if (engineRollback) assert.equal(Reflect.get(adapter, 'writeDb'), null);
      await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
        await tx.update(update);
        await journal.commit(receipt, audit);
      });
      assert.equal(name(db), 'Updated');
      assert.equal(count(db, tables.receipt), 1);
      assert.equal(count(db, sqliteAuditRows), 1);
    });
  }

for (const queued of [false, true]) {
  test(`malformed receipt stops ${queued ? 'already queued' : 'later'} records even when caught`, async (t) => {
    const { adapter, db } = fixture(t);
    const handle = await writer(adapter);
    const prepare = handle.prepare.bind(handle);
    let inserts = 0;
    handle.prepare = (sql) => {
      if (/^INSERT (?:OR ABORT )?INTO "item"/i.test(sql)) inserts++;
      return prepare(sql);
    };
    try {
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
          await tx.update(update);
          const invalid = journal.commit({ ...receipt, resultJson: 'broken' }, audit);
          const insert = () => tx.insert({ table: 'item', values: { id: 4, name: 'Must not execute' } });
          const pending = queued ? insert() : undefined;
          await assert.rejects(invalid, Refusal);
          await assert.rejects(pending ?? insert());
          await assert.rejects(tx.count('item'));
          await assert.rejects(journal.commit(receipt, audit));
        }),
        failed('not_applied'),
      );
    } finally {
      handle.prepare = prepare;
    }
    assert.equal(inserts, 0, 'records queued behind invalid journal input must never execute');
    unchanged(db);
  });
}

test('scoped command captures policy before waiting for the writer', async (t) => {
  const { adapter, db } = fixture(t);
  const entered = gate(),
    release = gate();
  const blocker = adapter.transaction(async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const rule = eq('tenant', 'a');
  const scope: Record<string, boolean | Filter> = { item: rule, owner: eq('tenant', 'a') };
  const pending = commandsOf(adapter).scopeCommandTransaction(scope, async (tx, journal) => {
    assert.deepEqual((await tx.query(page('item', { columns: ['id'], orderBy: [{ column: 'id', direction: 'asc' }] }))).rows, [
      { id: 1 },
      { id: 3 },
    ]);
    await tx.update(update);
    await journal.commit(receipt, audit);
  });
  rule.groups[0][0].value = 'b';
  scope.item = true;
  delete scope.owner;
  release.release();
  await Promise.all([blocker, pending]);
  assert.equal(name(db), 'Updated');
  assert.equal(count(db, tables.receipt), 1);
});

test('scoped command snapshots queued record requests and nested predicates', async (t) => {
  const { adapter, db } = fixture(t);
  await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
    const request = { table: 'item', key: { id: 1 }, values: { name: 'Captured' }, expected: { name: 'Original' } };
    const query = page('item', { columns: ['name'], filter: eq('id', 1) });
    const filter = eq('name', 'Captured');
    const changed = tx.update(request),
      selected = tx.query(query),
      counted = tx.count('item', filter);
    request.table = 'owner';
    request.key.id = 2;
    request.values.name = 'Mutated';
    request.expected.name = 'Hidden';
    query.table = 'owner';
    query.columns![0] = 'tenant';
    query.filter!.groups[0][0].value = 2;
    filter.groups[0][0].value = 'Mutated';
    assert.equal((await changed).affected, 1);
    assert.deepEqual((await selected).rows, [{ name: 'Captured' }]);
    assert.equal(await counted, 1);
    const insertion = { table: 'item', values: { id: 4, name: 'Captured insert', owner_id: 1 } };
    const inserted = tx.insert(insertion);
    insertion.values.id = 5;
    insertion.values.name = 'Mutated';
    insertion.values.owner_id = 2;
    assert.deepEqual((await inserted).key, { id: 4 });
    const removal = { table: 'item', key: { id: 4 } };
    const removed = tx.remove(removal);
    removal.key.id = 2;
    assert.equal((await removed).affected, 1);
    await journal.commit(receipt, audit);
  });
  assert.equal(name(db), 'Captured');
  assert.equal(count(db, 'item'), 3);
});

test('scoped command snapshots queued receipt, audit and lookup scope', async (t) => {
  const { adapter, db } = fixture(t);
  await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
    const stored = { ...receipt },
      intent = { ...audit },
      lookup = { ...receipt };
    const changed = tx.update(update);
    const committed = journal.commit(stored, intent);
    const found = journal.find(lookup);
    stored.id = 'mutated';
    stored.actorId = 'other';
    stored.resultJson = 'null';
    intent.target = 'owner';
    intent.keyJson = '{"id":2}';
    intent.changesJson = '[]';
    lookup.actorId = 'other';
    lookup.idempotencyKey = 'other';
    await changed;
    await committed;
    assert.deepEqual(await found, receipt);
  });
  assert.deepEqual(
    { ...db.prepare(`SELECT * FROM ${sqliteAuditRows} a`).get() },
    {
      receipt_id: receipt.id,
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
      ordinal: 0,
    },
  );
});

for (const abort of [false, true]) {
  test(`scoped record and journal handles expire after ${abort ? 'rollback' : 'commit'}`, async (t) => {
    const { adapter, db } = fixture(t);
    let records!: WriteTransaction, journal!: CommandJournal;
    const result = commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, store) => {
      records = tx;
      journal = store;
      if (abort) throw new Error('stop');
    });
    if (abort) await assert.rejects(result, failed('not_applied'));
    else await result;
    for (const operation of [
      () => records.query(page()),
      () => records.count('item'),
      () => records.update(update),
      () => records.insert({ table: 'item', values: { id: 4, name: 'Expired' } }),
      () => records.remove({ table: 'item', key: { id: 1 } }),
      () => journal.find(receipt),
      () => journal.commit(receipt, audit),
    ])
      await assert.rejects(operation(), /no longer active/);
    unchanged(db);
  });
}

test('scoped command evidence is current, deeply immutable and excludes runtime journal metadata', async (t) => {
  const { adapter } = fixture(t);
  const cached = await adapter.introspect();
  const entered = gate(),
    release = gate();
  const blocker = adapter.transaction(async () => {
    entered.release();
    await release.promise;
    (Reflect.get(adapter, 'writeDb') as DatabaseSync).exec('ALTER TABLE item ADD COLUMN added TEXT');
  });
  await entered.promise;
  let evidence!: DatabaseSchema;
  const pending = commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal, catalog) => {
    evidence = catalog;
    assert.notEqual(catalog, cached);
    assert.deepEqual(catalog.tables.map((table) => table.id).sort(), ['item', 'owner', 'unique_item']);
    assert.equal(
      catalog.tables.some((table) => isCommandJournalTable(table.id)),
      false,
    );
    assert.equal(catalog.foreignKeys.length, 1);
    const edge = catalog.foreignKeys[0];
    assert.equal(edge.from.table, 'item');
    assert.equal(edge.to.table, 'owner');
    assert.equal(Reflect.set(edge.to, 'table', tables.receipt), false);
    assert.equal(Reflect.set(edge.from.columns, 0, 'forged'), false);
    const item = catalog.tables.find((table) => table.id === 'item')!;
    assert.ok(item.columns.some((column) => column.name === 'added'));
    const parent = item.columns.find((column) => column.name === 'owner_id')!;
    assert.equal(Reflect.set(parent.references!, 'table', tables.receipt), false);
    assert.equal(Reflect.set(item.columns[0], 'name', 'forged'), false);
    assert.equal(Reflect.set(catalog, 'tables', []), false);
    assert.ok(Object.isFrozen(catalog.tables) && Object.isFrozen(catalog.foreignKeys));
    await tx.update({ ...update, values: { added: 'Fresh' } });
    assert.deepEqual((await tx.query(page('item', { columns: ['added'], filter: eq('id', 1) }))).rows, [{ added: 'Fresh' }]);
    await journal.commit(receipt, audit);
  });
  release.release();
  await Promise.all([blocker, pending]);
  assert.equal(
    cached.tables.find((table) => table.id === 'item')!.columns.some((column) => column.name === 'added'),
    false,
  );
  assert.equal(evidence.foreignKeys[0].to.table, 'owner');
});

const reservedOperations: [string, (tx: WriteTransaction, table: string) => Promise<unknown>][] = [
  ['query', (tx, table) => tx.query(page(table))],
  ['count', (tx, table) => tx.count(table)],
  ['insert', (tx, table) => tx.insert({ table, values: { id: 'forged' } })],
  ['update', (tx, table) => tx.update({ table, key: { id: receipt.id }, values: { result_json: 'null' } })],
  ['remove', (tx, table) => tx.remove({ table, key: { id: receipt.id } })],
];
for (const [method, operation] of reservedOperations) {
  test(`scoped records ${method} refuses runtime journal names and poisons the transaction`, async (t) => {
    const { adapter, db } = fixture(t);
    for (const table of [...Object.values(tables), tables.receipt.toUpperCase(), '__mistri_command_future']) {
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
          await tx.update(update);
          await journal.commit(receipt, audit);
          await assert.rejects(operation(tx, table), Refusal);
        }),
        failed('not_applied'),
      );
      unchanged(db);
    }
  });
}

test('explicit true or false private policy keys refuse the whole scoped command capability', async (t) => {
  const { adapter, db } = fixture(t);
  for (const table of [...Object.values(tables), tables.receipt.toUpperCase(), '__mistri_command_future']) {
    for (const value of [true, false]) {
      let called = false;
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction({ ...scopeA(), [table]: value }, async () => {
          called = true;
        }),
        Refusal,
      );
      assert.equal(called, false);
      unchanged(db);
    }
  }
});

for (const enrolled of [false, true]) {
  test(`application FK into journal refuses capability with child ${enrolled ? 'enrolled' : 'omitted'} in scope`, async (t) => {
    const { adapter, db } = fixture(t);
    db.exec(`CREATE TABLE journal_link (id INTEGER PRIMARY KEY, receipt_id TEXT REFERENCES "${tables.receipt}"(id))`);
    let called = false;
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction({ ...scopeA(), ...(enrolled ? { journal_link: true } : {}) }, async () => {
        called = true;
      }),
      (error) => {
        failed('not_applied')(error);
        assert.ok((error as CommandTransactionFailure).cause instanceof Refusal);
        return true;
      },
    );
    assert.equal(called, false, 'an incident FK must refuse rather than disappear from evidence');
    assert.equal(db.prepare('PRAGMA foreign_key_list(journal_link)').get()?.table, tables.receipt);
    unchanged(db);
  });
}

for (const table of Object.values(tables)) {
  test(`TEMP shadow of ${table} refuses scoped capability before callback`, async (t) => {
    const { adapter, db } = fixture(t);
    const handle = await writer(adapter);
    handle.exec(`CREATE TEMP TABLE "${table}" AS SELECT * FROM main."${table}"`);
    let called = false;
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction(scopeA(), async () => {
        called = true;
      }),
      failed('not_applied'),
    );
    assert.equal(called, false);
    unchanged(db);
  });
}

test('confirmed rollback preserves the original failure as CommandTransactionFailure not_applied', async (t) => {
  const { adapter, db } = fixture(t);
  const cause = new Error('business refusal');
  await assert.rejects(
    commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
      await tx.update(update);
      await journal.commit(receipt, audit);
      throw cause;
    }),
    failed('not_applied', cause),
  );
  unchanged(db);
});

test('caught receipt insert failure rolls back earlier scoped records', async (t) => {
  const { adapter, db } = fixture(t);
  const handle = await writer(adapter);
  const prepare = handle.prepare.bind(handle);
  const cause = new Error('receipt storage failure');
  handle.prepare = (sql) => {
    if (sql.startsWith(`INSERT INTO main."${tables.receipt}"`)) throw cause;
    return prepare(sql);
  };
  try {
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
        await tx.update(update);
        await assert.rejects(journal.commit(receipt, audit), (error) => error === cause);
      }),
      failed('not_applied', cause),
    );
  } finally {
    handle.prepare = prepare;
  }
  unchanged(db);
});

for (const acknowledgement of ['COMMIT', 'ROLLBACK']) {
  test(`scoped command lost ${acknowledgement} acknowledgement reports unknown and retires writer`, async (t) => {
    const { adapter, db } = fixture(t);
    const cause = new Error('acknowledgement lost');
    let abandoned!: DatabaseSync;
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
        await tx.update(update);
        await journal.commit(receipt, audit);
        abandoned = Reflect.get(adapter, 'writeDb') as DatabaseSync;
        const exec = abandoned.exec.bind(abandoned);
        abandoned.exec = (sql) => {
          exec(sql);
          if (sql === acknowledgement) throw cause;
        };
        if (acknowledgement === 'ROLLBACK') throw cause;
      }),
      failed('unknown', cause),
    );
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    assert.throws(() => abandoned.prepare('SELECT 1'));
    assert.equal(name(db), acknowledgement === 'COMMIT' ? 'Updated' : 'Original');
    assert.equal(count(db, tables.receipt), acknowledgement === 'COMMIT' ? 1 : 0);
    assert.equal(count(db, sqliteAuditRows), acknowledgement === 'COMMIT' ? 1 : 0);
    await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (_tx, journal) => {
      assert.notEqual(Reflect.get(adapter, 'writeDb'), abandoned);
      assert.deepEqual(await journal.find(receipt), acknowledgement === 'COMMIT' ? receipt : undefined);
    });
  });
}

test('failed rollback discards uncommitted scoped records and journal before accepting a fresh writer', async (t) => {
  const { adapter, db } = fixture(t);
  const cause = new Error('business refusal');
  await assert.rejects(
    commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
      await tx.update(update);
      await journal.commit(receipt, audit);
      const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = handle.exec.bind(handle);
      handle.exec = (sql) => {
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        exec(sql);
      };
      throw cause;
    }),
    failed('unknown', cause),
  );
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
  unchanged(db);
  await commandsOf(adapter).scopeCommandTransaction(scopeA(), async (tx, journal) => {
    await tx.update(update);
    await journal.commit(receipt, audit);
  });
  assert.equal(name(db), 'Updated');
  assert.equal(count(db, tables.receipt), 1);
  assert.equal(count(db, sqliteAuditRows), 1);
});
