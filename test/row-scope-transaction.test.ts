import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  WriteConflict,
  type Adapter,
  type DeleteRequest,
  type Filter,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

const eq = (column: string, value: string | number | boolean): Filter => ({ groups: [[{ column, op: '=', value }]] });
const page = (table = 'item', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const rowsA = (): RowScope => ({ item: eq('tenant', 'a'), owner: eq('tenant', 'a') });

async function fixture(t: TestContext, extra = '') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-transaction-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  let adapter: SqliteAdapter | undefined;
  t.after(async () => {
    try {
      await adapter?.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, code TEXT UNIQUE, name TEXT);
    CREATE TABLE item (
      id INTEGER PRIMARY KEY, tenant TEXT NOT NULL DEFAULT 'a', name TEXT COLLATE NOCASE DEFAULT 'New',
      owner_id INTEGER DEFAULT 1 REFERENCES owner(id), version INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN DEFAULT 1, "a.b" TEXT DEFAULT 'local'
    );
    INSERT INTO owner VALUES (1, 'a', 'A', 'Alice'), (2, 'b', 'B', 'Bob');
    INSERT INTO item (id, tenant, name, owner_id) VALUES
      (1, 'a', 'Alpha', 1), (2, 'b', 'Beta', 2), (3, 'a', 'Hidden parent', 2);
    ${extra}
  `);
  adapter = new SqliteAdapter(file);
  return { adapter, db };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function stored(adapter: SqliteAdapter, table = 'item') {
  return (await adapter.query(page(table, { orderBy: [{ column: 'id', direction: 'asc' }] }))).rows;
}

// TEMP objects and SQL observation functions must live on the actual writer.
async function writer(adapter: SqliteAdapter): Promise<DatabaseSync> {
  await adapter.transaction(async () => {});
  const db = (adapter as unknown as { writeDb: DatabaseSync | null }).writeDb;
  assert.ok(db);
  return db;
}

test('SQLite scoped transactions expose only transaction methods and return the callback value', async (t) => {
  const { adapter } = await fixture(t);
  const capability: Adapter = adapter;
  assert.equal(typeof capability.scopeTransaction, 'function');
  const result = await adapter.scopeTransaction(rowsA(), async (tx) => {
    assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    assert.equal(await tx.count('item'), 2);
    assert.deepEqual((await tx.query(page('item', { columns: ['id'], filter: eq('id', 2) }))).rows, []);
    assert.equal(await tx.count('item', eq('id', 2)), 0);
    return { accepted: true };
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(await adapter.count('item'), 3);
});

test('SQLite scoped query/count see their own inserts, updates and deletes with the same predicates', async (t) => {
  const { adapter } = await fixture(t);
  await adapter.scopeTransaction(rowsA(), async (tx) => {
    const inserted = await tx.insert({ table: 'item', values: { id: 4, name: 'Inserted' } });
    assert.deepEqual(inserted.key, { id: 4 });
    assert.equal(inserted.row?.tenant, 'a');
    assert.equal(inserted.row?.owner_id, 1);
    assert.equal(await tx.count('item'), 3);
    assert.equal(await adapter.count('item'), 3, 'ordinary connection sees committed rows only');
    assert.equal(await adapter.count('item', eq('id', 4)), 0);
    assert.equal(
      (
        await tx.update({
          table: 'item',
          key: { id: 4 },
          values: { name: 'Updated', version: 1 },
          expected: { name: 'Inserted', version: 0 },
        })
      ).affected,
      1,
    );
    assert.deepEqual((await tx.query(page('item', { columns: ['name', 'version'], filter: eq('id', 4) }))).rows, [
      { name: 'Updated', version: 1 },
    ]);
    assert.deepEqual(
      (await tx.query(page('item', { columns: ['id'], orderBy: [{ column: 'id', direction: 'desc' }], limit: 1, offset: 1 }))).rows,
      [{ id: 3 }],
    );
    assert.equal((await tx.remove({ table: 'item', key: { id: 4 } })).affected, 1);
    assert.equal(await tx.count('item', eq('id', 4)), 0);
  });
  assert.equal(await adapter.count('item'), 3);
});

for (const rule of ['missing', 'false', 'empty in'] as const) {
  test(`SQLite scoped transactions deny ${rule} rules for reads and every write`, async (t) => {
    const { adapter } = await fixture(t);
    const scope: RowScope =
      rule === 'missing'
        ? { owner: true }
        : {
            item: rule === 'false' ? false : { groups: [[{ column: 'id', op: 'in', value: [] }]] },
            owner: true,
          };
    await adapter.scopeTransaction(scope, async (tx) => {
      assert.equal(await tx.count('item'), 0);
      const result = await tx.query(page('item', { columns: ['id', 'name'] }));
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.columns, ['id', 'name']);
    });
    const before = await stored(adapter);
    for (const operation of [
      (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4 } }),
      (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Forbidden' } }),
      (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: 1 } }),
    ])
      await assert.rejects(adapter.scopeTransaction<unknown>(scope, operation), Refusal);
    assert.deepEqual(await stored(adapter), before);
  });
}

test('SQLite hidden keys and escaping insert/update post-images refuse and roll back earlier writes', async (t) => {
  const { adapter } = await fixture(t);
  const before = await stored(adapter);
  for (const operation of [
    (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 2 }, values: { name: 'Hidden' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: 2 } }),
    (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4, tenant: 'b' } }),
    (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 1 }, values: { tenant: 'b' } }),
  ]) {
    await assert.rejects(
      adapter.scopeTransaction(rowsA(), async (tx) => {
        await tx.insert({ table: 'item', values: { id: 5 } });
        await operation(tx);
      }),
      Refusal,
    );
    assert.deepEqual(await stored(adapter), before);
  }
});

test('SQLite scoped defaults and affinity are checked on stored rows, including default-only inserts', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE defaulted (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT 'b', active BOOLEAN DEFAULT 1);
    CREATE TABLE numeric_scope (id INTEGER PRIMARY KEY, tenant INTEGER DEFAULT 7);
  `,
  );
  await assert.rejects(
    adapter.scopeTransaction({ defaulted: eq('tenant', 'a') }, (tx) => tx.insert({ table: 'defaulted', values: {} })),
    Refusal,
  );
  assert.equal(await adapter.count('defaulted'), 0);
  await adapter.scopeTransaction({ defaulted: eq('tenant', 'b'), numeric_scope: eq('tenant', 7) }, async (tx) => {
    const result = await tx.insert({ table: 'defaulted', values: {} });
    assert.equal(result.row?.tenant, 'b');
    assert.equal(result.row?.active, 1);
    const number = await tx.insert({ table: 'numeric_scope', values: { tenant: '007' } });
    assert.equal(number.row?.tenant, 7);
    assert.equal(await tx.count('numeric_scope'), 1);
  });
  await adapter.scopeTransaction({ item: eq('active', true), owner: true }, async (tx) => {
    const result = await tx.insert({ table: 'item', values: { id: 4, active: true } });
    assert.deepEqual(result.key, { id: 4 });
    assert.deepEqual((await tx.query(page('item', { columns: ['id', 'a.b'], filter: eq('id', 4) }))).rows, [{ id: 4, 'a.b': 'local' }]);
  });
});

