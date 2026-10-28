import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  ANSI_STYLE,
  MYSQL_STYLE,
  POSTGRES_STYLE,
  Refusal,
  type Condition,
  type Filter,
  type QueryResult,
  type SqlFragment,
} from '../packages/engine/src/adapters/adapter.js';
import { createScopedReads } from '../packages/engine/src/adapters/scoped/scopedReads.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { compileView, compileViewCount, type ViewDef } from '../packages/engine/src/shared/view.js';
import { compileBreakdown, compileBreakdownCount, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { ScopedRelations, snapshotRowScope, type RowScope, type RowScopeFilter } from '../packages/engine/src/shared/rowScope.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { createTenantMembershipIssuer, type TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipInput } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { composeCounters, composePublicReadScope, composeTenantReadScope } from '../packages/mistri/src/server/tenant/tenantReadScope.js';
import type { TenantPublicEvidence } from '../packages/mistri/src/server/tenant/tenantPublicRead.js';
import {
  readRecords,
  readCount,
  readView,
  readBreakdown,
  ResourceReadError,
  type ResourceReader,
} from '../packages/engine/src/server/resourceReadOperations.js';

const eq = (column: string, value: string | number): RowScopeFilter => ({ groups: [[{ column, op: '=', value }]] });
const view = (patch: Partial<ViewDef> = {}): ViewDef => ({
  id: 'items',
  name: 'Items',
  base: 'items',
  columns: [{ path: 'id' }],
  orderBy: [{ path: 'id', direction: 'asc' }],
  limit: 100,
  ...patch,
});
const breakdown = (patch: Partial<BreakdownDef> = {}): BreakdownDef => ({
  base: 'items',
  by: [{ path: 'status' }],
  measures: [
    { fn: 'count', alias: 'n' },
    { fn: 'sum', path: 'amount', alias: 'total' },
  ],
  orderBy: [{ name: 'status', direction: 'asc' }],
  limit: 100,
  ...patch,
});
const member = (): TenantMembershipEvidence => ({
  appId: 'tenant-proof',
  accountId: 'alice',
  tenantId: 'north',
  source: { id: 'business', connection: 'owned-source' },
  deployment: 'generation-1',
  membershipId: 'membership-1',
  membershipVersion: '9007199254740993',
  tenantVersion: '2',
  roles: ['reviewer'],
  verifiedAt: 1000,
  validUntil: 6000,
});

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE countries (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL COLLATE NOCASE);
    CREATE TABLE people (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE RTRIM, name TEXT NOT NULL);
    CREATE TABLE items (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE,
      owner_id INTEGER REFERENCES people(id), country_code TEXT REFERENCES countries(code),
      status TEXT NOT NULL COLLATE NOCASE, amount INTEGER NOT NULL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE,
      item_id INTEGER REFERENCES items(id), amount INTEGER NOT NULL);
    INSERT INTO countries VALUES ('us', 'USA'), ('ca', 'Canada');
    INSERT INTO people VALUES (1, 'north', 'Visible'), (2, 'North', 'Hidden case'),
      (3, 'north ', 'Hidden padding'), (4, 'south', 'Hidden south');
    INSERT INTO items VALUES (1, 'north', 1, 'us', 'open', 10), (2, 'north', 2, 'ca', 'closed', 20),
      (3, 'north', 3, 'us', 'open', 30), (4, 'north', NULL, 'ca', 'open', 40),
      (5, 'North', 1, 'us', 'open', 900), (6, 'north ', 1, 'us', 'open', 900),
      (7, 'south', 1, 'us', 'open', 900), (8, 'north', 4, 'us', 'OPEN', 50);
    INSERT INTO notes VALUES (1, 'north', 1, 5), (2, 'North', 1, 900),
      (3, 'north ', 1, 900), (4, 'south', 1, 900), (5, 'north', 5, 800);`);
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  const ownership: TenantOwnershipInput = {
    appId: 'tenant-proof',
    source: { id: 'business', connection: 'owned-source' },
    schema,
    physicalSchema: structuredClone(schema),
    resources: { items: 'items', people: 'people', notes: 'notes', countries: 'countries' },
    ownership: {
      items: { kind: 'tenant', column: 'tenant_id' },
      people: { kind: 'tenant', column: 'tenant_id' },
      notes: { kind: 'tenant', column: 'tenant_id' },
      countries: { kind: 'global', access: 'read-only' },
    },
  };
  const allow: RowScope = { items: true, people: true, notes: true, countries: true };
  const compose = (membership: RowScope = allow, authored: RowScope = allow) =>
    composeTenantReadScope(ownership, member(), membership, authored);
  const rows = (statement: SqlFragment) =>
    db
      .prepare(statement.text)
      .all(...(statement.params as SQLInputValue[]))
      .map((row) => ({ ...row }));
  const count = (statement: SqlFragment) => rows(statement)[0].n;
  const execute = async (statement: SqlFragment): Promise<QueryResult> => ({ rows: rows(statement), columns: [], ms: 0, sql: statement });
  return { db, schema, ownership, allow, compose, rows, count, execute };
}

function denied(work: () => unknown) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof TenantContextError);
    assert.equal(error.code, 'tenant_context_unavailable');
    assert.equal(error.message, 'The tenant context could not be verified.');
    assert.equal('cause' in error, false);
    return true;
  });
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

test('issuer evidence composes compiler data only; no membership or data capability is created', async (t) => {
  const f = fixture(t);
  const accepted = createTenantMembershipIssuer({
    ownership: f.ownership,
    deployment: 'generation-1',
    roles: ['reviewer'],
    maxLifetimeMs: 5000,
    now: () => 1000,
    verifySession: () => ({ id: 'alice', who: 'Alice' }),
    membership: {
      source: f.ownership.source,
      read: () => ({
        appId: 'tenant-proof',
        accountId: 'alice',
        tenantId: 'north',
        tenantStatus: 'active' as const,
        tenantVersion: '2',
        membershipId: 'membership-1',
        membershipVersion: '1',
        status: 'active' as const,
        roles: ['reviewer'],
        validUntil: 6000,
      }),
    },
  });
  try {
    const scope = await accepted.withMembership({}, ['north'], (evidence) =>
      composeTenantReadScope(f.ownership, evidence, f.allow, f.allow),
    );
    frozen(scope);
    assert.deepEqual(Object.keys(scope).sort(), ['countries', 'items', 'notes', 'people']);
    assert.equal(scope.countries, true);
    assert.deepEqual(
      f.rows(compileView(f.schema, view(), ANSI_STYLE, 0, scope)),
      [1, 2, 3, 4, 8].map((id) => ({ id })),
    );
  } finally {
    await accepted.retire();
  }
});

test('base query/count compare tenants exactly despite NOCASE and RTRIM declarations', async (t) => {
  const f = fixture(t),
    scope = f.compose();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ?').get('north')!.n, 6);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people WHERE tenant_id = ?').get('north')!.n, 2);
  const reader = createScopedReads(f.schema, scope, ANSI_STYLE, f.execute);
  assert.deepEqual(
    (await reader.query({ table: 'items', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows,
    [1, 2, 3, 4, 8].map((id) => ({ id })),
  );
  assert.equal(await reader.count('items'), 5);
  assert.deepEqual((await reader.query({ table: 'people', columns: ['id'], limit: 100, offset: 0 })).rows, [{ id: 1 }]);
  assert.equal(await reader.count('people'), 1);
});

test('LEFT JOIN targets hide case/padding/foreign tenants without dropping visible base rows', (t) => {
  const f = fixture(t),
    def = view({ columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'owner' }, { path: 'country_code.name', alias: 'country' }] });
  assert.deepEqual(f.rows(compileView(f.schema, def, ANSI_STYLE, 0, f.compose())), [
    { id: 1, owner: 'Visible', country: 'USA' },
    { id: 2, owner: null, country: 'Canada' },
    { id: 3, owner: null, country: 'USA' },
    { id: 4, owner: null, country: 'Canada' },
    { id: 8, owner: null, country: 'USA' },
  ]);
  const filtered = { ...def, filter: { groups: [[{ path: 'owner_id.name', op: 'isNull' as const }]] } };
  assert.equal(f.count(compileViewCount(f.schema, filtered, ANSI_STYLE, f.compose())), 4);
});

test('reverse counts and sums cannot recover differently collated tenant children', (t) => {
  const f = fixture(t);
  const via = f.schema.foreignKeys.find((fk) => fk.from.table === 'notes')!.name;
  const def = view({
    aggregates: [
      { fn: 'count', via, alias: 'notes' },
      { fn: 'sum', via, column: 'amount', alias: 'total' },
    ],
  });
  assert.deepEqual(f.rows(compileView(f.schema, def, ANSI_STYLE, 0, f.compose())), [
    { id: 1, notes: 1, total: 5 },
    ...[2, 3, 4, 8].map((id) => ({ id, notes: 0, total: null })),
  ]);
  assert.equal(f.count(compileViewCount(f.schema, def, ANSI_STYLE, f.compose())), 5);
  const deniedChildren = f.compose({ ...f.allow, notes: false });
  assert.deepEqual(
    f.rows(compileView(f.schema, def, ANSI_STYLE, 0, deniedChildren)),
    [1, 2, 3, 4, 8].map((id) => ({ id, notes: 0, total: null })),
  );
});

test('view/breakdown readers and counts preserve scope across pagination and joined aggregates', async (t) => {
  const f = fixture(t),
    reader = createScopedReads(f.schema, f.compose(), ANSI_STYLE, f.execute);
  assert.deepEqual((await reader.runView(view({ limit: 2 }), 1)).rows, [{ id: 2 }, { id: 3 }]);
  assert.equal(await reader.countView(view({ limit: 2 })), 5);
  const def = breakdown({
    by: [{ path: 'owner_id.name', alias: 'owner' }],
    measures: [
      { fn: 'count', alias: 'n' },
      { fn: 'sum', path: 'amount', alias: 'total' },
      { fn: 'count', path: 'owner_id.id', distinct: true, alias: 'owners' },
    ],
    orderBy: [{ name: 'owner', direction: 'asc' }],
    limit: 1,
  });
  assert.deepEqual((await reader.runBreakdown(def)).rows, [{ owner: null, n: 4, total: 140, owners: 0 }]);
  assert.deepEqual((await reader.runBreakdown(def, 1)).rows, [{ owner: 'Visible', n: 1, total: 10, owners: 1 }]);
  assert.equal(await reader.countBreakdown(def), 2);
});

test('ownership AND both policy ORs AND hostile request OR remain intersected before count/paging', (t) => {
  const f = fixture(t);
  const scope = f.compose(
    { ...f.allow, items: { groups: [[{ column: 'id', op: '=', value: 1 }], [{ column: 'amount', op: '>=', value: 30 }]] } },
    { ...f.allow, items: { groups: [[{ column: 'id', op: '=', value: 3 }], [{ column: 'id', op: 'in', value: [4, 5, 6, 7] }]] } },
  );
  const policy = scope.items as RowScopeFilter;
  assert.equal(policy.groups.length, 4);
  for (const group of policy.groups) assert.deepEqual({ ...group[0] }, { column: 'tenant_id', op: '=', value: 'north' });
  const def = view({
    filter: { groups: [[{ path: 'tenant_id', op: '=', value: 'North' }], [{ path: 'id', op: 'in', value: [3, 4, 5, 6, 7] }]] },
    limit: 1,
  });
  assert.deepEqual(f.rows(compileView(f.schema, def, ANSI_STYLE, 0, scope)), [{ id: 3 }]);
  assert.deepEqual(f.rows(compileView(f.schema, def, ANSI_STYLE, 1, scope)), [{ id: 4 }]);
  assert.equal(f.count(compileViewCount(f.schema, def, ANSI_STYLE, scope)), 2);
});

for (const side of ['membership', 'authored'] as const)
  for (const value of [undefined, false] as const) {
    test(`${side} missing/false (${value}) denies tenant and global resources`, (t) => {
      const f = fixture(t);
      const deny: RowScope = value === undefined ? {} : { items: false, countries: false };
      const scope = side === 'membership' ? f.compose(deny) : f.compose(f.allow, deny);
      assert.equal(scope.items, false);
      assert.equal(scope.countries, false);
      assert.deepEqual(f.rows(compileView(f.schema, view(), ANSI_STYLE, 0, scope)), []);
      assert.equal(
        f.count(compileViewCount(f.schema, view({ base: 'countries', columns: [{ path: 'code' }], orderBy: [] }), ANSI_STYLE, scope)),
        0,
      );
      assert.deepEqual(f.rows(compileBreakdown(f.schema, breakdown(), ANSI_STYLE, 0, scope)), []);
      assert.equal(f.count(compileBreakdownCount(f.schema, breakdown(), ANSI_STYLE, scope)), 0);
      assert.deepEqual(f.rows(compileBreakdown(f.schema, breakdown({ by: [], orderBy: [] }), ANSI_STYLE, 0, scope)), [
        { n: 0, total: null },
      ]);
    });
  }

test('explicit read-only globals still intersect both ordinary policies', (t) => {
  const f = fixture(t),
    def = view({ base: 'countries', columns: [{ path: 'code' }], orderBy: [{ path: 'code', direction: 'asc' }] });
  const scope = f.compose({ ...f.allow, countries: eq('code', 'us') }, { ...f.allow, countries: eq('name', 'USA') });
  assert.deepEqual(f.rows(compileView(f.schema, def, ANSI_STYLE, 0, scope)), [{ code: 'us' }]);
  assert.equal(f.count(compileViewCount(f.schema, def, ANSI_STYLE, scope)), 1);
  assert.equal('write' in scope || 'transaction' in scope, false);
  const conflicting = f.compose({ ...f.allow, countries: eq('code', 'us') }, { ...f.allow, countries: eq('code', 'ca') });
  assert.equal(f.count(compileViewCount(f.schema, def, ANSI_STYLE, conflicting)), 0);
});

test('composition preserves and merges marked columns without changing either policy semantics', (t) => {
  const f = fixture(t);
  const a: RowScope = { ...f.allow, items: { ...eq('status', 'open'), binary: ['status'] } };
  const b: RowScope = { ...f.allow, items: { ...eq('tenant_id', 'north'), binary: ['tenant_id', 'status'] } };
  const scope = f.compose(a, b);
  assert.deepEqual((scope.items as RowScopeFilter).binary, ['tenant_id', 'status']);
  assert.deepEqual(
    f.rows(compileView(f.schema, view(), ANSI_STYLE, 0, scope)),
    [1, 3, 4].map((id) => ({ id })),
  );
});

test('unmarked conditions cannot silently change semantics when another layer imposes binary comparison', (t) => {
  const f = fixture(t);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM items WHERE tenant_id = 'north' COLLATE BINARY AND tenant_id != 'North'").get()!.n,
    0,
  );
  for (const op of ['=', '!=', '>', '<', 'in'] as const) {
    const unmarked: RowScope = { ...f.allow, items: { groups: [[{ column: 'tenant_id', op, value: op === 'in' ? ['North'] : 'North' }]] } };
    denied(() => f.compose(unmarked));
    denied(() => f.compose(f.allow, unmarked));
  }
  const marked: RowScope = { ...f.allow, items: { ...eq('status', 'open'), binary: ['status'] } };
  const unmarked: RowScope = { ...f.allow, items: { groups: [[{ column: 'status', op: '!=', value: 'OPEN' }]] } };
  denied(() => f.compose(marked, unmarked));
  denied(() => f.compose(unmarked, marked));
});

test('all input boundaries detach before later mutation, including binary/IN metadata and catalog ownership', (t) => {
  const f = fixture(t),
    evidence = member();
  const values = [1, 3];
  const binary = ['status'];
  const policy: RowScopeFilter = { groups: [[{ column: 'id', op: 'in', value: values }]], binary };
  const membership = { ...f.allow, items: policy },
    authored = { ...f.allow };
  const scope = composeTenantReadScope(f.ownership, evidence, membership, authored);
  frozen(scope);
  values.push(5);
  binary.push('id');
  policy.groups.push([{ column: 'id', op: '=', value: 7 }]);
  Reflect.set(evidence, 'tenantId', 'south');
  Reflect.set(evidence.source, 'connection', 'other');
  Reflect.set(f.ownership.ownership, 'items', { kind: 'global', access: 'read-only' });
  Reflect.set(membership, 'items', true);
  Reflect.set(authored, 'items', false);
  const saved = scope.items as RowScopeFilter;
  assert.deepEqual(saved.binary, ['tenant_id', 'status']);
  assert.deepEqual(f.rows(compileView(f.schema, view(), ANSI_STYLE, 0, scope)), [{ id: 1 }, { id: 3 }]);
  assert.throws(() => saved.groups.push([]), TypeError);
});

for (const patch of [
  { appId: 'other' },
  { source: { id: 'other', connection: 'owned-source' } },
  { source: { id: 'business', connection: 'other' } },
  { tenantId: 'North' },
  { tenantId: 'north ' },
  { tenantId: '' },
  { tenantId: 'north\0' },
  { tenantId: 'north\n' },
  { tenantId: "north' OR 1=1--" },
  { tenantId: 'n'.repeat(129) },
  { tenantId: 1 },
]) {
  test(`incompatible evidence binding/canonical ID refuses: ${JSON.stringify(patch)}`, (t) => {
    const f = fixture(t);
    denied(() => composeTenantReadScope(f.ownership, { ...member(), ...patch } as TenantMembershipEvidence, f.allow, f.allow));
  });
}

test('catalog, ownership, source and dialect substitutions refuse rather than produce a scope', (t) => {
  const f = fixture(t);
  for (const mutate of [
    (input: TenantOwnershipInput) => {
      input.schema.dialect = 'postgres';
    },
    (input: TenantOwnershipInput) => {
      input.physicalSchema.dialect = 'mysql';
    },
    (input: TenantOwnershipInput) => {
      input.schema.tables.find((table) => table.id === 'items')!.columns.pop();
    },
    (input: TenantOwnershipInput) => {
      Reflect.set(input.resources, 'items', 'people');
    },
    (input: TenantOwnershipInput) => {
      Reflect.deleteProperty(input.ownership, 'countries');
    },
    (input: TenantOwnershipInput) => {
      Reflect.set(input.ownership, 'countries', { kind: 'global', access: 'write' });
    },
    (input: TenantOwnershipInput) => {
      Reflect.set(input.ownership, 'items', { kind: 'tenant', column: 'missing' });
    },
    (input: TenantOwnershipInput) => {
      input.physicalSchema.tables[0].schema = 'attached';
    },
  ]) {
    const altered = structuredClone(f.ownership);
    mutate(altered);
    denied(() => composeTenantReadScope(altered, member(), f.allow, f.allow));
  }
});

test('malformed unused rules refuse even when the opposite policy denies everything', (t) => {
  const f = fixture(t);
  for (const bad of [
    null,
    [],
    {},
    { groups: [] },
    { groups: [[]] },
    { groups: '' },
    { groups: [{}] },
    { groups: [[{ column: 'id', op: 'isNull', value: 1 }]] },
    { groups: [[{ column: 'id', op: '=', value: NaN }]] },
    { groups: [[{ column: 'id', op: '= 1 OR 1 =', value: 1 }]] },
    eq('unknown', 'secret'),
    { ...eq('id', 1), extra: true },
    { ...eq('id', 1), binary: ['unknown'] },
  ]) {
    const input = { ...f.allow, notes: bad } as RowScope;
    denied(() => f.compose(input, {}));
    denied(() => f.compose({}, input));
  }
  denied(() => f.compose({ ...f.allow, unknown: false }));
});

test('proxies/getters/inherited rules/symbols/sparse/cyclic data refuse without executing code', (t) => {
  const f = fixture(t);
  let calls = 0;
  const getter = Object.defineProperty({}, 'items', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  const proxy = new Proxy(f.allow, {
    ownKeys() {
      calls++;
      throw new Error('PRIVATE');
    },
  });
  const nestedProxy = new Proxy(eq('id', 1), {
    getPrototypeOf() {
      calls++;
      return Object.prototype;
    },
  });
  const sparse: unknown[] = [];
  sparse.length = 1;
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const hostile: unknown[] = [
    getter,
    proxy,
    { items: nestedProxy },
    Object.create(f.allow),
    { ...f.allow, [Symbol('private')]: true },
    { items: { groups: sparse } },
    { items: { groups: cyclic } },
    { items: { ...eq('id', 1), binary: sparse } },
  ];
  for (const input of hostile) {
    denied(() => f.compose(input as RowScope));
    denied(() => f.compose(f.allow, input as RowScope));
  }
  for (const position of ['ownership', 'evidence'] as const) {
    const args = { ownership: f.ownership, evidence: member() };
    Reflect.set(
      args,
      position,
      new Proxy(args[position], {
        ownKeys() {
          calls++;
          throw new Error('PRIVATE');
        },
      }),
    );
    denied(() => composeTenantReadScope(args.ownership, args.evidence, f.allow, f.allow));
  }
  assert.equal(calls, 0);
});

test('OR expansion refuses condition/group/node/character overflow before producing any partial scope', (t) => {
  const f = fixture(t);
  const alternatives = (n: number): RowScope => ({
    items: { groups: Array.from({ length: n }, (_, value) => [{ column: 'id', op: '=', value }]) },
  });
  denied(() => f.compose(alternatives(128), alternatives(128)));
  denied(() => f.compose(alternatives(32), alternatives(32)));
  denied(() =>
    f.compose({ items: { groups: [[{ column: 'id', op: 'in', value: Array.from({ length: 1000 }, (_, n) => n) }]] } }, alternatives(20)),
  );
  denied(() => f.compose({ items: eq('status', 'x'.repeat(5000)) }, alternatives(60)));
  const legal = f.compose(alternatives(16), alternatives(16));
  assert.equal((legal.items as RowScopeFilter).groups.length, 256);
  const boundary = f.compose(alternatives(1024), { items: true });
  assert.equal((boundary.items as RowScopeFilter).groups.length, 1024);
  denied(() => f.compose(alternatives(1025), { items: true }));
  denied(() => f.compose({ items: { groups: Array.from({ length: 4097 }, () => [{ column: 'id', op: '=', value: 1 }]) } }));
});

test('overflow preflight never enters Cartesian materialization, including later resources', (t) => {
  const f = fixture(t);
  const original = Array.prototype.flatMap;
  const materialize = t.mock.method({ flatMap: original }, 'flatMap');
  const alternatives: RowScopeFilter = { groups: Array.from({ length: 32 }, (_, value) => [{ column: 'id', op: '=', value }]) };
  Array.prototype.flatMap = materialize;
  try {
    denied(() => f.compose({ ...f.allow, notes: alternatives }, { ...f.allow, notes: alternatives }));
    assert.equal(materialize.mock.callCount(), 0);
    f.compose({ ...f.allow, notes: eq('id', 1) });
    assert.ok(materialize.mock.callCount() > 0, 'the probe observes legal materialization');
  } finally {
    Array.prototype.flatMap = original;
  }
});

test('binary metadata validates exact columns, duplicates, dialect and all nested descriptor bounds', (t) => {
  const f = fixture(t);
  const valid = { items: { ...eq('id', 1), binary: ['tenant_id'] } };
  const snapshot = snapshotRowScope(f.schema, valid);
  frozen(snapshot);
  for (const binary of [
    null,
    undefined,
    '',
    {},
    ['missing'],
    ['TENANT_ID'],
    ['tenant_id COLLATE NOCASE'],
    ['tenant_id', 'tenant_id'],
    [1],
    Array.from({ length: 4097 }, () => 'tenant_id'),
  ]) {
    assert.throws(() => snapshotRowScope(f.schema, { items: { ...eq('id', 1), binary } } as RowScope), Refusal);
  }
  for (const [dialect, style] of [
    ['postgres', POSTGRES_STYLE],
    ['mysql', MYSQL_STYLE],
  ] as const) {
    const schema = { ...f.schema, dialect };
    assert.throws(() => snapshotRowScope(schema, valid), Refusal);
    assert.throws(() => compileView(schema, view(), style, 0, valid), Refusal);
    assert.throws(() => snapshotRowScope(schema, { items: { ...eq('id', 1), binary: [] } }), Refusal);
  }
});

test('unmarked scopes keep original SQL/bindings and collation behavior; LIKE is not redefined', (t) => {
  const f = fixture(t),
    scope = { items: eq('tenant_id', 'north') };
  const relations = new ScopedRelations(f.schema, ANSI_STYLE, scope);
  relations.table('items');
  const columns = f.schema.tables
    .find((table) => table.id === 'items')!
    .columns.map((column) => ANSI_STYLE.quote(column.name))
    .join(', ');
  assert.deepEqual(relations.finish(), {
    text: `WITH "_tw_scope$1" AS (SELECT ${columns} FROM "main"."items" WHERE "tenant_id" = ?)\n`,
    params: ['north'],
  });
  assert.equal(f.count(compileViewCount(f.schema, view(), ANSI_STYLE, scope)), 6);
  const marked = { items: { ...scope.items, binary: ['tenant_id'] } };
  assert.equal(f.count(compileViewCount(f.schema, view(), ANSI_STYLE, marked)), 5);
  const like: RowScope = { items: { groups: [[{ column: 'status', op: 'like', value: 'open' }]], binary: ['status'] } };
  assert.equal(f.count(compileViewCount(f.schema, view(), ANSI_STYLE, like)), 7);
});

test('ordinary resource request filters reject private binary metadata before any adapter work', async (t) => {
  const f = fixture(t);
  let work = 0;
  const refuse = async (): Promise<never> => {
    work++;
    throw new Error('must not run');
  };
  const reader: ResourceReader = {
    query: refuse,
    count: refuse,
    estimateCount: refuse,
    runView: refuse,
    countView: refuse,
    runBreakdown: refuse,
    countBreakdown: refuse,
  };
  const filter: Filter = { ...eq('id', 1), binary: ['id'] } as RowScopeFilter;
  const paths = { groups: [[{ path: 'id', op: '=' as const, value: 1 }]], binary: ['id'] };
  for (const read of [
    () => readRecords(reader, f.schema, { table: 'items', filter }, 'estimate'),
    () => readCount(reader, f.schema, { table: 'items', filter }),
    () => readView(reader, f.schema, view({ filter: paths })),
    () => readBreakdown(reader, f.schema, breakdown({ filter: paths })),
  ])
    await assert.rejects(read, (error: unknown) => error instanceof ResourceReadError && error.status === 400);
  assert.equal(work, 0);
});

// Private metadata must not widen the ordinary Filter definition itself.
function typesOnly(condition: Condition) {
  const ordinary: Filter = {
    groups: [[condition]],
    // @ts-expect-error Binary collation belongs only to private RowScopeFilter.
    binary: ['tenant_id'],
  };
  return ordinary;
}
void typesOnly;

/* A visitor's scope (tenantPublicRead.ts): the runtime adds the tenant to every
   group the policy's callback returns, so no callback — an `or`, a `true`, a
   condition on the owner column — reads past the tenant the address placed. */
const visitor = (tenantId: string): TenantPublicEvidence => ({
  realm: 'public',
  appId: 'tenant-proof',
  source: { id: 'business', connection: 'owned-source' },
  deployment: 'generation-1',
  tenantId,
  tenantVersion: '2',
  platformVersion: '1',
  column: 'public_address',
  address: 'north-public-AAAAAAAAAAAAAAAA',
  verifiedAt: 1000,
  validUntil: 6000,
});

test('a public scope reads one tenant exactly, denies unnamed tables, and passes global rows through the callback', async (t) => {
  const f = fixture(t);
  const scope = composePublicReadScope(f.ownership, visitor('north'), { items: true, countries: eq('code', 'us') });
  frozen(scope);
  assert.equal(scope.people, false, 'a table the callback does not name is denied');
  assert.equal(scope.notes, false);
  const reader = createScopedReads(f.schema, scope, ANSI_STYLE, f.execute);
  // Exactly 'north': not 'North', not 'north ', not 'south', whatever the column's collation.
  assert.deepEqual(
    (await reader.query({ table: 'items', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows,
    [1, 2, 3, 4, 8].map((id) => ({ id })),
  );
  assert.equal(await reader.count('people'), 0);
  assert.deepEqual((await reader.query({ table: 'countries', columns: ['code'], limit: 100, offset: 0 })).rows, [{ code: 'us' }]);
  // An `or` in the callback cannot reach another tenant's row: every group carries the tenant.
  const widened = composePublicReadScope(f.ownership, visitor('north'), {
    items: { groups: [[{ column: 'status', op: '=', value: 'closed' }], [{ column: 'id', op: '=', value: 7 }]] },
  });
  const wide = createScopedReads(f.schema, widened, ANSI_STYLE, f.execute);
  assert.deepEqual((await wide.query({ table: 'items', columns: ['id'], limit: 100, offset: 0 })).rows, [{ id: 2 }]);
  // A condition on the owner column without its exact comparison is refused, never widened.
  denied(() =>
    composePublicReadScope(f.ownership, visitor('north'), { items: { groups: [[{ column: 'tenant_id', op: '!=', value: 'south' }]] } }),
  );
  // Evidence for another App, or not a visitor's, is refused.
  denied(() => composePublicReadScope(f.ownership, { ...visitor('north'), appId: 'other' }, { items: true }));
  denied(() => composePublicReadScope(f.ownership, { ...visitor('north'), realm: 'tenant' } as never, { items: true }));
  denied(() => composePublicReadScope(f.ownership, visitor('north'), { items: true, ghost: true }));
});

/* A composition is kept by what it is composed of (tenantReadScope.ts): the
   ownership, both layers as snapshots, and the tenant. Never the person, and
   never across tenants: the same layers for another tenant compose afresh. */
test('a kept composition is shared only by the same layers and the same tenant', (t) => {
  const f = fixture(t);
  const owned = captureTenantOwnership(f.ownership);
  const layer = snapshotRowScope(owned.schema, { ...f.allow, items: eq('status', 'open') });
  const all = snapshotRowScope(owned.schema, f.allow);
  const before = composeCounters.composed;
  const north = composeTenantReadScope(owned, member(), layer, all);
  // Another person of the same tenant, with the same layers: the same composition.
  assert.equal(composeTenantReadScope(owned, { ...member(), accountId: 'bob', membershipId: 'membership-2' }, layer, all), north);
  assert.equal(composeCounters.composed - before, 1);
  const south = composeTenantReadScope(owned, { ...member(), tenantId: 'south' }, layer, all);
  assert.notEqual(south, north);
  assert.equal(composeCounters.composed - before, 2);
  const tenantOf = (scope: RowScope) => (scope.items as RowScopeFilter).groups[0].find((c) => c.column === 'tenant_id')?.value;
  assert.equal(tenantOf(north), 'north');
  assert.equal(tenantOf(south), 'south');
  // Other layers compose their own, and a layer that is not a snapshot is composed every time.
  assert.notEqual(composeTenantReadScope(owned, member(), all, all), north);
  const plain = { ...f.allow, items: eq('status', 'open') };
  const counted = composeCounters.composed;
  composeTenantReadScope(owned, member(), plain, all);
  composeTenantReadScope(owned, member(), plain, all);
  assert.equal(composeCounters.composed - counted, 2);
});
