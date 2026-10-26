import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  assertSqliteTenantStore,
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
} from '../packages/mistri/src/server/tenant/tenantStore.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-verified-writer-'));
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item VALUES(1, 'Before');");
  const adapter = new SqliteAdapter(path);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, adapter, path, name: () => db.prepare('SELECT name FROM item WHERE id=1').get()!.name };
}
const update = { table: 'item', key: { id: 1 }, values: { name: 'After' } };
const query = { table: 'item', limit: 20, offset: 0 };

test('verified SQLite boundary shares the writer and brackets operations and commit', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const handles = new Set<DatabaseSync>();
  await f.adapter.scopeVerifiedTransaction(
    { item: true },
    (db, catalog) => {
      calls++;
      handles.add(db);
      assert.ok(db.isTransaction);
      assert.ok(catalog.writable.has('item'));
      assert.ok(catalog.schema.tables.some((table) => table.id === 'item' && table.schema === 'main'));
    },
    async (records, catalog) => {
      assert.ok(catalog.tables.some((table) => table.id === 'item'));
      assert.equal('lockRecord' in records, false);
      await records.update(update);
      assert.equal((await records.query(query)).rows[0].name, 'After');
    },
  );
  assert.equal(calls, 6);
  assert.equal(handles.size, 1);
  assert.equal([...handles][0].isTransaction, false);
  assert.equal(f.name(), 'After');
});

for (const phase of [1, 2, 3, 4]) {
  test(`verified boundary refusal at phase ${phase} rolls back even if an operation rejection is caught`, async (t) => {
    const f = fixture(t),
      failure = new Refusal('owned boundary refusal');
    let calls = 0,
      entered = false;
    await assert.rejects(
      f.adapter.scopeVerifiedTransaction(
        { item: true },
        () => {
          if (++calls === phase) throw failure;
        },
        async (records) => {
          entered = true;
          try {
            await records.update(update);
          } catch (error) {
            assert.equal(error, failure);
          }
        },
      ),
      (error) => error === failure,
    );
    assert.equal(entered, phase !== 1);
    assert.equal(f.name(), 'Before');
    // A confirmed rollback does not poison the unrelated next transaction.
    await f.adapter.scopeVerifiedTransaction(
      { item: true },
      () => {},
      async (records) => {
        await records.update(update);
      },
    );
    assert.equal(f.name(), 'After');
  });
}

for (const result of ['resolved', 'rejected', 'boolean']) {
  test(`verified boundaries refuse ${result} non-synchronous-void returns before callback entry`, async (t) => {
    const f = fixture(t);
    let entered = false;
    const verify = (() =>
      result === 'boolean'
        ? true
        : result === 'resolved'
          ? Promise.resolve()
          : Promise.reject(new Error('private provider failure'))) as unknown as () => void;
    await assert.rejects(
      f.adapter.scopeVerifiedTransaction({ item: true }, verify, async () => {
        entered = true;
      }),
      Refusal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered, false);
    assert.equal(f.name(), 'Before');
  });
}

test('retained verified handles cannot run verification or borrow a later transaction', async (t) => {
  const f = fixture(t);
  let retained!: WriteTransaction,
    calls = 0;
  await f.adapter.scopeVerifiedTransaction(
    { item: true },
    () => {
      calls++;
    },
    async (records) => {
      retained = records;
    },
  );
  assert.equal(calls, 2);
  await assert.rejects(retained.query(query));
  await f.adapter.scopeVerifiedTransaction(
    { item: true },
    () => {},
    async (records) => {
      await assert.rejects(retained.update(update));
      assert.equal((await records.query(query)).rows[0].name, 'Before');
    },
  );
  assert.equal(calls, 2);
});

test('failed rollback after a verifier refusal remains an unknown transaction outcome', async (t) => {
  const f = fixture(t);
  const original = DatabaseSync.prototype.exec;
  let armed = false,
    calls = 0;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (armed && sql === 'ROLLBACK') throw new Error('private rollback fault');
    return original.call(this, sql);
  };
  try {
    await assert.rejects(
      f.adapter.scopeVerifiedTransaction(
        { item: true },
        () => {
          if (++calls === 3) {
            armed = true;
            throw new Refusal('private verifier refusal');
          }
        },
        async (records) => {
          await records.update(update);
        },
      ),
      TransactionOutcomeUnknown,
    );
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  assert.equal(f.name(), 'Before');
});

const owner = { appId: 'maintenance', source: { id: 'business', connection: 'maintenance-db' }, storeId: 'maintenance-store' };
const tenant = { tenantId: 'north', status: 'active' as const, expectedVersion: null };
type Maintenance = ReturnType<typeof createSqliteTenantAdministration>;
function maintenanceFixture(t: TestContext) {
  const f = fixture(t);
  provisionSqliteTenantStore(f.path, owner);
  return { ...f, tenants: () => f.db.prepare(`SELECT * FROM "${TENANT_TABLES.tenant}" ORDER BY id`).all() };
}