test('SQLite scoped mutations refuse stored blob and unsafe-integer PKs while reads remain JSON-safe', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE opaque_key (id BLOB PRIMARY KEY DEFAULT X'6162', tenant TEXT DEFAULT 'a', name TEXT);
    CREATE TABLE opaque_default (id BLOB PRIMARY KEY DEFAULT X'6162', tenant TEXT DEFAULT 'a');
    INSERT INTO opaque_key (name) VALUES ('Blob');
    INSERT INTO item (id, name) VALUES (9007199254740993, 'Big');
  `,
  );
  await adapter.scopeTransaction({ ...rowsA(), opaque_key: true }, async (tx) => {
    assert.deepEqual((await tx.query(page('item', { columns: ['id'], filter: eq('id', '9007199254740993') }))).rows, [
      { id: '9007199254740993' },
    ]);
    assert.deepEqual((await tx.query(page('opaque_key', { columns: ['id'] }))).rows, [{ id: '<2 bytes>' }]);
  });
  for (const operation of [
    (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: '9007199254740994' } }),
    (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: '9007199254740993' }, values: { name: 'Forbidden' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: '9007199254740993' } }),
    (tx: WriteTransaction) => tx.insert({ table: 'opaque_key', values: { id: null } }),
    (tx: WriteTransaction) => tx.insert({ table: 'opaque_default', values: {} }),
    (tx: WriteTransaction) => tx.update({ table: 'opaque_key', key: { id: '<2 bytes>' }, values: { name: 'Forbidden' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'opaque_key', key: { id: '<2 bytes>' } }),
  ])
    await assert.rejects(adapter.scopeTransaction<unknown>({ ...rowsA(), opaque_key: true, opaque_default: true }, operation), Refusal);
  assert.equal(await adapter.count('item'), 4);
  assert.equal(await adapter.count('opaque_key'), 1);
  assert.equal(await adapter.count('opaque_default'), 0);
  assert.equal((await adapter.query(page('item', { filter: eq('id', '9007199254740993') }))).rows[0].name, 'Big');
});

test('SQLite stored blob/default and unsafe-integer outgoing FKs refuse without authorizing display labels', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE opaque_parent (id INTEGER PRIMARY KEY, code BLOB UNIQUE, tenant TEXT);
    CREATE TABLE opaque_child (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT 'a', name TEXT,
      code BLOB DEFAULT X'6162' REFERENCES opaque_parent(code));
    INSERT INTO opaque_parent VALUES (1, X'6162', 'b'), (2, '<2 bytes>', 'a'), (3, 9007199254740993, 'a');
    INSERT INTO opaque_child (id, name) VALUES (1, 'Stored blob');
    INSERT INTO opaque_child (id, name, code) VALUES (2, 'Stored big', 9007199254740993);
  `,
  );
  const scope: RowScope = { opaque_child: true, opaque_parent: eq('tenant', 'a') };
  for (const operation of [(tx: WriteTransaction) => tx.insert({ table: 'opaque_child', values: { id: 3 } })])
    await assert.rejects(adapter.scopeTransaction<unknown>(scope, operation), Refusal);
  await adapter.scopeTransaction(scope, async (tx) => {
    for (const id of [1, 2]) await tx.update({ table: 'opaque_child', key: { id }, values: { name: 'Unrelated edit' } });
  });
  assert.equal(await adapter.count('opaque_child'), 2);
  await adapter.scopeTransaction({ opaque_child: true }, async (tx) => {
    await tx.update({ table: 'opaque_child', key: { id: 1 }, values: { code: null } });
  });
});

