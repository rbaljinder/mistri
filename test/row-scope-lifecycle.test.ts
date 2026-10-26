import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scope-lifecycle-'));
  const file = join(directory, 'scope.db');
  const setup = new DatabaseSync(file);
  setup.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT);');
  setup.close();
  const adapter = new SqliteAdapter(file);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await adapter.close();
    }
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, close, file };
}

test('scoped SQLite exposes detached frozen catalog evidence without enlarging record capabilities', async (t) => {
  const { adapter } = fixture(t);
  const cached = await adapter.introspect();
  let evidence!: DatabaseSchema;
  await adapter.scopeTransaction({ item: true }, async function (tx, catalog) {
    assert.equal(arguments.length, 2);
    assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    evidence = catalog;
    const table = catalog.tables.find((table) => table.id === 'item')!;
    assert.notEqual(catalog, cached);
    assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.tables) && Object.isFrozen(table.columns));
    assert.equal(Reflect.set(table.columns[0], 'name', 'forged'), false);
    assert.equal(Reflect.set(catalog, 'tables', []), false);
    await tx.insert({ table: 'item', values: { id: 1, name: 'Intact' } });
    assert.equal(await tx.count('item'), 1);
  });
  assert.equal(evidence.tables.find((table) => table.id === 'item')!.columns[0].name, 'id');
  assert.equal(cached.tables.find((table) => table.id === 'item')!.columns[0].name, 'id');
});

test('scoped catalog evidence observes queued writer DDL instead of cached introspection', async (t) => {
  const { adapter } = fixture(t);
  const cached = await adapter.introspect();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const earlier = adapter.transaction(async () => {
    entered();
    await held;
    // Test-only privileged DDL on the earlier transaction's actual writer.
    (Reflect.get(adapter, 'writeDb') as DatabaseSync).exec('ALTER TABLE item ADD COLUMN added TEXT');
  });
  await started;
  const later = adapter.scopeTransaction({ item: true }, async (tx, evidence) => {
    assert.deepEqual(
      evidence.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name),
      ['id', 'name', 'added'],
    );
    await tx.insert({ table: 'item', values: { id: 1, added: 'Fresh' } });
    assert.equal((await tx.query({ table: 'item', columns: ['added'], limit: 1, offset: 0 })).rows[0].added, 'Fresh');
  });
  release();
  await Promise.all([earlier, later]);
  assert.deepEqual(
    cached.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name),
    ['id', 'name'],
  );
});

test('scoped SQLite rollback failure retires the writer before the next transaction', async (t) => {
  const { adapter } = fixture(t);
  let abandoned!: DatabaseSync;
  await assert.rejects(
    adapter.scopeTransaction({ item: true }, async (tx) => {
      await tx.insert({ table: 'item', values: { id: 1, name: 'Discard' } });
      abandoned = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = abandoned.exec.bind(abandoned);
      abandoned.exec = (sql) => {
        if (sql === 'ROLLBACK') throw new Error('Lost rollback');
        exec(sql);
      };
      throw new Error('Handler failed');
    }),
    (error) => error instanceof TransactionOutcomeUnknown && (error.cause as Error).message === 'Handler failed',
  );
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
  assert.throws(() => abandoned.prepare('SELECT 1'));
  assert.equal(await adapter.count('item'), 0);
  await adapter.scopeTransaction({ item: true }, async (tx) => {
    assert.notEqual(Reflect.get(adapter, 'writeDb'), abandoned);
    await tx.insert({ table: 'item', values: { id: 2, name: 'Fresh' } });
  });
  assert.equal(await adapter.count('item'), 1);
});

test('scoped SQLite lost commit acknowledgement does not reuse an uncertain writer', async (t) => {
  const { adapter } = fixture(t);
  await assert.rejects(
    adapter.scopeTransaction({ item: true }, async (tx) => {
      await tx.insert({ table: 'item', values: { id: 1, name: 'Committed' } });
      const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = handle.exec.bind(handle);
      handle.exec = (sql) => {
        exec(sql);
        if (sql === 'COMMIT') throw new Error('Lost commit');
      };
    }),
    (error) => error instanceof TransactionOutcomeUnknown && (error.cause as Error).message === 'Lost commit',
  );
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
  assert.equal(await adapter.count('item'), 1, 'a rejection is not a not-applied receipt');
  await adapter.scopeTransaction({ item: true }, async (tx) => assert.equal(await tx.count('item'), 1));
});

test('scoped SQLite calls queued across close cannot reopen a writer', async (t) => {
  const { adapter, close } = fixture(t);
  const pending = adapter.scopeTransaction({ item: true }, async () => assert.fail('closed adapter entered callback'));
  await close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(
    adapter.scopeTransaction({ item: true }, async () => {}),
    /closed/,
  );
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
});

for (const operation of ['update', 'remove'] as const) {
  test(`scoped SQLite ${operation} cannot reacquire a writer after close during preflight`, async (t) => {
    const { adapter, close, file } = fixture(t);
    await adapter.insert({ table: 'item', values: { id: 1, name: 'Original' } });
    /* The adapter closes as the write is about to run: inside a transaction
       the write is its own row check (its count, not a count before it), so
       this is the last await before the statement. */
    const method = operation === 'update' ? 'updateNow' : 'removeNow';
    const write = Reflect.get(adapter, method).bind(adapter) as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(adapter, method, async (...args: unknown[]) => {
      await close();
      return write(...args);
    });
    await assert.rejects(
      adapter.scopeTransaction({ item: true }, async (tx) => {
        await tx.insert({ table: 'item', values: { id: 2, name: 'Roll back' } });
        if (operation === 'update') await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Escaped' } });
        else await tx.remove({ table: 'item', key: { id: 1 } });
      }),
    );
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    const inspect = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(
        inspect
          .prepare('SELECT id, name FROM item ORDER BY id')
          .all()
          .map((row) => ({ ...row })),
        [{ id: 1, name: 'Original' }],
      );
    } finally {
      inspect.close();
    }
  });
}