test('runtime maintenance composes bounded facades on one verified writer and commits only after queued work drains', async (t) => {
  const f = maintenanceFixture(t);
  let calls = 0,
    retained!: Maintenance;
  const result = await f.adapter.runtimeMaintenanceTransaction(
    (db) => {
      calls++;
      assert.ok(db.isTransaction);
      assertSqliteTenantStore(db, owner);
    },
    async (db, operations, current) => {
      retained = createSqliteTenantAdministration(db, operations, owner, current);
      // Deliberately not awaited: the shared owner must still drain both edits.
      void retained.putTenant(tenant);
      void retained.putMembership({
        tenantId: 'north',
        accountId: 'account',
        membershipId: 'membership',
        roles: ['member'],
        status: 'active',
        validUntil: 10000,
        expectedVersion: null,
      });
      return 'committed';
    },
  );
  assert.equal(result, 'committed');
  assert.equal(calls, 6);
  assert.deepEqual(
    f.tenants().map((row) => ({ ...row })),
    [{ id: 'north', status: 'active', version: '1', kind: 'tenant' }],
  );
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()?.n, 1);
  assert.equal(f.name(), 'Before');
  await assert.rejects(retained.putTenant({ ...tenant, tenantId: 'escaped' }));
  assert.equal(calls, 6);
});

for (const phase of [2, 3, 4])
  test(`maintenance verifier refusal at phase ${phase} cannot commit a caught metadata edit`, async (t) => {
    const f = maintenanceFixture(t);
    let calls = 0;
    await assert.rejects(
      f.adapter.runtimeMaintenanceTransaction(
        (db) => {
          assertSqliteTenantStore(db, owner);
          if (++calls === phase) throw new Refusal('maintenance retired');
        },
        async (db, operations, current) => {
          const admin = createSqliteTenantAdministration(db, operations, owner, current);
          try {
            await admin.putTenant(tenant);
          } catch {
            /* A caught operation still poisons the transaction. */
          }
        },
      ),
    );
    assert.deepEqual(f.tenants(), []);
    assert.equal(f.name(), 'Before');
  });

test('a rejected queued maintenance operation rolls back earlier accepted metadata and cannot escape into a later owner', async (t) => {
  const f = maintenanceFixture(t);
  let retained!: Maintenance;
  await assert.rejects(
    f.adapter.runtimeMaintenanceTransaction(
      (db) => assertSqliteTenantStore(db, owner),
      async (db, operations, current) => {
        retained = createSqliteTenantAdministration(db, operations, owner, current);
        await retained.putTenant(tenant);
        await assert.rejects(retained.putTenant({ ...tenant, tenantId: 'not canonical' }));
        await assert.rejects(retained.putTenant({ ...tenant, tenantId: 'after-failure' }));
      },
    ),
  );
  assert.deepEqual(f.tenants(), []);
  await f.adapter.runtimeMaintenanceTransaction(
    (db) => assertSqliteTenantStore(db, owner),
    async (db, operations, current) => {
      await assert.rejects(retained.putTenant(tenant));
      await createSqliteTenantAdministration(db, operations, owner, current).putTenant(tenant);
    },
  );
  assert.equal(f.tenants().length, 1);
});

test('ordinary writes and runtime maintenance share the same serial writer queue', async (t) => {
  const f = maintenanceFixture(t);
  let release!: () => void,
    entered!: () => void,
    ordinaryEntered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = f.adapter.runtimeMaintenanceTransaction(
    (db) => assertSqliteTenantStore(db, owner),
    async (db, operations, current) => {
      entered();
      await gate;
      await createSqliteTenantAdministration(db, operations, owner, current).putTenant(tenant);
    },
  );
  await ready;
  const second = f.adapter.transaction(async (records) => {
    ordinaryEntered = true;
    await records.update(update);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ordinaryEntered, false);
  assert.deepEqual(f.tenants(), []);
  release();
  await Promise.all([first, second]);
  assert.equal(ordinaryEntered, true);
  assert.equal(f.tenants().length, 1);
  assert.equal(f.name(), 'After');
});

test('maintenance commit acknowledgement loss preserves the shared unknown-outcome classification', async (t) => {
  const f = maintenanceFixture(t),
    original = DatabaseSync.prototype.exec;
  let armed = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = original.call(this, sql);
    if (armed && sql === 'COMMIT') throw new Error('private acknowledgement fault');
    return result;
  };
  try {
    await assert.rejects(
      f.adapter.runtimeMaintenanceTransaction(
        (db) => assertSqliteTenantStore(db, owner),
        async (db, operations, current) => {
          await createSqliteTenantAdministration(db, operations, owner, current).putTenant(tenant);
          armed = true;
        },
      ),
      TransactionOutcomeUnknown,
    );
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  assert.equal(f.tenants().length, 1, 'the receipt owner must recover a committed result, never infer rollback');
});

test('maintenance verifier must be synchronous and no ordinary business callback receives maintenance handles', async (t) => {
  const f = maintenanceFixture(t);
  let entered = false;
  await assert.rejects(
    f.adapter.runtimeMaintenanceTransaction(
      async () => {},
      async () => {
        entered = true;
      },
    ),
    Refusal,
  );
  assert.equal(entered, false);
  assert.deepEqual(f.tenants(), []);
  await f.adapter.transaction(async (records) => {
    assert.equal('runtimeMaintenanceTransaction' in records, false);
    assert.equal('putTenant' in records, false);
    assert.equal('exec' in records, false);
  });
});