test('SQLite inserts check default references and updates check assigned references', async (t) => {
  const { adapter } = await fixture(t);
  const before = await stored(adapter);
  for (const operation of [
    (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4, owner_id: 2 } }),
    (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4, owner_id: 999 } }),
    (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 1 }, values: { owner_id: 2 } }),
  ]) {
    await assert.rejects(adapter.scopeTransaction<unknown>(rowsA(), operation));
    assert.deepEqual(await stored(adapter), before);
  }
  for (const parentRule of [undefined, false, eq('tenant', 'b')]) {
    const scope: RowScope = { item: eq('tenant', 'a'), ...(parentRule === undefined ? {} : { owner: parentRule }) };
    await assert.rejects(
      adapter.scopeTransaction(scope, (tx) => tx.insert({ table: 'item', values: { id: 4 } })),
      Refusal,
    );
    assert.deepEqual(await stored(adapter), before);
  }
  await adapter.scopeTransaction({ item: eq('tenant', 'a') }, async (tx) => {
    await tx.insert({ table: 'item', values: { id: 4, owner_id: null } });
    await tx.update({ table: 'item', key: { id: 3 }, values: { owner_id: null, name: 'Detached' } });
  });
});

test('SQLite outgoing references may resolve to visible parents inserted earlier in the same transaction', async (t) => {
  const { adapter } = await fixture(t);
  await adapter.scopeTransaction(rowsA(), async (tx) => {
    await tx.insert({ table: 'owner', values: { id: 4, tenant: 'a', code: 'D' } });
    await tx.insert({ table: 'item', values: { id: 4, owner_id: 4 } });
    await tx.update({ table: 'item', key: { id: 1 }, values: { owner_id: 4 } });
    assert.equal(await tx.count('item', eq('owner_id', 4)), 2);
  });
});

test('SQLite composite implicit parent keys use PK ordinal order and any null component skips visibility', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE pair_parent (left_key TEXT, right_key INTEGER, tenant TEXT, PRIMARY KEY (right_key, left_key)) WITHOUT ROWID;
    CREATE TABLE pair_child (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT 'a', p_right INTEGER, p_left TEXT,
      FOREIGN KEY (p_right, p_left) REFERENCES pair_parent);
    INSERT INTO pair_parent VALUES ('visible', 7, 'a'), ('hidden', 8, 'b');
  `,
  );
  const scope: RowScope = { pair_parent: eq('tenant', 'a'), pair_child: eq('tenant', 'a') };
  await adapter.scopeTransaction(scope, async (tx) => {
    await tx.insert({ table: 'pair_child', values: { id: 1, p_right: 7, p_left: 'visible' } });
    assert.equal(await tx.count('pair_child'), 1);
  });
  await assert.rejects(
    adapter.scopeTransaction(scope, (tx) => tx.insert({ table: 'pair_child', values: { id: 2, p_right: 8, p_left: 'hidden' } })),
    Refusal,
  );
  await adapter.scopeTransaction({ pair_child: true }, async (tx) => {
    for (const [id, p_right, p_left] of [
      [2, null, 'hidden'],
      [3, 8, null],
      [4, null, null],
    ] as const) {
      await tx.insert({ table: 'pair_child', values: { id, p_right, p_left } });
    }
    await tx.update({ table: 'pair_child', key: { id: 1 }, values: { p_left: null } });
    assert.equal(await tx.count('pair_child'), 4);
  });
});

test('SQLite checks all outgoing FKs and applies parent affinity/collation when finding a visible parent', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE code_parent (id INTEGER PRIMARY KEY, code TEXT COLLATE NOCASE UNIQUE, tenant TEXT);
    CREATE TABLE multi_child (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT 'a',
      code TEXT DEFAULT 'visible' REFERENCES code_parent(code), owner_id INTEGER DEFAULT 2 REFERENCES owner);
    INSERT INTO code_parent VALUES (1, 'VISIBLE', 'a');
  `,
  );
  const scope: RowScope = { multi_child: true, code_parent: eq('tenant', 'a'), owner: eq('tenant', 'a') };
  await assert.rejects(
    adapter.scopeTransaction(scope, (tx) => tx.insert({ table: 'multi_child', values: { id: 1 } })),
    Refusal,
  );
  await adapter.scopeTransaction(scope, async (tx) => {
    await tx.insert({ table: 'multi_child', values: { id: 1, owner_id: '001' } });
    assert.equal(await tx.count('multi_child'), 1);
  });
});

