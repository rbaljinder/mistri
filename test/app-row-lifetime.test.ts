import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type ScopedReads, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { AppAccessDenied, authorizeResources, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';

const query = (table: string) => ({ table, limit: 20, offset: 0 });
const change = (table: string) => ({ table, key: { id: 1 }, values: { body: 'Changed' } });
const denied = (run: () => unknown) => assert.rejects(async () => run(), Refusal);
const modes = ['root', 'anchor'] as const;
type Mode = (typeof modes)[number];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function lifetime() {
  const state = { active: true };
  const error = new Refusal('Request lifetime ended.');
  return {
    state,
    error,
    assertActive: () => {
      if (!state.active) throw error;
    },
  };
}

async function fixture(t: TestContext, mode: Mode = 'root') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-row-lifetime-'));
  const adapters: SqliteAdapter[] = [];
  t.after(async () => {
    try {
      await Promise.all(adapters.map((adapter) => adapter.close()));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of mode === 'root' ? ['main'] : ['main', 'archive']) {
    const file = join(directory, `${source}.db`);
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT,
        tenant INTEGER NOT NULL DEFAULT 1);
        INSERT INTO physical_note VALUES (1, 'Original', 1), (2, 'Hidden', 2);`);
    } finally {
      db.close();
    }
    const adapter = new SqliteAdapter(file, source);
    adapters.push(adapter);
    sources[source] = { adapter, schema: await adapter.introspect(), writable: true, resources: { note: 'physical_note' } };
  }
  let resources: RuntimeResources;
  if (mode === 'root') {
    const local = createAppResources(sources.main.adapter, sources.main.schema, sources.main.resources);
    resources = {
      ...local,
      connections: ['main'],
      connectionFor: (table) => {
        local.toPhysical(table);
        return 'main';
      },
      toLogicalAt: (table, owner) => {
        assert.equal(owner, 'main');
        return local.toLogical(table);
      },
      forConnection: (owner) => {
        assert.equal(owner, 'main');
        return local.adapter;
      },
    };
  } else {
    const runtime = createAppSourceAdapter(sources, 'main');
    resources = {
      ...runtime,
      connections: ['main', 'archive'],
      connectionFor: (table) => runtime.resolve(table).source,
      toPhysical: (table) => runtime.resolve(table).physicalTable,
      toLogical: (table) => runtime.catalogs.get('main')!.toLogical(table),
      toLogicalAt: (table, owner) => (owner === 'main' ? '' : `${owner}.`) + runtime.catalogs.get(owner)!.toLogical(table),
      forConnection: (owner) => runtime.forSource(owner),
    };
  }
  const access: ResourceAccess = {
    readable: new Set(resources.schema.tables.map((table) => table.id)),
    writable: new Set(resources.schema.tables.map((table) => table.id)),
    rows: Object.fromEntries(
      resources.schema.tables.map((table) => [table.id, { groups: [[{ column: 'tenant', op: '=' as const, value: 1 }]] }]),
    ),
  };
  const owner = mode === 'root' ? 'main' : 'archive';
  const table = mode === 'root' ? 'note' : 'archive.note';
  const physical = sources[owner].adapter as SqliteAdapter;
  const select = (guarded: RuntimeResources) => (mode === 'root' ? guarded.adapter : guarded.forConnection(owner));
  const stored = async () => (await physical.query(query('physical_note'))).rows;
  return { resources, access, physical, table, owner, select, stored };
}

const reads: Array<{ name: keyof ScopedReads; run: (adapter: Adapter, table: string) => Promise<unknown> }> = [
  { name: 'query', run: (adapter, table) => adapter.query(query(table)) },
  { name: 'count', run: (adapter, table) => adapter.count(table) },
  { name: 'runView', run: (adapter, table) => adapter.runView!({ id: 'notes', name: 'Notes', base: table, columns: [{ path: 'body' }] }) },
  {
    name: 'countView',
    run: (adapter, table) => adapter.countView!({ id: 'notes', name: 'Notes', base: table, columns: [{ path: 'body' }] }),
  },
  { name: 'runBreakdown', run: (adapter, table) => adapter.runBreakdown!({ base: table, by: [], measures: [{ fn: 'count' }] }) },
  { name: 'countBreakdown', run: (adapter, table) => adapter.countBreakdown!({ base: table, by: [], measures: [{ fn: 'count' }] }) },
];

function wrapReads(bound: ScopedReads, run: <R>(work: () => Promise<R>) => Promise<R>): ScopedReads {
  return {
    query: (request) => run(() => bound.query(request)),
    count: (table, filter) => run(() => bound.count(table, filter)),
    runView: (view, offset) => run(() => bound.runView(view, offset)),
    countView: (view) => run(() => bound.countView(view)),
    runBreakdown: (def, offset) => run(() => bound.runBreakdown(def, offset)),
    countBreakdown: (def) => run(() => bound.countBreakdown(def)),
  };
}

test('a lifetime hook without rows refuses instead of advertising ordinary-adapter lifetime enforcement', async (t) => {
  const { resources, access } = await fixture(t);
  for (const writable of [new Set<string>(), access.writable]) {
    assert.throws(() => authorizeResources(resources, { ...access, writable, rows: undefined }, () => {}), AppAccessDenied);
  }
  assert.equal(await authorizeResources(resources, { ...access, rows: undefined }).adapter.count('note'), 2);
  const scoped = authorizeResources(resources, access).adapter;
  assert.equal(await scoped.count('note'), 1);
  assert.equal((await scoped.update!(change('note'))).affected, 1);
});

for (const mode of modes) {
  test(`${mode}: expired retained, detached and newly anchored operations refuse before binding or writing`, async (t) => {
    const { resources, access, physical, table, owner, select, stored } = await fixture(t, mode);
    let bindings = 0;
    let transactions = 0;
    const bind = physical.scopeReads.bind(physical);
    physical.scopeReads = (scope) => {
      bindings++;
      return bind(scope);
    };
    const transact = physical.scopeTransaction.bind(physical);
    physical.scopeTransaction = (scope, run) => {
      transactions++;
      return transact(scope, run);
    };
    const life = lifetime();
    const guarded = authorizeResources(resources, access, life.assertActive);
    const adapter = select(guarded);
    for (const read of reads) await read.run(adapter, table);
    assert.equal(bindings, 1, 'A bound reader is cached');
    const before = await stored();
    const detached = { ...adapter };
    life.state.active = false;
    for (const retained of [adapter, detached, guarded.adapter, guarded.forConnection(owner)]) {
      for (const read of reads) await denied(() => read.run(retained, table));
      await denied(() => retained.introspect());
      await denied(() => retained.insert!({ table, values: { id: 3, body: 'Denied' } }));
      await denied(() => retained.update!(change(table)));
      await denied(() => retained.remove!({ table, key: { id: 1 } }));
      if (retained.transaction) await denied(() => retained.transaction!(async () => assert.fail('Expired callback')));
    }
    assert.equal(bindings, 1);
    assert.equal(transactions, 0);
    assert.deepEqual(await stored(), before);
  });

  for (const stage of ['binding', 'cached', 'result'] as const) {
    for (const read of reads) {
      test(`${mode}: ${read.name} refuses expiry during ${stage} wait`, async (t) => {
        const { resources, access, physical, table, select } = await fixture(t, mode);
        const entered = gate();
        const resume = gate();
        t.after(resume.release);
        let calls = 0;
        let pause = false;
        const bind = physical.scopeReads.bind(physical);
        physical.scopeReads = async (scope) => {
          const bound = await bind(scope);
          if (stage === 'binding') {
            entered.release();
            await resume.promise;
          }
          return wrapReads(bound, async (work) => {
            calls++;
            const result = await work();
            if (stage === 'result' && pause) {
              entered.release();
              await resume.promise;
            }
            return result;
          });
        };
        const life = lifetime();
        const adapter = select(authorizeResources(resources, access, life.assertActive));
        if (stage !== 'binding') await read.run(adapter, table);
        const before = calls;
        pause = true;
        const pending = read.run(adapter, table);
        const refused = assert.rejects(pending, (error) => error === life.error);
        if (stage !== 'cached') await entered.promise;
        life.state.active = false;
        resume.release();
        await refused;
        assert.equal(calls, before + (stage === 'result' ? 1 : 0), 'Expired binding/cache never delegates; a late result never escapes');
      });
    }
  }

  for (const direct of [false, true]) {
    test(`${mode}: queued ${direct ? 'write' : 'transaction'} rechecks lifetime after physical writer acquisition`, async (t) => {
      const { resources, access, physical, table, select, stored } = await fixture(t, mode);
      const entered = gate();
      const resume = gate();
      const before = await stored();
      const holder = physical.transaction(async () => {
        entered.release();
        await resume.promise;
      });
      await entered.promise;
      let acquired = 0;
      let writes = 0;
      let callbacks = 0;
      const transact = physical.scopeTransaction.bind(physical);
      physical.scopeTransaction = (scope, run) =>
        transact(scope, (tx, evidence) => {
          acquired++;
          return run(
            {
              ...tx,
              update: (request) => {
                writes++;
                return tx.update(request);
              },
            },
            evidence,
          );
        });
      const life = lifetime();
      const adapter = select(authorizeResources(resources, access, life.assertActive));
      try {
        const pending = direct
          ? adapter.update!(change(table))
          : adapter.transaction!(async (tx) => {
              callbacks++;
              await tx.update(change(table));
            });
        const refused = assert.rejects(pending, (error) => error === life.error);
        assert.equal(acquired, 0);
        life.state.active = false;
        resume.release();
        await Promise.all([holder, refused]);
      } finally {
        resume.release();
        await holder;
      }
      assert.equal(acquired, 1, 'The real SQLite lease was acquired before refusing');
      assert.equal(callbacks, 0);
      assert.equal(writes, 0);
      assert.deepEqual(await stored(), before);
    });
  }

  const operations: Array<{ name: keyof WriteTransaction; run: (tx: WriteTransaction, table: string) => Promise<unknown> }> = [
    { name: 'query', run: (tx, table) => tx.query(query(table)) },
    { name: 'count', run: (tx, table) => tx.count(table) },
    { name: 'insert', run: (tx, table) => tx.insert({ table, values: { id: 3, body: 'New' } }) },
    { name: 'update', run: (tx, table) => tx.update(change(table)) },
    { name: 'remove', run: (tx, table) => tx.remove({ table, key: { id: 1 } }) },
  ];
  for (const operation of operations) {
    test(`${mode}: caught ${operation.name} lifetime refusal poisons the transaction and rolls back earlier writes`, async (t) => {
      const { resources, access, table, select, stored } = await fixture(t, mode);
      const life = lifetime();
      const adapter = select(authorizeResources(resources, access, life.assertActive));
      const before = await stored();
      await assert.rejects(
        adapter.transaction!(async (tx) => {
          await tx.update(change(table));
          life.state.active = false;
          await assert.rejects(operation.run(tx, table), (error) => error === life.error);
          // A deliberately transient hook isolates failure accounting from the
          // final lifetime check: restoring it cannot unpoison this transaction.
          life.state.active = true;
          await denied(() => tx.count(table));
          await denied(() => tx.insert({ table, values: { id: 4, body: 'Later' } }));
          return 'caught';
        }),
        (error) => error === life.error,
      );
      assert.deepEqual(await stored(), before);
    });
  }

  for (const name of ['query', 'count'] as const) {
    test(`${mode}: caught late transactional ${name} result refuses inside failure accounting`, async (t) => {
      const { resources, access, physical, table, select, stored } = await fixture(t, mode);
      const life = lifetime();
      const transact = physical.scopeTransaction.bind(physical);
      physical.scopeTransaction = (scope, run) =>
        transact(scope, (tx, evidence) =>
          run(
            {
              ...tx,
              query: async (request) => {
                const result = await tx.query(request);
                if (name === 'query') life.state.active = false;
                return result;
              },
              count: async (table, filter) => {
                const result = await tx.count(table, filter);
                if (name === 'count') life.state.active = false;
                return result;
              },
            },
            evidence,
          ),
        );
      const adapter = select(authorizeResources(resources, access, life.assertActive));
      const before = await stored();
      await denied(() =>
        adapter.transaction!(async (tx) => {
          await tx.update(change(table));
          await assert.rejects(name === 'query' ? tx.query(query(table)) : tx.count(table), (error) => error === life.error);
          life.state.active = true;
        }),
      );
      assert.deepEqual(await stored(), before);
    });
  }

  test(`${mode}: expiry after callback work rolls back before physical commit`, async (t) => {
    const { resources, access, table, select, stored } = await fixture(t, mode);
    const life = lifetime();
    const adapter = select(authorizeResources(resources, access, life.assertActive));
    const before = await stored();
    await assert.rejects(
      adapter.transaction!(async (tx) => {
        await tx.update(change(table));
        life.state.active = false;
        return 'done';
      }),
      (error) => error === life.error,
    );
    assert.deepEqual(await stored(), before);
  });

  test(`${mode}: expiry while draining an unawaited accepted operation rolls back before commit`, async (t) => {
    const { resources, access, physical, table, select, stored } = await fixture(t, mode);
    const life = lifetime();
    const entered = gate();
    const resume = gate();
    const callbackEnded = gate();
    t.after(resume.release);
    const transact = physical.scopeTransaction.bind(physical);
    physical.scopeTransaction = (scope, run) =>
      transact(scope, (tx, evidence) =>
        run(
          {
            ...tx,
            update: async (request) => {
              const result = await tx.update(request);
              entered.release();
              await resume.promise;
              return result;
            },
          },
          evidence,
        ),
      );
    const adapter = select(authorizeResources(resources, access, life.assertActive));
    const before = await stored();
    const run = async (tx: WriteTransaction) => {
      void tx.update(change(table));
      await entered.promise;
    };
    const pending = adapter.transaction!((tx) => run(tx).finally(callbackEnded.release));
    // Observe callback settlement before allowing the outstanding write to
    // return, matching the issuer's expire-then-drain lifecycle.
    const refused = assert.rejects(pending, (error) => error === life.error);
    await callbackEnded.promise;
    life.state.active = false;
    resume.release();
    await refused;
    assert.deepEqual(await stored(), before);
  });

  test(`${mode}: accepted queued operations recheck lifetime inside the facade queue`, async (t) => {
    const { resources, access, physical, table, select, stored } = await fixture(t, mode);
    const life = lifetime();
    const entered = gate();
    const resume = gate();
    t.after(resume.release);
    let inserts = 0;
    const transact = physical.scopeTransaction.bind(physical);
    physical.scopeTransaction = (scope, run) =>
      transact(scope, (tx, evidence) =>
        run(
          {
            ...tx,
            update: async (request) => {
              const result = await tx.update(request);
              entered.release();
              await resume.promise;
              return result;
            },
            insert: (request) => {
              inserts++;
              return tx.insert(request);
            },
          },
          evidence,
        ),
      );
    const adapter = select(authorizeResources(resources, access, life.assertActive));
    const before = await stored();
    await assert.rejects(
      adapter.transaction!(async (tx) => {
        const first = tx.update(change(table));
        await entered.promise;
        const queued = tx.insert({ table, values: { id: 3, body: 'Queued while active' } });
        const refused = assert.rejects(queued, (error) => error === life.error);
        life.state.active = false;
        resume.release();
        await first;
        await refused;
        life.state.active = true;
      }),
      (error) => error === life.error,
    );
    assert.equal(inserts, 0, 'Expiry is checked when queued work executes, before physical delegation');
    assert.deepEqual(await stored(), before);
  });

  test(`${mode}: successful callback handles expire independently of the request hook`, async (t) => {
    const { resources, access, table, select } = await fixture(t, mode);
    const life = lifetime();
    const adapter = select(authorizeResources(resources, access, life.assertActive));
    let retained!: WriteTransaction;
    await adapter.transaction!(async (tx) => {
      retained = tx;
      await tx.update(change(table));
    });
    for (const operation of operations) await denied(() => operation.run(retained, table));
    assert.equal(life.state.active, true);
  });

  for (const direct of [false, true]) {
    test(`${mode}: retirement after physical commit does not report a committed ${direct ? 'write' : 'transaction'} as failed`, async (t) => {
      const { resources, access, physical, table, select, stored } = await fixture(t, mode);
      const life = lifetime();
      const transact = physical.scopeTransaction.bind(physical);
      physical.scopeTransaction = async (scope, run) => {
        const result = await transact(scope, run);
        life.state.active = false;
        return result;
      };
      const adapter = select(authorizeResources(resources, access, life.assertActive));
      if (direct) assert.equal((await adapter.update!(change(table))).affected, 1);
      else
        assert.equal(
          await adapter.transaction!(async (tx) => {
            await tx.update(change(table));
            return 'committed';
          }),
          'committed',
        );
      assert.equal((await stored())[0].body, 'Changed');
      await denied(() => adapter.count(table));
    });
  }
}
