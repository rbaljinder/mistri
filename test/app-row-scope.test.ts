import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type Filter, type ScopedReads } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

const query = (table: string) => ({ table, limit: 20, offset: 0 });
const rule = (value: number): Filter => ({ groups: [[{ column: 'tenant_id', op: '=', value }]] });
const view = (base: string): ViewDef => ({ id: 'scoped', name: 'Scoped', base, columns: [{ path: 'id' }, { path: 'owner_id.name' }] });
const six = ['query', 'count', 'countEach', 'runView', 'countView', 'runBreakdown', 'countBreakdown'].sort();
const surface = (reads: ScopedReads) => {
  assert.deepEqual(Reflect.ownKeys(reads).sort(), six);
  assert.equal(Object.isFrozen(reads), true);
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-row-scope-'));
  const opened: Adapter[] = [];
  t.after(async () => {
    await Promise.all(opened.map((adapter) => adapter.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of ['operations', 'archive']) {
    const file = join(directory, `${source}.db`);
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE physical_person (id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT,
        owner_id INTEGER REFERENCES physical_person(id));
    `);
    const insert = db.prepare('INSERT INTO physical_person VALUES (?, ?, ?)');
    insert.run(1, 1, `${source} one`);
    insert.run(2, 2, `${source} two`);
    db.exec("INSERT INTO physical_ticket VALUES (1, 1, 'first', 1), (2, 2, 'second', 2), (3, 1, 'foreign owner', 2)");
    db.close();
    const adapter = new SqliteAdapter(file, source);
    opened.push(adapter);
    sources[source] = { adapter, schema: await adapter.introspect(), resources: { people: 'physical_person', tickets: 'physical_ticket' } };
  }
  return {
    sources,
    runtime: () => createAppSourceAdapter(sources, 'operations'),
    logical: () => createAppResources(sources.operations.adapter, sources.operations.schema, sources.operations.resources),
  };
}

test('logical scoped reads map all aliases and expose exactly six read functions', async (t) => {
  const { logical } = await fixture(t);
  const { adapter } = logical();
  const reads = await adapter.scopeReads!({ people: rule(1), tickets: rule(1) });
  surface(reads);
  assert.deepEqual(
    (await reads.query(query('people'))).rows.map((row) => row.name),
    ['operations one'],
  );
  assert.equal(await reads.count('tickets'), 2);
  assert.equal(await adapter.count('tickets'), 3, 'Ordinary adapter remains independent');
  const result = await reads.runView(view('tickets'));
  assert.deepEqual(result.rows, [
    { id: 1, 'owner_id.name': 'operations one' },
    { id: 3, 'owner_id.name': null },
  ]);
  assert.deepEqual(result.resolved, (await adapter.runView!(view('tickets'))).resolved);
  assert.deepEqual(result.joins, (await adapter.runView!(view('tickets'))).joins);
  assert.equal(await reads.countView(view('tickets')), 2);
  const breakdown = { base: 'tickets', by: [{ path: 'owner_id.name' }], measures: [{ fn: 'count' as const }] };
  const grouped = await reads.runBreakdown(breakdown);
  assert.equal(grouped.rows.length, 2);
  assert.deepEqual(grouped.resolved, (await adapter.runBreakdown!(breakdown)).resolved);
  assert.equal(await reads.countBreakdown(breakdown), 2);
});

test('combined scope keeps identical physical IDs on different connections disjoint', async (t) => {
  const { runtime } = await fixture(t);
  const app = runtime();
  const reads = await app.adapter.scopeReads!({ people: rule(1), tickets: rule(1), 'archive.people': rule(2), 'archive.tickets': rule(2) });
  surface(reads);
  const [primary, secondary] = await Promise.all([reads.query(query('people')), reads.query(query('archive.people'))]);
  assert.equal(primary.rows[0].name, 'operations one');
  assert.equal(secondary.rows[0].name, 'archive two');
  assert.equal(await reads.count('tickets'), 2);
  assert.equal(await reads.count('archive.tickets'), 1);
  const result = await reads.runView(view('archive.tickets'));
  assert.deepEqual(result.rows, [{ id: 2, 'owner_id.name': 'archive two' }]);
  assert.deepEqual(
    result.resolved.map((column) => column.table),
    ['archive.tickets', 'archive.people'],
  );
  assert.equal(result.joins[0].table, 'archive.people');
  assert.equal(await reads.countView(view('archive.tickets')), 1);
  const grouped = { base: 'archive.tickets', by: [{ path: 'owner_id.name' }], measures: [{ fn: 'count' as const }] };
  assert.equal((await reads.runBreakdown(grouped)).rows[0]['owner_id.name'], 'archive two');
  assert.equal(await reads.countBreakdown(grouped), 1);
});

test('missing rules deny base rows and joined/aggregate children without denying their parents', async (t) => {
  const { runtime } = await fixture(t);
  const app = runtime();
  const reads = await app.adapter.scopeReads!({ 'archive.people': true });
  const aggregate: ViewDef = {
    id: 'counts',
    name: 'Counts',
    base: 'archive.people',
    columns: [{ path: 'id' }],
    aggregates: [{ fn: 'count', via: 'archive.tickets.owner_id' }],
  };
  const result = await reads.runView(aggregate);
  assert.deepEqual(result.rows, [
    { id: 1, 'count(archive.tickets)': 0 },
    { id: 2, 'count(archive.tickets)': 0 },
  ]);
  assert.deepEqual(result.resolved, (await app.adapter.runView!(aggregate)).resolved);
  assert.equal(await reads.countView(aggregate), 2);
  assert.equal(await reads.count('people'), 0);
  assert.equal(await reads.count('archive.tickets'), 0);
  const joined = await app.adapter.scopeReads!({ 'archive.tickets': true, 'archive.people': false });
  assert.equal(
    (await joined.runView(view('archive.tickets'))).rows.every((row) => row['owner_id.name'] === null),
    true,
  );
  const none = await app.adapter.scopeReads!({});
  assert.deepEqual((await none.query(query('archive.people'))).rows, []);
  const total = { base: 'archive.people', by: [], measures: [{ fn: 'count' as const }] };
  assert.equal(await none.countBreakdown(total), 1, 'Ungrouped empty aggregate still produces a group');
});

test('strict whole-scope validation runs before any source binds, including unused rules', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  let bindings = 0;
  for (const source of Object.values(sources)) {
    const bind = source.adapter.scopeReads!.bind(source.adapter);
    source.adapter.scopeReads = async (scope) => {
      bindings++;
      return bind(scope);
    };
  }
  const app = runtime();
  for (const scope of [
    { people: true, 'archive.unknown': true },
    { people: true, 'archive.people': { groups: [[{ column: 'missing', op: '=', value: 1 }]] } },
    { people: true, 'archive.tickets': { groups: [] } },
    { 'operations.people': true },
    { physical_person: true },
    { 'archive.physical_person': true },
    Object.create({ people: true }),
    Object.defineProperty({}, 'people', {
      enumerable: true,
      get() {
        throw new Error('getter invoked');
      },
    }),
  ])
    await assert.rejects(app.adapter.scopeReads!(scope as RowScope), Refusal);
  const logicalCases: RowScope[] = [{ physical_person: true }, { people: true, tickets: { groups: [] } }];
  for (const scope of logicalCases) {
    await assert.rejects(logical().adapter.scopeReads!(scope), Refusal);
  }
  assert.equal(bindings, 0);
});

test('unsupported scoped sources refuse binding without any ordinary read fallback', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  let bindings = 0;
  const bind = sources.operations.adapter.scopeReads!.bind(sources.operations.adapter);
  sources.operations.adapter.scopeReads = async (scope) => {
    bindings++;
    return bind(scope);
  };
  sources.archive.adapter.scopeReads = undefined;
  const app = runtime();
  await assert.rejects(app.adapter.scopeReads!({ people: true }), /archive.*scoped reads/);
  assert.equal(bindings, 0, 'All source capabilities are checked before binding any source');
  const reads = await app.forSource('operations').scopeReads!({ people: true });
  assert.equal(await reads.count('people'), 2, 'Explicit anchor needs only that source capability');
  assert.equal(app.forSource('archive').scopeReads, undefined);
  sources.operations.adapter.scopeReads = undefined;
  assert.equal(logical().adapter.scopeReads, undefined);
  assert.equal(runtime().adapter.scopeReads, undefined);
});

test('source anchors refuse foreign scope entries and every foreign read operation', async (t) => {
  const { runtime } = await fixture(t);
  const anchored = runtime().forSource('archive');
  await assert.rejects(anchored.scopeReads!({ people: true, 'archive.people': true }), Refusal);
  await assert.rejects(anchored.scopeReads!({ people: true }), Refusal);
  const reads = await anchored.scopeReads!({ 'archive.people': true, 'archive.tickets': true });
  surface(reads);
  assert.equal(await reads.count('archive.people'), 2);
  const breakdown = { base: 'people', by: [], measures: [{ fn: 'count' as const }] };
  for (const run of [
    () => reads.query(query('people')),
    () => reads.count('people'),
    () => reads.runView(view('tickets')),
    () => reads.countView(view('tickets')),
    () => reads.runBreakdown(breakdown),
    () => reads.countBreakdown(breakdown),
  ])
    await assert.rejects(async () => run(), /belongs to source/);
});

test('captured combined scopes survive mutation before a later source binds and interleaved handles', async (t) => {
  const { sources, runtime } = await fixture(t);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bind = sources.operations.adapter.scopeReads!.bind(sources.operations.adapter);
  sources.operations.adapter.scopeReads = async (scope) => {
    await paused;
    return bind(scope);
  };
  const app = runtime();
  const firstRule = rule(1);
  const sourceRule = rule(2);
  const input: Record<string, boolean | Filter> = { people: firstRule, 'archive.people': sourceRule };
  const pending = app.adapter.scopeReads!(input);
  firstRule.groups[0][0].value = 2;
  sourceRule.groups[0][0].value = 1;
  input['archive.tickets'] = true;
  delete input.people;
  release();
  const first = await pending;
  const second = await app.adapter.scopeReads!({ people: rule(2), 'archive.people': rule(1) });
  const answers = await Promise.all([
    first.query(query('people')),
    second.query(query('people')),
    first.query(query('archive.people')),
    second.query(query('archive.people')),
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.rows[0].name),
    ['operations one', 'operations two', 'archive two', 'archive one'],
  );
  assert.equal(await first.count('archive.tickets'), 0);
  assert.equal(await app.adapter.count('people'), 2);
});

test('logical-only scopes are snapshotted before asynchronous physical binding', async (t) => {
  const { sources, logical } = await fixture(t);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bind = sources.operations.adapter.scopeReads!.bind(sources.operations.adapter);
  sources.operations.adapter.scopeReads = async (scope) => {
    await paused;
    return bind(scope);
  };
  const filter = rule(1);
  const input: Record<string, boolean | Filter> = { people: filter };
  const pending = logical().adapter.scopeReads!(input);
  filter.groups[0][0].value = 2;
  input.tickets = true;
  release();
  const reads = await pending;
  assert.equal((await reads.query(query('people'))).rows[0].name, 'operations one');
  assert.equal(await reads.count('tickets'), 0);
});

test('binding maps entire scopes to physical IDs and strips extra downstream capabilities', async (t) => {
  const { sources, runtime, logical } = await fixture(t);
  const seen = new Map<string, RowScope>();
  for (const [name, source] of Object.entries(sources)) {
    const bind = source.adapter.scopeReads!.bind(source.adapter);
    source.adapter.scopeReads = async (scope) => {
      seen.set(name, scope);
      assert.equal(Object.isFrozen(scope), true);
      const reads = await bind(scope);
      return {
        ...reads,
        close: source.adapter.close,
        runSql: source.adapter.runSql,
        transaction: source.adapter.transaction,
        scopeReads: source.adapter.scopeReads,
      };
    };
  }
  const reads = await runtime().adapter.scopeReads!({
    people: rule(1),
    tickets: false,
    'archive.people': rule(2),
    'archive.tickets': true,
  });
  surface(reads);
  assert.deepEqual(Object.keys(seen.get('operations')!), ['physical_person', 'physical_ticket']);
  assert.deepEqual(Object.keys(seen.get('archive')!), ['physical_person', 'physical_ticket']);
  assert.equal(seen.get('operations')!.physical_ticket, false);
  assert.equal(seen.get('archive')!.physical_ticket, true);
  assert.equal((seen.get('operations')!.physical_person as Filter).groups[0][0].value, 1);
  assert.equal((seen.get('archive')!.physical_person as Filter).groups[0][0].value, 2);
  const localReads = await logical().adapter.scopeReads!({ people: rule(1) });
  surface(localReads);
  assert.deepEqual(Object.keys(seen.get('operations')!), ['physical_person']);
  for (const capability of [reads, localReads]) {
    for (const table of ['missing', 'physical_person', 'operations.people', 'archive.physical_person']) {
      await assert.rejects(async () => capability.query(query(table)), Refusal);
      await assert.rejects(async () => capability.count(table), Refusal);
    }
  }
});