test('SQLite malformed nonunique parent references refuse even with several visible matching parents', async (t) => {
  const { adapter, db } = await fixture(
    t,
    `
    CREATE TABLE ambiguous_parent (id INTEGER PRIMARY KEY, code TEXT, tenant TEXT);
    INSERT INTO ambiguous_parent VALUES (1, 'same', 'a'), (2, 'same', 'a');
    CREATE TABLE ambiguous_child (id INTEGER PRIMARY KEY, code TEXT REFERENCES ambiguous_parent(code));
  `,
  );
  await assert.rejects(
    adapter.scopeTransaction({ ambiguous_parent: true, ambiguous_child: true }, (tx) =>
      tx.insert({ table: 'ambiguous_child', values: { id: 1, code: 'same' } }),
    ),
  );
  assert.equal((db.prepare('SELECT count(*) AS n FROM ambiguous_child').get() as { n: number }).n, 0);
});

test('SQLite composite keys require every PK column and reject extra, null and absent keys', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE composite (id INTEGER, part TEXT, tenant TEXT, name TEXT, PRIMARY KEY (id, part)) WITHOUT ROWID;
    INSERT INTO composite VALUES (1, 'x', 'a', 'X'), (1, 'y', 'a', 'Y');
    CREATE TABLE keyless (id INTEGER, tenant TEXT, name TEXT);
    INSERT INTO keyless VALUES (1, 'a', 'Original');
  `,
  );
  for (const key of [{ id: 1 }, { id: 1, part: 'x', tenant: 'a' }, {}, { id: 1, part: null }, { id: 99, part: 'x' }]) {
    for (const remove of [false, true]) {
      await assert.rejects(
        adapter.scopeTransaction({ composite: true }, (tx) =>
          remove
            ? tx.remove({ table: 'composite', key: key as DeleteRequest['key'] })
            : tx.update({ table: 'composite', key: key as UpdateRequest['key'], values: { name: 'Forbidden' } }),
        ),
        Refusal,
      );
    }
  }
  for (const operation of [
    (tx: WriteTransaction) => tx.insert({ table: 'keyless', values: { id: 2, tenant: 'a' } }),
    (tx: WriteTransaction) => tx.update({ table: 'keyless', key: { id: 1 }, values: { name: 'Forbidden' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'keyless', key: { id: 1 } }),
  ])
    await assert.rejects(adapter.scopeTransaction<unknown>({ keyless: true }, operation), Refusal);
  await adapter.scopeTransaction({ composite: eq('tenant', 'a') }, async (tx) => {
    await tx.update({ table: 'composite', key: { id: 1, part: 'x' }, values: { name: 'Changed' } });
    await tx.remove({ table: 'composite', key: { id: 1, part: 'y' } });
    assert.equal(await tx.count('composite'), 1);
  });
});

test('SQLite updates refuse PK and incoming referenced columns even when assigning the existing value', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE TABLE code_child (id INTEGER PRIMARY KEY, owner_code TEXT REFERENCES owner(code) ON UPDATE CASCADE);
  `,
  );
  const before = await stored(adapter, 'owner');
  const protectedUpdates: UpdateRequest['values'][] = [{ id: 1 }, { code: 'A' }, { code: 'Repointed' }];
  for (const values of protectedUpdates) {
    await assert.rejects(
      adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: 'owner', key: { id: 1 }, values })),
      Refusal,
    );
  }
  assert.deepEqual(await stored(adapter, 'owner'), before);
  await adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: 'owner', key: { id: 1 }, values: { name: 'Allowed' } }));
});

