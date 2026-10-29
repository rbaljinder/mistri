import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type DeleteRequest, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { AppAccessDenied, authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { runScopedTransactionFacade } from '../packages/mistri/src/server/policy/scopedTransactionFacade.js';

async function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-lock-'));
  const file = join(directory, 'records.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE physical_item (tenant TEXT NOT NULL, id INTEGER NOT NULL, name TEXT COLLATE NOCASE, secret TEXT,
    PRIMARY KEY (tenant, id));
    INSERT INTO physical_item VALUES ('desk', 1, 'STORED', 'hidden');
    CREATE TABLE unkeyed (name TEXT);
    CREATE VIEW item_view AS SELECT * FROM physical_item;`);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, db, schema: await adapter.introspect() };
}

const key = { tenant: 'desk', id: 1 };
const request = { table: 'physical_item', key };
const malformed: unknown[] = [
  null,
  {},
  [],
  { id: 1 },
  { ...key, extra: 1 },
  { tenant: null, id: 1 },
  { tenant: 'desk', id: NaN },
  { tenant: 'desk', id: Infinity },
  { tenant: 'desk', id: true },
  { tenant: 'desk', id: {} },
  Object.create(key),
  Object.defineProperty({ tenant: 'desk' }, 'id', {
    enumerable: true,
    get() {
      throw new Error('getter executed');
    },
  }),
  { ...key, [Symbol('extra')]: 1 },
];

test('SQLite lock fences the writer and reads the actual stored image despite SQL collation', async (t) => {
  const { adapter, db } = await sqlite(t);
  let escaped!: WriteTransaction;
  await adapter.transaction(async (tx) => {
    escaped = tx;
    assert.equal(await tx.lockRecord!(request), undefined);
    assert.throws(() => db.prepare('UPDATE physical_item SET name = ? WHERE tenant = ? AND id = ?').run('racing', 'desk', 1), /locked/);
    const original = await tx.query({
      table: request.table,
      columns: ['name'],
      limit: 1,
      offset: 0,
      filter: {
        groups: [
          [
            { column: 'tenant', op: '=', value: 'desk' },
            { column: 'id', op: '=', value: 1 },
            { column: 'name', op: '=', value: 'stored' },
          ],
        ],
      },
    });
    assert.equal(original.rows[0].name, 'STORED');
    await tx.update({ ...request, values: { name: 'After' }, expected: { name: original.rows[0].name as string } });
    assert.equal(original.rows[0].name, 'STORED', 'caller expectation must not become the captured original');
  });
  await assert.rejects(escaped.lockRecord!(request), /no longer active/);
  assert.equal(db.prepare('SELECT name FROM physical_item').get()!.name, 'After');
});

test('SQLite malformed locks poison the transaction even when caught, and cannot reach later writes', async (t) => {
  const { adapter, db } = await sqlite(t);
  for (const badKey of malformed) {
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ ...request, values: { name: 'Temporary' } });
        await assert.rejects(tx.lockRecord!({ table: request.table, key: badKey } as DeleteRequest), Refusal);
        await assert.rejects(tx.remove(request), Refusal);
      }),
      Refusal,
    );
    assert.equal(db.prepare('SELECT name FROM physical_item').get()!.name, 'STORED');
  }
  for (const table of ['unkeyed', 'item_view', 'absent', 'physical_item; DROP TABLE physical_item']) {
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      /primary key|No table/,
    );
  }
});

test('SQLite captures lock inputs before queue waits; an absent key returns no existence signal', async (t) => {
  const { adapter } = await sqlite(t);
  await adapter.transaction(async (tx) => {
    const mutable = { table: request.table, key: { ...key } };
    const pending = tx.lockRecord!(mutable);
    mutable.table = 'absent';
    mutable.key.id = NaN;
    await pending;
    assert.equal(await tx.lockRecord!({ ...request, key: { ...key, id: 999 } }), undefined);
  });
});

type Statement = { text: string; params: unknown[]; writer: boolean };
/** Recording drivers only: no network or live fixture. */
function recording() {
  const statements: Statement[] = [];
  const state = {
    kind: 'r',
    primary: true,
    exists: true,
    matches: 1,
    stored: 'STORED',
    snapshot: undefined as string | undefined,
    readCommitted: true,
    hook: async (_text: string) => {},
  };
  let active = false;
  const execute = async (text: string, params: unknown[] = [], writer = true) => {
    assert.equal(active, false, 'overlapping SQL on the transaction writer');
    active = true;
    statements.push({ text, params, writer });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await state.hook(text);
      if (text.startsWith('BEGIN')) state.snapshot = undefined;
      if (text.includes('SELECT c.relkind')) return state.exists ? [{ kind: state.kind }] : [];
      if (text.includes('FROM pg_attribute'))
        return [
          { name: 'tenant', type: 'text', is_pk: state.primary },
          { name: 'id', type: 'integer', is_pk: state.primary },
          { name: 'name', type: 'text', is_pk: false },
        ];
      if (text.endsWith('FOR UPDATE')) return Array.from({ length: state.matches }, () => ({ ...key }));
      if (text.includes('COUNT(*)')) return [{ n: 1 }];
      if (text.startsWith('SELECT')) {
        state.snapshot ??= state.stored;
        return [{ name: state.readCommitted ? state.stored : state.snapshot }];
      }
      return [];
    } finally {
      active = false;
    }
  };
  const adapter = new PostgresAdapter('postgres://unused/shop');
  const writer = {
    query: async (text: string, params?: unknown[]) => {
      const rows = await execute(text, params);
      return { rows, fields: [{ name: 'name' }], rowCount: rows.length };
    },
  };
  Reflect.set(adapter, 'connections', {
    withWriteClient: async (run: (write: typeof writer) => Promise<unknown>) => run(writer),
    read: async () => {
      assert.fail('reader used inside transaction');
    },
    close: async () => {},
  });
  const table = 'public.item';
  return { adapter, statements, state, table };
}

for (const dialect of ['postgres'] as const) {
  test(`${dialect} locks exact attested table and whole PK with parameters on one serialized writer`, async (t) => {
    const { adapter, statements, table } = recording();
    t.after(() => adapter.close());
    let escaped!: WriteTransaction;
    const hostile = "desk' OR 1=1 --";
    await adapter.transaction(async (tx) => {
      escaped = tx;
      const mutable = { table, key: { tenant: hostile, id: 1 } };
      const pending = tx.lockRecord!(mutable);
      mutable.table = 'other.table';
      mutable.key.id = NaN;
      await Promise.all([pending, tx.count(table)]);
    });
    const locks = statements.filter((statement) => statement.text.endsWith('FOR UPDATE'));
    assert.equal(locks.length, 1);
    assert.deepEqual(locks[0].params, [hostile, 1]);
    assert.equal(locks[0].text, 'SELECT "tenant", "id" FROM "public"."item" WHERE "tenant" = $1 AND "id" = $2 FOR UPDATE');
    const inside = statements.slice(statements.findIndex((statement) => statement.text.startsWith('BEGIN')));
    assert.ok(inside.every((statement) => statement.writer));
    assert.ok(
      inside.findIndex((statement) => statement.text.endsWith('FOR UPDATE')) <
        inside.findIndex((statement) => statement.text.includes('COUNT(*)')),
    );
    assert.equal(inside.at(-1)!.text, 'COMMIT');
    const before = statements.length;
    await assert.rejects(escaped.lockRecord!({ table, key }), /no longer active/);
    assert.equal(statements.length, before);
  });

  test(`${dialect} reads current stored image after a lock wait, including after an earlier plain read`, async (t) => {
    const { adapter, state, table } = recording();
    t.after(() => adapter.close());
    await adapter.transaction(async (tx) => {
      const query = { table, columns: ['name'], limit: 1, offset: 0 };
      assert.equal((await tx.query(query)).rows[0].name, 'STORED');
      state.hook = async (text) => {
        if (text.endsWith('FOR UPDATE')) state.stored = 'stored';
      };
      await tx.lockRecord!({ table, key });
      assert.equal((await tx.query(query)).rows[0].name, 'stored');
    });
  });

  test(`${dialect} malformed locks poison caught failures and skip queued reads`, async (t) => {
    const { adapter, statements, table } = recording();
    t.after(() => adapter.close());
    for (const badKey of malformed) {
      const start = statements.length;
      await assert.rejects(
        adapter.transaction(async (tx) => {
          await assert.rejects(tx.lockRecord!({ table, key: badKey } as DeleteRequest), Refusal);
          await assert.rejects(tx.count(table), Refusal);
        }),
        Refusal,
      );
      const current = statements.slice(start);
      assert.equal(current.at(-1)!.text, 'ROLLBACK');
      assert.ok(!current.some((s) => s.text.endsWith('FOR UPDATE') || s.text.includes('COUNT(*)')));
    }
  });

  test(`${dialect} refuses views, unkeyed/unknown tables and ambiguous matches; absence has no result`, async (t) => {
    const { adapter, state, table } = recording();
    t.after(() => adapter.close());
    state.kind = 'v';
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      Refusal,
    );
    state.kind = 'r';
    state.primary = false;
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      /primary key/,
    );
    state.primary = true;
    state.exists = false;
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      /No table/,
    );
    state.exists = true;
    state.matches = 2;
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      Refusal,
    );
    state.matches = 0;
    assert.equal(await adapter.transaction((tx) => tx.lockRecord!({ table, key })), undefined);
  });

  test(`${dialect} lost lock rollback acknowledgement remains uncertain`, async (t) => {
    const { adapter, state, table } = recording();
    t.after(() => adapter.close());
    state.hook = async (text) => {
      if (text.endsWith('FOR UPDATE') || text === 'ROLLBACK') throw new Error('lost connection');
    };
    await assert.rejects(
      adapter.transaction((tx) => tx.lockRecord!({ table, key })),
      TransactionOutcomeUnknown,
    );
  });
}

test('Postgres refuses foreign tables whose remote lock semantics are not attested', async (t) => {
  const { adapter, state, table } = recording();
  t.after(() => adapter.close());
  state.kind = 'f';
  await assert.rejects(
    adapter.transaction((tx) => tx.lockRecord!({ table, key })),
    Refusal,
  );
});

test('logical/source wrappers forward only to the writable exact source; composite has no transaction', async (t) => {
  const { adapter, schema } = await sqlite(t);
  const source = { adapter, schema, resources: { item: 'physical_item' }, writable: true };
  const runtime = createAppSourceAdapter({ main: source, second: source, readonly: { ...source, writable: false } }, 'main');
  assert.equal(runtime.adapter.transaction, undefined);
  await runtime.forSource('second').transaction!(async (tx) => {
    assert.equal(await tx.lockRecord!({ table: 'second.item', key }), undefined);
    await assert.rejects(async () => tx.lockRecord!({ table: 'item', key }), /Cross-source/);
    await assert.rejects(async () => tx.lockRecord!({ table: 'physical_item', key }), Refusal);
  });
  await assert.rejects(
    runtime.forSource('readonly').transaction!(async () => {
      assert.fail('read-only callback entered');
    }),
    /read-only/,
  );
});

test('authorized locks require resource write and readable PK, expose no fields and confer no field authority', async (t) => {
  const { adapter, schema } = await sqlite(t);
  const logical = createAppResources(adapter, schema, { item: 'physical_item' });
  await logical.adapter.transaction!(async (writer) => {
    const access = {
      readable: new Set(['item']),
      writable: new Set(['item']),
      fields: new Map([['item', { read: new Set(['tenant', 'id', 'name']), write: new Set(['name']) }]]),
    };
    const tx = authorizeTransaction(logical.schema, access, writer);
    assert.equal(await tx.lockRecord!({ table: 'item', key }), undefined);
    await assert.rejects(async () => tx.query({ table: 'item', columns: ['secret'], limit: 1, offset: 0 }), AppAccessDenied);
    await assert.rejects(async () => tx.update({ table: 'item', key, values: { secret: 'leak' } }), AppAccessDenied);
    await assert.rejects(async () => tx.remove({ table: 'item', key }), AppAccessDenied);
    await assert.rejects(tx.lockRecord!({ table: 'item', key: { id: 1 } }), AppAccessDenied);
    access.writable.clear();
    await assert.rejects(tx.lockRecord!({ table: 'item', key }), AppAccessDenied);
    access.writable.add('item');
    access.fields.get('item')!.read.delete('tenant');
    await assert.rejects(tx.lockRecord!({ table: 'item', key }), AppAccessDenied);
  });
});

test('optional capability stays absent through logical/permission/scoped facades', async (t) => {
  const { adapter, schema } = await sqlite(t);
  const logical = createAppResources(adapter, schema, { item: 'physical_item' });
  await logical.adapter.scopeTransaction!({ item: true }, async (tx) => {
    assert.equal(tx.lockRecord, undefined);
    const authorized = authorizeTransaction(logical.schema, { readable: new Set(['item']), writable: new Set(['item']) }, tx);
    assert.equal(authorized.lockRecord, undefined);
    await runScopedTransactionFacade(tx, async (scoped) => {
      assert.equal(scoped.lockRecord, undefined);
    });
  });
});

test('SQLite generic inserts and restoration never inherit ON CONFLICT REPLACE or IGNORE', async (t) => {
  const { adapter, db } = await sqlite(t);
  for (const conflict of ['REPLACE', 'IGNORE']) {
    const table = `conflict_${conflict}`;
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY ON CONFLICT ${conflict}, name TEXT UNIQUE ON CONFLICT ${conflict});
      INSERT INTO ${table} VALUES (1, 'existing');`);
    await assert.rejects(adapter.insert({ table, values: { id: 1, name: 'replacement' } }), /UNIQUE constraint/);
    await assert.rejects(
      adapter.transaction(async (tx) => {
        // The requested PK is absent but another unique key conflicts. It must
        // abort, never silently remove the record with the different PK.
        await tx.lockRecord!({ table, key: { id: 2 } });
        await tx.insert({ table, values: { id: 2, name: 'existing' } });
      }),
      /UNIQUE constraint/,
    );
    assert.deepEqual(
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, name: 'existing' }],
    );
    await adapter.transaction(async (tx) => {
      await tx.lockRecord!({ table, key: { id: 2 } });
      assert.equal((await tx.insert({ table, values: { id: 2, name: 'fresh' } })).key.id, 2);
    });
  }
});

test('transaction facade forwards an existing lock with snapshots, expiry and fatal permission checks', async (t) => {
  const { adapter, schema, db } = await sqlite(t);
  let escaped!: WriteTransaction;
  await adapter.transaction((writer) =>
    runScopedTransactionFacade(writer, async (tx) => {
      escaped = tx;
      const mutable = { table: request.table, key: { ...key } };
      const pending = tx.lockRecord!(mutable);
      mutable.table = 'absent';
      mutable.key.id = NaN;
      await pending;
    }),
  );
  await assert.rejects(escaped.lockRecord!(request), /no longer active/);
  await assert.rejects(
    adapter.transaction((writer) => {
      const authorized = authorizeTransaction(schema, { readable: new Set([request.table]), writable: new Set([request.table]) }, writer);
      return runScopedTransactionFacade(authorized, async (tx) => {
        await tx.update({ ...request, values: { name: 'Temporary' } });
        await assert.rejects(tx.lockRecord!({ table: 'unkeyed', key }), AppAccessDenied);
        await assert.rejects(tx.remove(request), Refusal);
      });
    }),
    AppAccessDenied,
  );
  assert.equal(db.prepare('SELECT name FROM physical_item').get()!.name, 'STORED');
});
