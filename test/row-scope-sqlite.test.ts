import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { ANSI_STYLE, Refusal, type Filter, type QueryRequest, type SqlFragment } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createScopedReads } from '../packages/engine/src/adapters/scoped/scopedReads.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { captureScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

const eq = (column: string, value: string | number | boolean): Filter => ({ groups: [[{ column, op: '=', value }]] });
const query = (extra: Partial<QueryRequest> = {}): QueryRequest => ({ table: 'item', limit: 20, offset: 0, ...extra });
const view = (extra: Partial<ViewDef> = {}): ViewDef => ({ id: 'items', name: 'Items', base: 'item', columns: [{ path: 'id' }], ...extra });
const breakdown: BreakdownDef = { base: 'item', by: [{ path: 'tenant' }], measures: [{ fn: 'count', alias: 'n' }] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-sqlite-'));
  const path = join(directory, 'scope.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE owner (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT);
    CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT, owner_id INTEGER REFERENCES owner(id), active BOOLEAN, "a.b" TEXT, payload BLOB);
    CREATE TABLE note (id INTEGER PRIMARY KEY, tenant TEXT, item_id INTEGER REFERENCES item(id));
    INSERT INTO owner VALUES (1, 'a', 'Alice'), (2, 'b', 'Bob');
    INSERT INTO item VALUES (1, 'a', 'Alpha', 1, 1, 'local', X'0001FF'), (2, 'b', 'Beta', 2, 0, 'other', X'02'),
      (3, 'a', 'Other A', 2, 0, 'local', X'03'), (9007199254740993, 'a', 'Big A', NULL, 1, 'large', X'04');
    INSERT INTO note VALUES (1, 'a', 1), (2, 'b', 1), (3, 'b', 2);
  `);
  db.close();
  const adapter = new SqliteAdapter(path);
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
  const schema = await adapter.introspect();
  return { adapter, schema, close };
}

test('SQLite private scope binds all seven reads and preserves bigint values and empty headers', async (t) => {
  const { adapter, schema } = await fixture(t);
  const scope: RowScope = Object.fromEntries(schema.tables.map((table) => [table.id, eq('tenant', 'a')]));
  const reads = await adapter.scopeReads(scope);
  assert.deepEqual(Object.keys(reads).sort(), ['count', 'countBreakdown', 'countEach', 'countView', 'query', 'runBreakdown', 'runView']);
  assert.equal(Object.isFrozen(reads), true);
  const result = await reads.query(query({ columns: ['id'], orderBy: [{ column: 'id', direction: 'asc' }] }));
  assert.deepEqual(result.rows, [{ id: 1 }, { id: 3 }, { id: '9007199254740993' }]);
  const ordinaryBytes = await reads.query(query({ columns: ['id', 'payload'], filter: eq('id', 1) }));
  assert.deepEqual(ordinaryBytes.rows, [{ id: 1, payload: '<3 bytes>' }]);
  const binaryBytes = await reads.query(query({ columns: ['id', 'payload'], filter: eq('id', 1), binary: true }));
  assert.deepEqual(binaryBytes.rows, [{ id: 1, payload: new Uint8Array([0, 1, 255]) }]);
  assert.equal(await reads.count('item'), 3);
  assert.equal(await reads.countView(view()), 3);
  const joined = view({
    columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'owner' }],
    aggregates: [{ fn: 'count', via: schema.foreignKeys.find((fk) => fk.from.table === 'note')!.name, alias: 'notes' }],
    orderBy: [{ path: 'id', direction: 'asc' }],
  });
  assert.deepEqual((await reads.runView(joined)).rows, [
    { id: 1, owner: 'Alice', notes: 1 },
    { id: 3, owner: null, notes: 0 },
    { id: '9007199254740993', owner: null, notes: 0 },
  ]);
  assert.deepEqual((await reads.runBreakdown(breakdown)).rows, [{ tenant: 'a', n: 3 }]);
  assert.equal(await reads.countBreakdown(breakdown), 1);
  const empty = await reads.query(query({ columns: ['id', 'name'], filter: eq('id', 2) }));
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.columns, ['id', 'name']);
  assert.equal(await adapter.count('item'), 4, 'binding does not change the original adapter');
});

test('SQLite scopes remain independent across interleaved reads and ordinary calls', async (t) => {
  const { adapter } = await fixture(t);
  const [a, b, denied] = await Promise.all([
    adapter.scopeReads({ item: eq('tenant', 'a') }),
    adapter.scopeReads({ item: eq('tenant', 'b') }),
    adapter.scopeReads({}),
  ]);
  const results = await Promise.all([
    a.count('item'),
    b.count('item'),
    denied.count('item'),
    adapter.count('item'),
    a.countView(view()),
    b.countView(view()),
  ]);
  assert.deepEqual(results, [3, 1, 0, 4, 3, 1]);
  assert.deepEqual((await denied.query(query())).rows, []);
  assert.deepEqual((await denied.runView(view())).rows, []);
  assert.deepEqual((await denied.runBreakdown(breakdown)).rows, []);
  assert.equal(await denied.countBreakdown(breakdown), 0);
});

test('SQLite policy booleans, local dotted columns and pagination retain native binding behavior', async (t) => {
  const { adapter } = await fixture(t);
  for (const active of [true, false]) {
    const reads = await adapter.scopeReads({ item: eq('active', active) });
    assert.equal(await reads.count('item'), 2);
    assert.deepEqual((await reads.query(query({ columns: ['active'], limit: 1 }))).rows, [{ active: active ? 1 : 0 }]);
  }
  const reads = await adapter.scopeReads({ item: eq('a.b', 'local') });
  const result = await reads.query(
    query({
      columns: ['id', 'a.b'],
      orderBy: [
        { column: 'a.b', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
      limit: 1,
      offset: 1,
    }),
  );
  assert.deepEqual(result.rows, [{ id: 3, 'a.b': 'local' }]);
  assert.deepEqual(result.sql.params, ['local', 1, 1]);
  assert.equal(await reads.count('item', eq('a.b', 'local')), 2);
});

test('SQLite captures a policy before the first catalog await and rejects malformed scopes', async (t) => {
  const { adapter } = await fixture(t);
  const input: Record<string, boolean | Filter> = { item: eq('tenant', 'a') };
  const pending = adapter.scopeReads(input);
  (input.item as Filter).groups[0][0].value = 'b';
  input.item = true;
  const reads = await pending;
  assert.equal(await reads.count('item'), 3);
  await assert.rejects(adapter.scopeReads({ item: { groups: [] } }), Refusal);
  await assert.rejects(adapter.scopeReads({ missing: true }), Refusal);
  let called = false;
  await assert.rejects(
    adapter.scopeReads(
      Object.defineProperty({}, 'item', {
        enumerable: true,
        get() {
          called = true;
          return true;
        },
      }),
    ),
    Refusal,
  );
  assert.equal(called, false);
  await assert.rejects(adapter.scopeReads(undefined as unknown as RowScope), Refusal);
});

test('scoped reads cannot be widened by definition properties or forged table/column names', async (t) => {
  const { adapter } = await fixture(t);
  const reads = await adapter.scopeReads({ item: eq('tenant', 'a') });
  assert.equal((await reads.query({ ...query(), scope: { item: true }, rowScope: {} } as QueryRequest)).rows.length, 3);
  assert.equal(await reads.countView({ ...view(), scope: { item: true } } as ViewDef), 3);
  for (const request of [
    query({ table: 'missing' }),
    query({ columns: ['missing'] }),
    query({ orderBy: [{ column: 'missing', direction: 'asc' }] }),
    query({ filter: eq('missing', 'a') }),
  ]) {
    await assert.rejects(reads.query(request), Refusal);
  }
  await assert.rejects(reads.count('missing'), Refusal);
  await assert.rejects(reads.runView(view({ columns: [{ path: 'missing' }] })));
});

test('factory snapshots catalog and request data before driver waits without retaining mutable arguments', async (t) => {
  const { schema } = await fixture(t);
  const statements: SqlFragment[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = createScopedReads(schema, { item: eq('tenant', 'a') }, ANSI_STYLE, async (statement) => {
    statements.push(statement);
    await gate;
    return { rows: [], columns: [], ms: 0, sql: statement };
  });
  const input = query({ columns: ['id'], filter: { groups: [[{ column: 'id', op: 'in', value: [1, 3] }]] } });
  const pending = reads.query(input);
  input.columns![0] = 'name';
  (input.filter!.groups[0][0].value as number[]).push(2);
  schema.tables.length = 0;
  release();
  const result = await pending;
  assert.deepEqual(result.columns, ['id']);
  assert.deepEqual(statements[0].params, ['a', 1, 3, 20, 0]);
  assert.match(statements[0].text, /SELECT "id" FROM/);
  await reads.count('item');
  assert.equal(statements.length, 2, 'bound catalog survives external mutation');
});

/* A captured catalog is detached and deeply frozen, so a reader may bind to it
   as it is: tenant sources bind one per operation, and copying the catalog
   each time was milliseconds per read on a wide one. Anything else is still
   copied (the case above). */
test('a captured catalog is bound without a copy, and still cannot be changed under the reader', async (t) => {
  const { schema } = await fixture(t);
  const captured = captureScopeCatalog(schema);
  const cloned: unknown[] = [];
  const clone = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', (value: unknown, options?: StructuredSerializeOptions) => {
    cloned.push(value);
    return clone(value, options);
  });
  const statements: SqlFragment[] = [];
  const reads = createScopedReads(captured, { item: eq('tenant', 'a') }, ANSI_STYLE, async (statement) => {
    statements.push(statement);
    return { rows: [], columns: [], ms: 0, sql: statement };
  });
  await reads.query(query({ columns: ['id'] }));
  await reads.count('item');
  await reads.runView(view());
  assert.equal(cloned.includes(captured), false, 'the frozen catalog is not copied');
  assert.equal(statements.length, 3);
  assert.throws(() => {
    (captured.tables as unknown as unknown[]).length = 0;
  }, TypeError);
  createScopedReads(schema, { item: eq('tenant', 'a') }, ANSI_STYLE, async (statement) => ({
    rows: [],
    columns: [],
    ms: 0,
    sql: statement,
  }));
  assert.equal(cloned.includes(schema), true, 'a plain catalog still is');
});

test('invalid structured reads fail before the scoped executor is entered', async (t) => {
  const { schema } = await fixture(t);
  let calls = 0;
  const reads = createScopedReads(schema, { item: true }, ANSI_STYLE, async (statement) => {
    calls++;
    return { rows: [], columns: [], ms: 0, sql: statement };
  });
  const sparse: string[] = [];
  sparse.length = 1;
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const malformed = [
    query({ columns: sparse }),
    query({ columns: cycle as string[] }),
    Object.create(query()),
    Object.defineProperty(query(), 'filter', {
      enumerable: true,
      get() {
        throw new Error('must not run');
      },
    }),
    query({ filter: { groups: [[{ column: 'id', op: '=', value: Infinity }]] } }),
  ];
  for (const request of malformed) await assert.rejects(reads.query(request), Refusal);
  assert.equal(calls, 0);
});

test('closing the owner adapter expires scoped reads rather than opening a new connection', async (t) => {
  const { adapter, close } = await fixture(t);
  const reads = await adapter.scopeReads({ item: true });
  await close();
  await assert.rejects(reads.query(query()));
  await assert.rejects(reads.count('item'));
});

test('SQLite scoped countEach is one statement, and each item counts what `count` would under the scope and its filter', async (t) => {
  const { adapter, schema } = await fixture(t);
  const scope: RowScope = { ...Object.fromEntries(schema.tables.map((table) => [table.id, eq('tenant', 'a')])), note: false };
  const reads = await adapter.scopeReads(scope);
  const seen: string[] = [];
  const db = Reflect.get(adapter, 'db') as DatabaseSync;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const items = [{ table: 'item' }, { table: 'item', filter: eq('active', 1) }, { table: 'owner' }, { table: 'note' }];
  const counts = await reads.countEach!(items, 10_000);
  assert.deepEqual(counts, [3, 2, 1, 0], 'the scope narrows every item; a refused table counts nothing');
  assert.equal(seen.length, 1, seen.join('\n'));
  assert.deepEqual(counts, await Promise.all(items.map((item) => reads.count(item.table, item.filter, 10_000))));
  await assert.rejects(reads.countEach!([{ table: 'item', filter: eq('nope', 1) }]), Refusal);
  await assert.rejects(reads.countEach!([]), Refusal);
});