for (const action of ['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']) {
  test(`SQLite deletes refuse incoming ${action} FKs even with no referencing rows`, async (t) => {
    const { adapter, db } = await fixture(
      t,
      `
      CREATE TABLE delete_parent (id INTEGER PRIMARY KEY, tenant TEXT);
      CREATE TABLE delete_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES delete_parent(id) ON DELETE ${action});
      INSERT INTO delete_parent VALUES (1, 'a'), (2, 'a');
      INSERT INTO delete_child VALUES (1, 1);
    `,
    );
    for (const id of [1, 2])
      await assert.rejects(
        adapter.scopeTransaction({ delete_parent: true }, (tx) => tx.remove({ table: 'delete_parent', key: { id } })),
        Refusal,
      );
    assert.equal(await adapter.count('delete_parent'), 2);
    assert.equal((db.prepare('SELECT parent_id FROM delete_child').get() as { parent_id: number }).parent_id, 1);
  });
}

test('SQLite optimistic expected values remain atomic, exact and null-aware under row scope', async (t) => {
  const { adapter } = await fixture(t);
  await assert.rejects(
    adapter.scopeTransaction(rowsA(), (tx) =>
      tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Wrong' }, expected: { name: 'alpha' } }),
    ),
    WriteConflict,
  );
  await assert.rejects(
    adapter.scopeTransaction(rowsA(), async (tx) => {
      await tx.insert({ table: 'item', values: { id: 4 } });
      await tx.update({ table: 'item', key: { id: 1 }, values: { version: 1 }, expected: { version: 99 } });
    }),
    WriteConflict,
  );
  assert.equal(await adapter.count('item'), 3);
  await adapter.scopeTransaction(rowsA(), async (tx) => {
    await tx.update({ table: 'item', key: { id: 1 }, values: { name: null }, expected: { name: 'Alpha' } });
    await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Restored' }, expected: { name: null } });
  });
  await assert.rejects(
    adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Wrong' }, expected: {} })),
    Refusal,
  );
});

