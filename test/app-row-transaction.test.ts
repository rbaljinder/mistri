import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const rule = (value: number): Filter => ({ groups: [[{ column: 'tenant', op: '=', value }]] });
const query = (table: string) => ({ table, limit: 20, offset: 0 });
const scope = (prefix = '', tenant = 1): RowScope => ({ [`${prefix}items`]: rule(tenant), [`${prefix}people`]: rule(tenant) });
const change = (table: string, name = 'Changed') => ({ table, key: { id: 1 }, values: { name } });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-row-transaction-'));
  const opened: Adapter[] = [];
  t.after(async () => {
    try {
      await Promise.all(opened.map((adapter) => adapter.close()));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const sources: Record<string, AppAdapterSource> = {};
  const files: Record<string, string> = {};
  for (const source of ['operations', 'archive']) {
    const file = join(directory, `${source}.db`);
    files[source] = file;
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE physical_person (id INTEGER PRIMARY KEY, tenant INTEGER NOT NULL, name TEXT);
        CREATE TABLE physical_item (id INTEGER PRIMARY KEY, tenant INTEGER NOT NULL DEFAULT 1,
          name TEXT DEFAULT 'New', owner_id INTEGER REFERENCES physical_person(id), "a.b" TEXT DEFAULT 'archive.people');
        INSERT INTO physical_person VALUES (1, 1, 'Person one'), (2, 2, 'Person two');
        INSERT INTO physical_item (id, tenant, name, owner_id) VALUES (1, 1, 'Original', 1), (2, 2, 'Hidden', 2);
      `);
    } finally {
      db.close();
    }
    const adapter = new SqliteAdapter(file, source);
    opened.push(adapter);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: { people: 'physical_person', items: 'physical_item' },
    };
  }
  return {
    sources,
    files,
    runtime: () => createAppSourceAdapter(sources, 'operations'),
    logical: () => createAppResources(sources.operations.adapter, sources.operations.schema, sources.operations.resources),
  };
}

test('logical scoped transactions map five operations, retain columns/results and preserve ordinary reads', async (t) => {
  const { logical } = await fixture(t);
  const { adapter } = logical();
  const answer = await adapter.scopeTransaction!(scope(), async (tx) => {
    assert.deepEqual(Reflect.ownKeys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    assert.equal(Object.isFrozen(tx), true);
    const rows = await tx.query({ ...query('items'), columns: ['name', 'a.b'] });
    assert.deepEqual(rows.columns, ['name', 'a.b']);
    assert.deepEqual(rows.rows, [{ name: 'Original', 'a.b': 'archive.people' }]);
    const inserted = await tx.insert({ table: 'items', values: { id: 3, owner_id: 1 } });
    assert.deepEqual(inserted.key, { id: 3 });
    assert.deepEqual(inserted.applied, { id: 3, owner_id: 1 });
    assert.equal(inserted.row?.['a.b'], 'archive.people');
    assert.equal(await tx.count('items'), 2);
    const updated = await tx.update({ ...change('items', 'archive.people'), expected: { name: 'Original' } });
    assert.equal(updated.affected, 1);
    assert.deepEqual(updated.applied, { name: 'archive.people' });
    assert.match(updated.sql.text, /"physical_item"/);
    assert.equal((await tx.remove({ table: 'items', key: { id: 3 } })).affected, 1);
    assert.equal(await tx.count('items'), 1);
    return 'complete';
  });
  assert.equal(answer, 'complete');
  assert.equal(await adapter.count('items'), 2);
  assert.equal((await adapter.query(query('items'))).rows[0].name, 'archive.people');
});

test('only source anchors expose scoped transactions; equal physical names stay connection-local', async (t) => {
  const { runtime } = await fixture(t);
  const app = runtime();
  assert.equal(Object.hasOwn(app.adapter, 'scopeTransaction'), false);
  await Promise.all([
    app.forSource('operations').scopeTransaction!(scope(), async (tx) => {
      await tx.update(change('items', 'Primary'));
      assert.equal(await tx.count('items'), 1);
    }),
    app.forSource('archive').scopeTransaction!(scope('archive.', 2), async (tx) => {
      await tx.update({ table: 'archive.items', key: { id: 2 }, values: { name: 'Secondary' } });
      const result = await tx.query({ ...query('archive.items'), columns: ['id', 'name'] });
      assert.deepEqual(result.columns, ['id', 'name']);
      assert.deepEqual(result.rows, [{ id: 2, name: 'Secondary' }]);
    }),
  ]);
  assert.deepEqual(
    (await app.adapter.query(query('items'))).rows.map((row) => row.name),
    ['Primary', 'Hidden'],
  );
  assert.deepEqual(
    (await app.adapter.query(query('archive.items'))).rows.map((row) => row.name),
    ['Original', 'Secondary'],
  );
});

test('whole exact scopes validate before physical transactions or callbacks, including unused rules', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  let bindings = 0;
  let callbacks = 0;
  for (const source of Object.values(sources)) {
    const bind = source.adapter.scopeTransaction!.bind(source.adapter);
    source.adapter.scopeTransaction = (rows, run) => {
      bindings++;
      return bind(rows, run);
    };
  }
  const malformed: unknown[] = [
    { items: true, unknown: true },
    { physical_item: true },
    { 'operations.items': true },
    { items: true, people: { groups: [[{ column: 'missing', op: '=', value: 1 }]] } },
    { items: true, people: { groups: [] } },
    Object.create({ items: true }),
    Object.defineProperty({}, 'items', {
      enumerable: true,
      get() {
        assert.fail('getter evaluated');
      },
    }),
  ];
  for (const input of malformed) {
    await assert.rejects(
      logical().adapter.scopeTransaction!(input as RowScope, async () => {
        callbacks++;
      }),
      Refusal,
    );
  }
  const anchor = runtime().forSource('archive');
  const foreignCases: RowScope[] = [
    { 'archive.items': true, items: true },
    { 'archive.items': true, people: false },
    { 'archive.physical_item': true },
    { 'archive.items': true, 'archive.people': { groups: [] } },
  ];
  for (const input of foreignCases)
    await assert.rejects(
      anchor.scopeTransaction!(input, async () => {
        callbacks++;
      }),
      Refusal,
    );
  assert.equal(bindings, 0);
  assert.equal(callbacks, 0);
});

test('read-only and unsupported sources cannot fall back to ordinary transactions', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  let ordinary = 0;
  sources.operations.adapter.transaction = async () => {
    ordinary++;
    throw new Error('ordinary fallback');
  };
  sources.operations.adapter.scopeTransaction = undefined;
  assert.equal(logical().adapter.scopeTransaction, undefined);
  for (const malformed of [true, {}, 'scopeTransaction']) {
    Reflect.set(sources.operations.adapter, 'scopeTransaction', malformed);
    assert.equal(logical().adapter.scopeTransaction, undefined);
    assert.equal(runtime().forSource('operations').scopeTransaction, undefined);
  }
  sources.operations.adapter.scopeTransaction = undefined;
  const unsupported = runtime();
  assert.equal(unsupported.forSource('operations').scopeTransaction, undefined);
  assert.equal(unsupported.adapter.scopeTransaction, undefined);
  await unsupported.forSource('archive').scopeTransaction!(scope('archive.'), async (tx) =>
    assert.equal(await tx.count('archive.items'), 1),
  );
  sources.archive.writable = false;
  const readOnly = runtime().forSource('archive');
  assert.equal(Object.hasOwn(readOnly, 'scopeTransaction'), false);
  assert.equal(await (await readOnly.scopeReads!(scope('archive.'))).count('archive.items'), 1);
  assert.equal(ordinary, 0);
});

const operations = ['query', 'count', 'insert', 'update', 'remove'] as const;
function invoke(tx: WriteTransaction, operation: (typeof operations)[number], table: string) {
  switch (operation) {
    case 'query':
      return tx.query(query(table));
    case 'count':
      return tx.count(table);
    case 'insert':
      return tx.insert({ table, values: { id: 5, tenant: 1, owner_id: 1 } });
    case 'update':
      return tx.update(change(table));
    case 'remove':
      return tx.remove({ table, key: { id: 1 } });
  }
}

for (const mode of ['logical', 'anchored'] as const) {
  for (const operation of operations) {
    test(`${mode} caught ${operation} mapping refusal poisons earlier writes and stops queued operations`, async (t) => {
      const { runtime, logical } = await fixture(t);
      const app = runtime();
      const adapter = mode === 'logical' ? logical().adapter : app.forSource('archive');
      const prefix = mode === 'logical' ? '' : 'archive.';
      const invalid = mode === 'logical' ? 'physical_item' : 'items';
      await assert.rejects(
        adapter.scopeTransaction!(scope(prefix), async (tx) => {
          await tx.update(change(`${prefix}items`, 'Must roll back'));
          const denied = invoke(tx, operation, invalid);
          const laterRead = tx.query(query(`${prefix}items`));
          const laterWrite = tx.insert({ table: `${prefix}items`, values: { id: 4, owner_id: 1 } });
          await assert.rejects(denied, Refusal);
          await assert.rejects(laterRead, Refusal);
          await assert.rejects(laterWrite, Refusal);
          return 'caught';
        }),
        Refusal,
      );
      assert.equal(await app.adapter.count(`${prefix}items`), 2);
      assert.equal((await app.adapter.query(query(`${prefix}items`))).rows[0].name, 'Original');
      assert.equal((await app.adapter.query(query('items'))).rows[0].name, 'Original');
    });
  }
}

test('unawaited mapping refusal drains before callback completion and rolls back', async (t) => {
  const { runtime } = await fixture(t);
  const app = runtime();
  await assert.rejects(
    app.forSource('archive').scopeTransaction!(scope('archive.'), async (tx) => {
      await tx.update(change('archive.items', 'Must roll back'));
      void tx.count('items');
    }),
    Refusal,
  );
  assert.equal((await app.adapter.query(query('archive.items'))).rows[0].name, 'Original');
});

test('anchored and logical callback handles expire after success or mapping failure', async (t) => {
  const { runtime, logical } = await fixture(t);
  const app = runtime();
  for (const [adapter, prefix] of [
    [logical().adapter, ''],
    [app.forSource('archive'), 'archive.'],
  ] as const) {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const pending = adapter.scopeTransaction!(scope(prefix), async (tx) => {
        escaped = tx;
        if (fail) await tx.count('missing');
      });
      if (fail) await assert.rejects(pending, Refusal);
      else await pending;
      for (const operation of operations) await assert.rejects(invoke(escaped, operation, `${prefix}items`), Refusal);
    }
  }
});

test('complete scopes are mapped before waiting for the physical transaction', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  for (const mode of ['logical', 'anchored'] as const) {
    const source = mode === 'logical' ? sources.operations : sources.archive;
    const pause = gate();
    const bind = source.adapter.scopeTransaction!.bind(source.adapter);
    let captured!: RowScope;
    source.adapter.scopeTransaction = async (rows, run) => {
      captured = rows;
      await pause.promise;
      return bind(rows, run);
    };
    const prefix = mode === 'logical' ? '' : 'archive.';
    const input: Record<string, boolean | Filter> = { [`${prefix}items`]: rule(1), [`${prefix}people`]: rule(1) };
    const adapter = mode === 'logical' ? logical().adapter : runtime().forSource('archive');
    const pending = adapter.scopeTransaction!(input, async (tx) => {
      assert.deepEqual(
        (await tx.query(query(`${prefix}items`))).rows.map((row) => row.id),
        [1],
      );
    });
    assert.deepEqual(Object.keys(captured), ['physical_item', 'physical_person']);
    assert.equal(Object.isFrozen(captured), true);
    (input[`${prefix}items`] as Filter).groups[0][0].value = 2;
    input[`${prefix}people`] = false;
    pause.release();
    await pending;
    source.adapter.scopeTransaction = bind;
  }
});

test('queued facade requests snapshot nested values, filters and resource identities', async (t) => {
  const { sources, runtime } = await fixture(t);
  const entered = gate();
  const pause = gate();
  const physical = sources.archive.adapter;
  const bind = physical.scopeTransaction!.bind(physical);
  physical.scopeTransaction = (rows, run) =>
    bind(rows, (records, evidence) =>
      run(
        {
          ...records,
          query: async (request) => {
            entered.release();
            await pause.promise;
            return records.query(request);
          },
        },
        evidence,
      ),
    );
  const app = runtime();
  await app.forSource('archive').scopeTransaction!(scope('archive.'), async (tx) => {
    const first = tx.query(query('archive.items'));
    await entered.promise;
    const update = { ...change('archive.items', 'Captured'), expected: { name: 'Original' } };
    const request = { ...query('archive.items'), filter: { groups: [[{ column: 'id', op: '=' as const, value: 1 }]] } };
    const pendingUpdate = tx.update(update);
    const pendingRead = tx.query(request);
    update.table = 'items';
    update.values.name = 'Mutated';
    update.expected.name = 'Mutated';
    request.table = 'items';
    request.filter.groups[0][0].value = 2;
    pause.release();
    await first;
    await pendingUpdate;
    assert.deepEqual(
      (await pendingRead).rows.map((row) => row.name),
      ['Captured'],
    );
  });
  assert.equal((await app.adapter.query(query('archive.items'))).rows[0].name, 'Captured');
});

test('malformed request capture caught by handler still poisons earlier mapped writes', async (t) => {
  const { runtime } = await fixture(t);
  const app = runtime();
  const malformed = Object.defineProperty(change('archive.items'), 'values', {
    enumerable: true,
    get() {
      assert.fail('getter evaluated');
    },
  });
  await assert.rejects(
    app.forSource('archive').scopeTransaction!(scope('archive.'), async (tx) => {
      await tx.update(change('archive.items', 'Must roll back'));
      await assert.rejects(tx.update(malformed), Refusal);
    }),
    Refusal,
  );
  assert.equal((await app.adapter.query(query('archive.items'))).rows[0].name, 'Original');
});

test('omitted rules remain denied through both scope-transaction mappings', async (t) => {
  const { runtime, logical } = await fixture(t);
  for (const [adapter, prefix] of [
    [logical().adapter, ''],
    [runtime().forSource('archive'), 'archive.'],
  ] as const) {
    await adapter.scopeTransaction!({}, async (tx) => assert.equal(await tx.count(`${prefix}items`), 0));
    await assert.rejects(
      adapter.scopeTransaction!({}, async (tx) => tx.update(change(`${prefix}items`))),
      Refusal,
    );
    await assert.rejects(
      adapter.scopeTransaction!({ [`${prefix}items`]: rule(1) }, async (tx) =>
        tx.insert({ table: `${prefix}items`, values: { id: 3, owner_id: 1 } }),
      ),
      Refusal,
    );
  }
});

function assertFrozenEvidence(evidence: DatabaseSchema, prefix: string) {
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.tables), true);
  assert.equal(Object.isFrozen(evidence.foreignKeys), true);
  assert.deepEqual(evidence.tables.map((table) => table.id).sort(), [`${prefix}items`, `${prefix}people`]);
  for (const table of evidence.tables) {
    assert.equal(table.name, table.id);
    assert.equal(table.schema, '');
    assert.equal(Object.isFrozen(table), true);
    assert.equal(Object.isFrozen(table.columns), true);
    for (const column of table.columns) {
      assert.equal(Object.isFrozen(column), true);
      if (column.references) {
        assert.equal(Object.isFrozen(column.references), true);
        assert.deepEqual(column.references, { table: `${prefix}people`, column: 'id' });
      }
    }
  }
  assert.equal(evidence.foreignKeys.length, 1);
  const fk = evidence.foreignKeys[0];
  assert.equal(Object.isFrozen(fk), true);
  assert.equal(Object.isFrozen(fk.from), true);
  assert.equal(Object.isFrozen(fk.from.columns), true);
  assert.equal(Object.isFrozen(fk.to), true);
  assert.equal(Object.isFrozen(fk.to.columns), true);
  assert.deepEqual(fk.from, { table: `${prefix}items`, columns: ['owner_id'] });
  assert.deepEqual(fk.to, { table: `${prefix}people`, columns: ['id'] });
}

for (const mode of ['logical', 'default', 'secondary'] as const) {
  test(`${mode} scoped evidence is fresh, frozen and mapped with exact resource/source identities`, async (t) => {
    const { sources, files, logical, runtime } = await fixture(t);
    const app = runtime();
    const resources = logical();
    const source = mode === 'secondary' ? 'archive' : 'operations';
    const prefix = mode === 'secondary' ? 'archive.' : '';
    const adapter = mode === 'logical' ? resources.adapter : app.forSource(source);
    const db = new DatabaseSync(files[source]);
    try {
      // Neither cached catalog knows this new column or the unrelated tables.
      db.exec(`ALTER TABLE physical_item ADD COLUMN fresh_note TEXT;
        CREATE TABLE unrelated_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE unrelated_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES unrelated_parent(id))`);
    } finally {
      db.close();
    }
    const presentation = mode === 'logical' ? resources.schema : app.catalogs.get(source)!.schema;
    assert.equal(
      presentation.tables.find((table) => table.id === 'items')!.columns.some((column) => column.name === 'fresh_note'),
      false,
    );
    // The facade's private identity map is not reconstructed from this mutable
    // presentation object when fresh evidence arrives.
    presentation.tables.push({ id: 'unrelated_parent', name: 'unrelated_parent', schema: '', columns: [], isView: false });
    let previous: DatabaseSchema | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      await adapter.scopeTransaction!({ [`${prefix}items`]: true }, async (tx, evidence) => {
        assertFrozenEvidence(evidence, prefix);
        assert.notEqual(evidence, previous);
        assert.notEqual(evidence, sources[source].schema);
        const item = evidence.tables.find((table) => table.id === `${prefix}items`)!;
        assert.ok(item.columns.some((column) => column.name === 'fresh_note'));
        assert.ok(
          item.columns.some((column) => column.name === 'a.b'),
          'column identifiers are not resource aliases',
        );
        assert.equal(Reflect.set(item, 'id', 'escaped'), false);
        assert.equal(Reflect.set(item.columns[0], 'name', 'escaped'), false);
        assert.equal(Reflect.set(evidence.foreignKeys[0].to, 'table', 'escaped'), false);
        assert.equal(await tx.count(`${prefix}items`), 2);
        assert.equal(await tx.count(`${prefix}people`), 0, 'catalog evidence does not grant an omitted row scope');
        previous = evidence;
      });
    }
    assert.equal(app.adapter.scopeTransaction, undefined);
  });

  for (const direction of ['incoming', 'outgoing'] as const) {
    test(`${mode} evidence refuses an unknown ${direction} endpoint incident to a mapped resource before callback`, async (t) => {
      const { files, logical, runtime } = await fixture(t);
      const source = mode === 'secondary' ? 'archive' : 'operations';
      const prefix = mode === 'secondary' ? 'archive.' : '';
      const adapter = mode === 'logical' ? logical().adapter : runtime().forSource(source);
      const db = new DatabaseSync(files[source]);
      try {
        db.exec(
          direction === 'incoming'
            ? 'CREATE TABLE unknown_child (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES physical_item(id))'
            : `CREATE TABLE unknown_parent (id INTEGER PRIMARY KEY);
            ALTER TABLE physical_item ADD COLUMN external_id INTEGER REFERENCES unknown_parent(id)`,
        );
        let called = false;
        await assert.rejects(
          adapter.scopeTransaction!(scope(prefix), async (tx) => {
            called = true;
            await tx.update(change(`${prefix}items`, 'Must not run'));
          }),
          Refusal,
        );
        assert.equal(called, false);
        assert.equal(db.prepare('SELECT name FROM physical_item WHERE id = 1').get()?.name, 'Original');
      } finally {
        db.close();
      }
    });
  }

  test(`${mode} missing or malformed physical catalog evidence fails closed without callback or fallback`, async (t) => {
    const { sources, logical, runtime } = await fixture(t);
    const source = mode === 'secondary' ? 'archive' : 'operations';
    const prefix = mode === 'secondary' ? 'archive.' : '';
    const physical = sources[source].adapter;
    const bind = physical.scopeTransaction!.bind(physical);
    let callbacks = 0;
    let ordinary = 0;
    physical.transaction = async () => {
      ordinary++;
      throw new Error('ordinary fallback');
    };
    for (const missing of [undefined, null, {}]) {
      physical.scopeTransaction = (rows, run) => bind(rows, (tx) => run(tx, missing as unknown as DatabaseSchema));
      const adapter = mode === 'logical' ? logical().adapter : runtime().forSource(source);
      await assert.rejects(
        adapter.scopeTransaction!(scope(prefix), async (tx) => {
          callbacks++;
          await tx.update(change(`${prefix}items`, 'Must not run'));
        }),
        Refusal,
      );
    }
    assert.equal(callbacks, 0);
    assert.equal(ordinary, 0);
    assert.equal((await physical.query(query('physical_item'))).rows[0].name, 'Original');
  });

  test(`${mode} mapped evidence detaches from mutable provider data before the callback awaits`, async (t) => {
    const { sources, logical, runtime } = await fixture(t);
    const source = mode === 'secondary' ? 'archive' : 'operations';
    const prefix = mode === 'secondary' ? 'archive.' : '';
    const physical = sources[source].adapter;
    const bind = physical.scopeTransaction!.bind(physical);
    physical.scopeTransaction = (rows, run) =>
      bind(rows, (tx, actual) => {
        const supplied = structuredClone(actual);
        const pending = run(tx, supplied);
        const item = supplied.tables.find((table) => table.id === 'physical_item')!;
        item.id = 'provider_mutated';
        item.columns.find((column) => column.name === 'owner_id')!.references!.table = 'provider_mutated';
        supplied.foreignKeys[0].to.columns[0] = 'provider_mutated';
        return pending;
      });
    const adapter = mode === 'logical' ? logical().adapter : runtime().forSource(source);
    await adapter.scopeTransaction!(scope(prefix), async (tx, evidence) => {
      await Promise.resolve();
      assertFrozenEvidence(evidence, prefix);
      assert.equal(await tx.count(`${prefix}items`), 1);
    });
  });
}
