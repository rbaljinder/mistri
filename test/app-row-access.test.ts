import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  type Adapter,
  type Filter,
  type QueryRequest,
  type ScopedReads,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  accessibleSchema,
  AppAccessDenied,
  authorizeResources,
  authorizeTransaction,
  type ResourceAccess,
} from '../packages/mistri/src/server/app/appAccess.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { PathError, type ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

const query = (table = 'person', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const view = (base = 'person', extra: Partial<ViewDef> = {}): ViewDef => ({ id: 'rows', name: 'Rows', base, columns: [], ...extra });
const breakdown = (extra: Partial<BreakdownDef> = {}): BreakdownDef => ({ base: 'ticket', by: [], measures: [{ fn: 'count' }], ...extra });
const equal = (column: string, value: number | string): Filter => ({ groups: [[{ column, op: '=', value }]] });
const denied = (run: () => unknown) =>
  assert.rejects(
    async () => run(),
    (error) => error instanceof Refusal || error instanceof PathError,
  );

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-row-access-'));
  const opened: SqliteAdapter[] = [];
  t.after(async () => {
    await Promise.all(opened.map((adapter) => adapter.close()));
    rmSync(dir, { recursive: true, force: true });
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of ['operations', 'inventory']) {
    const file = join(dir, `${source}.db`);
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE physical_person (id INTEGER PRIMARY KEY, name TEXT, tenant INTEGER, secret TEXT);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, title TEXT, tenant INTEGER,
        owner_id INTEGER REFERENCES physical_person(id), secret TEXT);
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO physical_person VALUES (1, '${source} one', 1, 'secret one'), (2, '${source} two', 2, 'secret two');
      INSERT INTO physical_ticket VALUES (1, 'First', 1, 1, 'secret first'), (2, 'Second', 2, 2, 'secret second'),
        (3, 'Third', 1, 2, 'secret third');
      INSERT INTO physical_note VALUES (1, 'Denied by omission');
    `);
    db.close();
    const adapter = new SqliteAdapter(file, source);
    opened.push(adapter);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: { person: 'physical_person', ticket: 'physical_ticket', note: 'physical_note' },
    };
  }
  const runtime = createAppSourceAdapter(sources, 'operations');
  const resources: RuntimeResources = {
    ...runtime,
    connections: ['operations', 'inventory'],
    connectionFor: (name) => runtime.resolve(name).source,
    toPhysical: (name) => runtime.resolve(name).physicalTable,
    toLogical: (name) => runtime.catalogs.get('operations')!.toLogical(name),
    toLogicalAt: (name, owner) => (owner === 'operations' ? '' : `${owner}.`) + runtime.catalogs.get(owner)!.toLogical(name),
    forConnection: (owner) => runtime.forSource(owner),
  };
  const access: ResourceAccess = {
    readable: new Set(runtime.schema.tables.map((table) => table.id)),
    writable: new Set(),
    rows: {
      person: equal('tenant', 1),
      ticket: equal('tenant', 1),
      'inventory.person': equal('tenant', 2),
      'inventory.ticket': equal('tenant', 2),
    },
    fields: new Map(
      runtime.schema.tables.map((table) => [
        table.id,
        {
          read: new Set(table.columns.map((column) => column.name).filter((name) => !['tenant', 'secret'].includes(name))),
          write: new Set<string>(),
        },
      ]),
    ),
  };
  return { resources, access, raw: runtime.adapter, runtime };
}

test('row and field policies compose for direct reads, search, counts and pagination', async (t) => {
  const { resources, access, raw } = await fixture(t);
  const adapter = authorizeResources(resources, access).adapter;
  assert.deepEqual((await adapter.query(query())).rows, [{ id: 1, name: 'operations one' }]);
  assert.equal(await adapter.count('person'), 1);
  assert.equal(await raw.count('person'), 2, 'The original adapter stays independently unscoped');
  assert.deepEqual((await adapter.query(query('person', { filter: equal('id', 2) }))).rows, []);
  assert.equal(await adapter.count('person', equal('id', 2)), 0);
  assert.deepEqual(
    (await adapter.query(query('person', { filter: { groups: [[{ column: 'name', op: 'contains', value: 'two' }]] } }))).rows,
    [],
  );
  assert.deepEqual(
    (await adapter.query(query('ticket', { columns: ['id'], orderBy: [{ column: 'id', direction: 'asc' }], limit: 1, offset: 1 }))).rows,
    [{ id: 3 }],
  );
  for (const table of ['note', 'inventory.note']) {
    assert.deepEqual((await adapter.query(query(table))).rows, []);
    assert.equal(await adapter.count(table), 0);
  }
});

test('scoped joins, reverse aggregates, view counts and breakdown counts never read hidden rows', async (t) => {
  const { resources, access } = await fixture(t);
  const adapter = authorizeResources(resources, access).adapter;
  const joined = view('ticket', {
    columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'owner' }],
    orderBy: [{ path: 'id', direction: 'asc' }],
  });
  assert.deepEqual((await adapter.runView!(joined)).rows, [
    { id: 1, owner: 'operations one' },
    { id: 3, owner: null },
  ]);
  assert.equal(await adapter.countView!(joined), 2);
  const filtered = { ...joined, filter: { groups: [[{ path: 'owner_id.name', op: '=' as const, value: 'operations two' }]] } };
  assert.deepEqual((await adapter.runView!(filtered)).rows, []);
  assert.equal(await adapter.countView!(filtered), 0);
  const reverse = view('person', { columns: [{ path: 'id' }], aggregates: [{ fn: 'count', via: 'ticket.owner_id', alias: 'tickets' }] });
  assert.deepEqual((await adapter.runView!(reverse)).rows, [{ id: 1, tickets: 1 }]);
  const grouped = breakdown({ by: [{ path: 'owner_id.name' }] });
  const groups = (await adapter.runBreakdown!(grouped)).rows;
  assert.equal(groups.length, 2);
  assert.ok(groups.some((row) => row['owner_id.name'] === null && row.count === 1));
  assert.ok(groups.some((row) => row['owner_id.name'] === 'operations one' && row.count === 1));
  assert.equal(await adapter.countBreakdown!(grouped), 2);
  assert.deepEqual((await adapter.runBreakdown!(breakdown())).rows, [{ count: 2 }]);
  assert.equal(await adapter.countBreakdown!(breakdown()), 1);
});

test('forged hidden fields, resources, paths and counts refuse before scoped binding', async (t) => {
  const { resources, access } = await fixture(t);
  let binds = 0;
  const adapter = authorizeResources(
    {
      ...resources,
      adapter: {
        ...resources.adapter,
        scopeReads: async (scope) => {
          binds++;
          return resources.adapter.scopeReads!(scope);
        },
      },
    },
    access,
  ).adapter;
  for (const table of ['physical_person', 'inventory.physical_person', 'operations.person']) {
    await denied(() => adapter.query(query(table)));
    await denied(() => adapter.count(table));
  }
  for (const column of ['tenant', 'secret', 'missing']) {
    await denied(() => adapter.query(query('person', { columns: [column] })));
    await denied(() => adapter.query(query('person', { orderBy: [{ column, direction: 'asc' }] })));
    await denied(() => adapter.query(query('person', { filter: equal(column, 2) })));
    await denied(() => adapter.count('person', equal(column, 2)));
    for (const def of [
      view('ticket', { columns: [{ path: `owner_id.${column}` }] }),
      view('ticket', { filter: { groups: [[{ path: `owner_id.${column}`, op: '=', value: 2 }]] } }),
      view('person', { aggregates: [{ fn: 'max', via: 'ticket.owner_id', column }] }),
    ]) {
      await denied(() => adapter.runView!(def));
      await denied(() => adapter.countView!(def));
    }
    const def = breakdown({ by: [{ path: `owner_id.${column}` }] });
    await denied(() => adapter.runBreakdown!(def));
    await denied(() => adapter.countBreakdown!(def));
  }
  assert.equal(binds, 0);
  (access.readable as Set<string>).delete('person');
  await denied(() => adapter.count('person'));
  assert.equal(binds, 0, 'Resource checks still precede each read');
});

test('materialized text and forged request scope properties cannot replace the private scope', async (t) => {
  const { resources, access } = await fixture(t);
  const adapter = authorizeResources(resources, access).adapter;
  const extra = { scope: { person: true }, rows: { person: true }, rowScope: { person: true } };
  assert.deepEqual((await adapter.query({ ...query(), ...extra })).rows, [{ id: 1, name: 'operations one' }]);
  assert.deepEqual((await adapter.runView!({ ...view('ticket', { text: 'person', columns: [{ path: 'secret' }] }), ...extra })).rows, [
    { id: 1, name: 'operations one' },
  ]);
  assert.equal(await adapter.countView!({ ...view('ticket', { text: 'person' }), ...extra }), 1);
  const grouped = { ...breakdown({ text: 'ticket count by owner_id.name' }), ...extra };
  assert.equal((await adapter.runBreakdown!(grouped)).rows.length, 2);
  assert.equal(await adapter.countBreakdown!(grouped), 2);
  for (const text of ['person show secret', 'ticket show owner_id.secret']) {
    await denied(() => adapter.runView!(view('person', { text })));
    await denied(() => adapter.countView!(view('person', { text })));
  }
});

test('row-scoped catalog omits all estimates and write affordances without mutating the full catalog', async (t) => {
  const { resources, access } = await fixture(t);
  for (const table of resources.schema.tables) table.approxRows = 999;
  const before = structuredClone(resources.schema);
  const guarded = authorizeResources(resources, access);
  for (const schema of [guarded.schema, await guarded.adapter.introspect(), await guarded.forConnection('inventory').introspect()]) {
    for (const table of schema.tables) {
      assert.ok(!Object.hasOwn(table, 'approxRows'));
      assert.equal(table.deletable, false);
      assert.ok(table.columns.every((column) => column.writable === false));
    }
  }
  assert.deepEqual(resources.schema, before);
  const unscoped = accessibleSchema(resources.schema, { ...access, rows: undefined });
  assert.ok(unscoped.tables.every((table) => table.approxRows === 999));
});

test('scoped facade exposes no writer, transaction, statistics, raw SQL, lifecycle ownership or rebinding', async (t) => {
  const { resources, access } = await fixture(t);
  const guarded = authorizeResources(resources, access);
  for (const adapter of [guarded.adapter, guarded.forConnection('operations'), guarded.forConnection('inventory')]) {
    assert.deepEqual(
      Object.keys(adapter).sort(),
      ['dialect', 'introspect', 'close', 'query', 'count', 'runView', 'countView', 'runBreakdown', 'countBreakdown', 'countEach'].sort(),
    );
    for (const key of [
      'profile',
      'estimateCount',
      'runSql',
      'explainSql',
      'ddl',
      'insert',
      'update',
      'remove',
      'transaction',
      'commandTransaction',
      'scopeReads',
    ]) {
      assert.equal(adapter[key as keyof Adapter], undefined);
    }
    await adapter.close();
  }
  assert.equal(await resources.adapter.count('person'), 2, 'Closing the facade must not close its owner');
});

test('row policies reject unsupported write capabilities and direct unproven transaction wrapping', async (t) => {
  const { resources, access } = await fixture(t);
  const unsupported = {
    ...resources,
    forConnection: (owner: string) => ({ ...resources.forConnection(owner), scopeTransaction: undefined }),
  };
  for (const writable of [new Set(['person']), new Set(['inventory.person']), new Set(['unknown'])]) {
    assert.throws(() => authorizeResources(unsupported, { ...access, writable }), AppAccessDenied);
  }
  const writer = {} as WriteTransaction;
  assert.throws(() => authorizeTransaction(resources.schema, access, writer), AppAccessDenied);
  assert.throws(() => authorizeTransaction(resources.schema, { ...access, rows: {} }, writer), AppAccessDenied);
});

test('policy snapshot validates unused and foreign rules before any asynchronous binding', async (t) => {
  const { resources, access } = await fixture(t);
  let calls = 0;
  const instrumented = {
    ...resources,
    adapter: {
      ...resources.adapter,
      scopeReads: async (scope: RowScope) => {
        calls++;
        return resources.adapter.scopeReads!(scope);
      },
    },
  };
  let getters = 0;
  const getter = Object.defineProperty({}, 'person', {
    enumerable: true,
    get() {
      getters++;
      return true;
    },
  });
  for (const rows of [
    { ...access.rows, 'inventory.note': equal('unknown', 1) },
    { physical_person: true },
    { person: { groups: [] } },
    Object.create({ person: true }),
    getter,
  ]) {
    assert.throws(() => authorizeResources(instrumented, { ...access, rows }), Refusal);
  }
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test('lazy binding caches success and freezes policies and every read argument before awaiting', async (t) => {
  const { resources, access } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let binds = 0;
  const unsafe = () => {
    throw new Error('Unscoped fallback');
  };
  const adapter = authorizeResources(
    {
      ...resources,
      adapter: {
        ...resources.adapter,
        query: unsafe,
        count: unsafe,
        runView: unsafe,
        countView: unsafe,
        runBreakdown: unsafe,
        countBreakdown: unsafe,
        scopeReads: async (scope) => {
          binds++;
          await gate;
          return resources.adapter.scopeReads!(scope);
        },
      },
    },
    access,
  ).adapter;
  assert.equal(binds, 0);
  const request = query('person', { filter: equal('id', 1), columns: ['name'] });
  const filter = equal('id', 1);
  const def = view('person', { columns: [{ path: 'name' }] });
  const grouped = breakdown({ base: 'person', by: [{ path: 'name' }] });
  const pending = [
    adapter.query(request),
    adapter.count('person', filter),
    adapter.runView!(def),
    adapter.countView!(def),
    adapter.runBreakdown!(grouped),
    adapter.countBreakdown!(grouped),
  ];
  request.table = 'inventory.person';
  request.columns![0] = 'secret';
  request.filter!.groups[0][0].value = 2;
  filter.groups[0][0].value = 2;
  def.base = 'inventory.person';
  def.columns[0].path = 'secret';
  grouped.base = 'inventory.person';
  grouped.by[0].path = 'secret';
  (access.rows!.person as Filter).groups[0][0].value = 2;
  access.rows = {};
  release();
  const result = await Promise.all(pending);
  assert.deepEqual((result[0] as Awaited<ReturnType<ScopedReads['query']>>).rows, [{ name: 'operations one' }]);
  assert.equal(result[1], 1);
  assert.deepEqual((result[2] as Awaited<ReturnType<ScopedReads['runView']>>).rows, [{ name: 'operations one' }]);
  assert.equal(result[3], 1);
  assert.deepEqual((result[4] as Awaited<ReturnType<ScopedReads['runBreakdown']>>).rows, [{ name: 'operations one', count: 1 }]);
  assert.equal(result[5], 1);
  assert.equal(await adapter.count('person'), 1);
  assert.equal(binds, 1);
});

test('missing, incomplete and rejected capabilities never fall back and failed binds stay cached', async (t) => {
  const { resources, access } = await fixture(t);
  assert.throws(
    () => authorizeResources({ ...resources, adapter: { ...resources.adapter, scopeReads: undefined } }, access),
    AppAccessDenied,
  );
  for (const scopeReads of [
    async () => ({}) as ScopedReads,
    async () => {
      throw new AppAccessDenied();
    },
  ]) {
    let calls = 0;
    const adapter = authorizeResources(
      {
        ...resources,
        adapter: {
          ...resources.adapter,
          scopeReads: async () => {
            calls++;
            return scopeReads();
          },
        },
      },
      access,
    ).adapter;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, 'No eager rejected promise is created');
    await denied(() => adapter.count('person'));
    await denied(() => adapter.query(query()));
    assert.equal(calls, 1);
  }
});

test('connection-owned scopes keep exact merged IDs and cannot escape to another source', async (t) => {
  const { resources, access, runtime } = await fixture(t);
  const captured: Array<[string, string[]]> = [];
  const guarded = authorizeResources(
    {
      ...resources,
      forConnection: (owner) => {
        const original = resources.forConnection(owner);
        return {
          ...original,
          scopeReads: async (scope) => {
            captured.push([owner, Object.keys(scope).sort()]);
            return original.scopeReads!(scope);
          },
        };
      },
    },
    access,
  );
  for (const adapter of [guarded.adapter, guarded.forConnection('inventory')]) {
    assert.deepEqual((await adapter.query(query('inventory.person'))).rows, [{ id: 2, name: 'inventory two' }]);
    assert.equal(await adapter.count('inventory.person'), 1);
    assert.deepEqual((await adapter.runView!(view('inventory.person'))).rows, [{ id: 2, name: 'inventory two' }]);
    assert.equal(await adapter.countView!(view('inventory.person')), 1);
    const grouped = breakdown({ base: 'inventory.ticket' });
    assert.deepEqual((await adapter.runBreakdown!(grouped)).rows, [{ count: 1 }]);
    assert.equal(await adapter.countBreakdown!(grouped), 1);
  }
  assert.deepEqual(captured, [['inventory', ['inventory.person', 'inventory.ticket']]]);
  const anchored = guarded.forConnection('inventory');
  await denied(() => anchored.query(query()));
  await denied(() => anchored.count('person'));
  await denied(() => anchored.runView!(view()));
  await denied(() => anchored.countView!(view()));
  await denied(() => anchored.runBreakdown!(breakdown()));
  await denied(() => anchored.countBreakdown!(breakdown()));
  await denied(() => runtime.forSource('inventory').scopeReads!(access.rows!));
  const deniedRows = authorizeResources(resources, { ...access, rows: {} }).forConnection('inventory');
  assert.equal(await deniedRows.count('inventory.person'), 0);
  const explicit = authorizeResources(resources, { ...access, rows: { person: true, ticket: false } }).adapter;
  assert.equal(await explicit.count('person'), 2);
  assert.equal(await explicit.count('ticket'), 0);
});