test('SQLite scope is captured before waiting for the writer queue', async (t) => {
  const { adapter } = await fixture(t);
  const entered = gate(),
    release = gate();
  const blocker = adapter.transaction(async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const rule = eq('tenant', 'a');
  const scope: Record<string, boolean | Filter> = { item: rule, owner: true };
  const pending = adapter.scopeTransaction(scope, async (tx) => {
    assert.deepEqual((await tx.query(page('item', { columns: ['id'], orderBy: [{ column: 'id', direction: 'asc' }] }))).rows, [
      { id: 1 },
      { id: 3 },
    ]);
    await tx.insert({ table: 'item', values: { id: 4, tenant: 'a' } });
  });
  rule.groups[0][0].value = 'b';
  scope.item = true;
  delete scope.owner;
  release.release();
  await Promise.all([blocker, pending]);
});

test('SQLite operation inputs snapshot nested query/count, keys, values and expected before queue awaits', async (t) => {
  const { adapter } = await fixture(t);
  await adapter.scopeTransaction(rowsA(), async (tx) => {
    const insert: InsertRequest = { table: 'item', values: { id: 4, name: 'Captured' } };
    const inserting = tx.insert(insert);
    insert.table = 'owner';
    insert.values.id = 2;
    insert.values.tenant = 'b';
    insert.values.name = 'Mutated';
    assert.equal((await inserting).row?.name, 'Captured');

    const update: UpdateRequest = { table: 'item', key: { id: 4 }, values: { name: 'Updated' }, expected: { name: 'Captured' } };
    const updating = tx.update(update);
    update.key.id = 2;
    update.values.name = 'Mutated';
    update.expected!.name = 'Wrong';
    update.table = 'owner';
    assert.equal((await updating).affected, 1);

    const filter: Filter = { groups: [[{ column: 'id', op: 'in', value: [1, 4] }]] };
    const query = page('item', { columns: ['id', 'name'], filter, orderBy: [{ column: 'id', direction: 'desc' }], limit: 1 });
    const querying = tx.query(query),
      counting = tx.count('item', filter);
    query.table = 'owner';
    query.columns![0] = 'tenant';
    query.orderBy![0].direction = 'asc';
    query.limit = 20;
    query.offset = 1;
    (filter.groups[0][0].value as number[]).splice(0, 2, 2);
    assert.deepEqual((await querying).rows, [{ id: 4, name: 'Updated' }]);
    assert.equal(await counting, 2);

    const remove: DeleteRequest = { table: 'item', key: { id: 4 } };
    const removing = tx.remove(remove);
    remove.key.id = 2;
    remove.table = 'owner';
    assert.equal((await removing).affected, 1);
  });
  assert.equal(await adapter.count('item'), 3);
  assert.equal((await stored(adapter))[1].name, 'Beta');
});

test('SQLite scoped transactions reserve BEGIN IMMEDIATE and serialize with scoped and ordinary writers', async (t) => {
  const { adapter, db } = await fixture(t);
  db.exec('PRAGMA busy_timeout = 1');
  const entered = gate(),
    release = gate();
  const events: string[] = [];
  const first = adapter.scopeTransaction(rowsA(), async (tx) => {
    assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/);
    await tx.insert({ table: 'item', values: { id: 4 } });
    events.push('first');
    entered.release();
    await release.promise;
    assert.equal(await tx.count('item', eq('id', 5)), 0);
    throw new Error('first rolls back');
  });
  const rejected = assert.rejects(first, /first rolls back/);
  await entered.promise;
  const second = adapter.scopeTransaction(rowsA(), async (tx) => {
    events.push('second');
    assert.equal(await tx.count('item', eq('id', 4)), 0);
    await tx.insert({ table: 'item', values: { id: 5 } });
  });
  const ordinary = adapter.insert({ table: 'item', values: { id: 6 } }).then(() => {
    events.push('ordinary');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  release.release();
  await Promise.all([rejected, second, ordinary]);
  assert.deepEqual(events, ['first', 'second', 'ordinary']);
  assert.deepEqual(
    (await stored(adapter)).map((row) => row.id),
    [1, 2, 3, 5, 6],
  );
});

for (const failure of ['validation', 'query', 'count', 'constraint', 'post-image'] as const) {
  test(`SQLite caught ${failure} failure poisons and fail-stops already queued reads and writes`, async (t) => {
    const { adapter } = await fixture(t);
    const write = await writer(adapter);
    let reads = 0,
      writes = 0;
    write.function('observe_read', (value) => {
      reads++;
      return value;
    });
    write.function('observe_write', () => {
      writes++;
      return 'a';
    });
    write.exec(`
      CREATE VIEW observed AS SELECT id, tenant, observe_read(name) AS name FROM item;
      CREATE TABLE observed_write (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT (observe_write()));
    `);
    let results: PromiseSettledResult<unknown>[] = [];
    let later: PromiseSettledResult<unknown>[] = [];
    await assert.rejects(
      adapter.scopeTransaction({ ...rowsA(), observed: true, observed_write: true }, async (tx) => {
        await tx.insert({ table: 'item', values: { id: 4 } });
        const failed =
          failure === 'validation'
            ? tx.update({ table: 'item', key: { id: 1 }, values: { unknown: 'Invalid' } })
            : failure === 'query'
              ? tx.query(page('item', { columns: ['unknown'] }))
              : failure === 'count'
                ? tx.count('item', eq('unknown', 1))
                : failure === 'constraint'
                  ? tx.insert({ table: 'item', values: { id: 1 } })
                  : tx.insert({ table: 'item', values: { id: 5, tenant: 'b' } });
        const queued = [
          tx.query(page('observed')),
          tx.count('item'),
          tx.insert({ table: 'observed_write', values: { id: 1 } }),
          tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Forbidden' } }),
          tx.remove({ table: 'item', key: { id: 1 } }),
        ];
        results = await Promise.allSettled([failed, ...queued]);
        later = await Promise.allSettled([tx.count('item')]);
        return 'must not commit';
      }),
    );
    // Check outside assert.rejects: a failing assertion in the callback must
    // not be mistaken for the transaction's own required refusal.
    assert.equal(results.length, 6);
    assert.ok(
      results.every((result) => result.status === 'rejected'),
      'all operations queued behind the failure must reject',
    );
    assert.equal(later[0]?.status, 'rejected', 'operations submitted after catching the error also fail');
    assert.equal(reads, 0, 'queued reads must not execute');
    assert.equal(writes, 0, 'queued writes must not execute, even if rollback could hide their effects');
    assert.equal(await adapter.count('item'), 3);
    assert.equal((await stored(adapter))[0].name, 'Alpha');
  });
}

test('SQLite capture failures poison even when caught, without invoking request accessors', async (t) => {
  const { adapter } = await fixture(t);
  let accessed = false;
  await assert.rejects(
    adapter.scopeTransaction(rowsA(), async (tx) => {
      await tx.insert({ table: 'item', values: { id: 4 } });
      const malformed = Object.defineProperty({ table: 'item' }, 'values', {
        enumerable: true,
        get() {
          accessed = true;
          return { id: 5 };
        },
      }) as InsertRequest;
      try {
        await tx.insert(malformed);
      } catch {
        /* Catching cannot authorize commit. */
      }
      await assert.rejects(tx.query(page()), Refusal);
    }),
    Refusal,
  );
  assert.equal(accessed, false);
  assert.equal(await adapter.count('item'), 3);
});

test('SQLite unawaited operation failures roll back and escaped methods expire after commit or rollback', async (t) => {
  const { adapter } = await fixture(t);
  const unhandled: unknown[] = [];
  const notice = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', notice);
  try {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const transaction = adapter.scopeTransaction(rowsA(), async (tx) => {
        escaped = tx;
        if (fail) {
          await tx.insert({ table: 'item', values: { id: 4 } });
          void tx.update({ table: 'item', key: { id: 1 }, values: { unknown: 'Invalid' } });
        }
      });
      if (fail) await assert.rejects(transaction);
      else await transaction;
      for (const late of [
        () => escaped.query(page()),
        () => escaped.count('item'),
        () => escaped.insert({ table: 'item', values: { id: 5 } }),
        () => escaped.update({ table: 'item', key: { id: 1 }, values: { name: 'Late' } }),
        () => escaped.remove({ table: 'item', key: { id: 1 } }),
      ])
        await assert.rejects(late, /no longer active/);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(await adapter.count('item'), 3);
  } finally {
    process.off('unhandledRejection', notice);
  }
});

for (const operation of ['insert', 'update'] as const) {
  test(`SQLite ${operation} OR ABORT prevents schema ON CONFLICT REPLACE from deleting a hidden row`, async (t) => {
    const { adapter } = await fixture(
      t,
      `
      CREATE TABLE replace_item (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, tenant TEXT,
        code TEXT UNIQUE ON CONFLICT REPLACE, name TEXT);
      INSERT INTO replace_item VALUES (1, 'a', 'visible', 'Alpha'), (2, 'b', 'hidden', 'Beta');
    `,
    );
    const before = await stored(adapter, 'replace_item');
    await assert.rejects(
      adapter.scopeTransaction({ replace_item: eq('tenant', 'a') }, async (tx) => {
        await tx.insert({ table: 'replace_item', values: { id: 4, tenant: 'a', code: 'earlier' } });
        if (operation === 'insert') await tx.insert({ table: 'replace_item', values: { id: 3, tenant: 'a', code: 'hidden' } });
        else await tx.update({ table: 'replace_item', key: { id: 1 }, values: { code: 'hidden' } });
      }),
    );
    assert.deepEqual(await stored(adapter, 'replace_item'), before);
    if (operation === 'insert') {
      await assert.rejects(
        adapter.scopeTransaction({ replace_item: eq('tenant', 'a') }, (tx) =>
          tx.insert({ table: 'replace_item', values: { id: 2, tenant: 'a', code: 'different' } }),
        ),
      );
      assert.deepEqual(await stored(adapter, 'replace_item'), before);
    }
  });
}

/* A generated column keeps its table writable (0.9.4, R1): the database computes it, so a write around it lands and a
   write that names it is refused. Views and a virtual table's own columns still keep theirs out of every write. */
test('SQLite scoped writes refuse views and virtual/shadow tables, and write a generated-column table around its column', async (t) => {
  const { adapter } = await fixture(
    t,
    `
    CREATE VIEW item_view AS SELECT * FROM item;
    CREATE VIRTUAL TABLE search USING fts5(body);
    CREATE TABLE generated_stored (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT,
      derived TEXT GENERATED ALWAYS AS (upper(name)) STORED);
    CREATE TABLE generated_virtual (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT,
      derived TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL);
    INSERT INTO generated_stored (id, tenant, name) VALUES (1, 'a', 'Original');
    INSERT INTO generated_virtual (id, tenant, name) VALUES (1, 'a', 'Original');
  `,
  );
  for (const table of ['item_view', 'search', 'search_data']) {
    for (const operation of [
      (tx: WriteTransaction) => tx.insert({ table, values: table === 'search' ? { body: 'Forbidden' } : { id: 4 } }),
      (tx: WriteTransaction) => tx.update({ table, key: { id: 1 }, values: { name: 'Forbidden' } }),
      (tx: WriteTransaction) => tx.remove({ table, key: { id: 1 } }),
    ])
      await assert.rejects(adapter.scopeTransaction<unknown>({ [table]: true }, operation), Refusal);
  }
  for (const table of ['generated_stored', 'generated_virtual']) {
    for (const operation of [
      (tx: WriteTransaction) => tx.insert({ table, values: { id: 4, name: 'Forbidden', derived: 'SET' } }),
      (tx: WriteTransaction) => tx.update({ table, key: { id: 1 }, values: { derived: 'SET' } }),
    ])
      await assert.rejects(adapter.scopeTransaction<unknown>({ [table]: true }, operation));
    assert.deepEqual(
      (await stored(adapter, table)).map((row) => [row.id, row.name, row.derived]),
      [[1, 'Original', 'ORIGINAL']],
    );
    await adapter.scopeTransaction<unknown>({ [table]: true }, async (tx) => {
      await tx.insert({ table, values: { id: 4, name: 'Added' } });
      await tx.update({ table, key: { id: 1 }, values: { name: 'Changed' } });
      await tx.remove({ table, key: { id: 4 } });
    });
    assert.deepEqual(
      (await stored(adapter, table)).map((row) => [row.id, row.name, row.derived]),
      [[1, 'Changed', 'CHANGED']],
    );
  }
});

for (const temporary of [false, true]) {
  test(`SQLite scoped writes refuse ${temporary ? 'TEMP' : 'main'} triggers on the target for every operation`, async (t) => {
    const { adapter } = await fixture(t);
    const write = await writer(adapter);
    write.exec(`CREATE ${temporary ? 'TEMP' : ''} TRIGGER side_effect AFTER INSERT ON main.item
      BEGIN UPDATE item SET name = 'Leaked' WHERE id = 2; END;`);
    const before = await stored(adapter);
    for (const operation of [
      (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4 } }),
      (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Forbidden' } }),
      (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: 1 } }),
    ])
      await assert.rejects(adapter.scopeTransaction<unknown>(rowsA(), operation), Refusal);
    assert.deepEqual(await stored(adapter), before);
  });
}

test('SQLite scoped writes refuse TEMP tables shadowing main targets, case-insensitively', async (t) => {
  const { adapter } = await fixture(t);
  const write = await writer(adapter);
  write.exec("CREATE TEMP TABLE ITEM (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT); INSERT INTO temp.ITEM VALUES (1, 'a', 'Temp');");
  const before = await stored(adapter);
  for (const operation of [
    (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 4 } }),
    (tx: WriteTransaction) => tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Forbidden' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: 1 } }),
  ])
    await assert.rejects(adapter.scopeTransaction<unknown>(rowsA(), operation), Refusal);
  assert.deepEqual(await stored(adapter), before);
  assert.equal((write.prepare('SELECT name FROM temp.ITEM').get() as { name: string }).name, 'Temp');
});

test('SQLite fresh metadata inside BEGIN IMMEDIATE ignores stale introspection and detects newly added incoming FKs', async (t) => {
  const { adapter, db } = await fixture(t);
  await adapter.scopeReads(rowsA());
  const stale = await adapter.introspect();
  adapter.introspect = async () => stale;
  const entered = gate(),
    release = gate();
  const blocker = adapter.transaction(async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const pending = adapter.scopeTransaction(rowsA(), (tx) => tx.remove({ table: 'item', key: { id: 1 } }));
  // Queued work starts in a microtask; install the FK synchronously at COMMIT.
  const write = (adapter as unknown as { writeDb: DatabaseSync }).writeDb;
  const originalExec = write.exec.bind(write);
  write.exec = (sql) => {
    originalExec(sql);
    if (sql.trim().toUpperCase() === 'COMMIT') {
      write.exec = originalExec;
      db.exec('CREATE TABLE newly_referencing (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES item(id) ON DELETE CASCADE)');
    }
  };
  release.release();
  await blocker;
  await assert.rejects(pending, Refusal);
  assert.equal(await adapter.count('item'), 3);
});

test('SQLite fresh metadata rejects newly added triggers and permits newly created ordinary tables', async (t) => {
  const { adapter, db } = await fixture(t);
  await adapter.scopeReads(rowsA());
  const stale = await adapter.introspect();
  adapter.introspect = async () => stale;
  db.exec(`
    CREATE TRIGGER added_later AFTER UPDATE ON item BEGIN UPDATE item SET name = 'Hidden effect' WHERE id = 2; END;
    CREATE TABLE added_table (id INTEGER PRIMARY KEY, tenant TEXT DEFAULT 'a');
  `);
  await assert.rejects(
    adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Forbidden' } })),
    Refusal,
  );
  await adapter.scopeTransaction({ added_table: eq('tenant', 'a') }, async (tx) => {
    await tx.insert({ table: 'added_table', values: {} });
    assert.equal(await tx.count('added_table'), 1);
  });
  assert.equal((await stored(adapter))[1].name, 'Beta');
});

test('SQLite invalid complete scopes refuse before invoking the transaction callback', async (t) => {
  const { adapter } = await fixture(t);
  let invoked = false,
    accessed = false;
  const getter = Object.defineProperty({}, 'item', {
    enumerable: true,
    get() {
      accessed = true;
      return true;
    },
  });
  for (const scope of [undefined, { missing: true }, { item: { groups: [] } }, { item: true, owner: eq('absent', 1) }, getter]) {
    await assert.rejects(
      adapter.scopeTransaction(scope as RowScope, async () => {
        invoked = true;
      }),
      Refusal,
    );
  }
  assert.equal(invoked, false);
  assert.equal(accessed, false);
});
