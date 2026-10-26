import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { tenantPagePlan, tenantReferences } from '../packages/mistri/src/server/tenant/tenantPageOperations.js';
import type { PageDef, PageSection } from '../packages/engine/src/shared/page.js';

const now = new Date('2026-09-08T12:00:00Z');
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const page = (...sections: PageSection[]): PageDef => ({ id: 'parent-page', name: 'Parent', base: 'parent', sections });
const childList = { kind: 'list' as const, from: 'child', path: 'parent_code', columns: ['id', 'name'] };
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.code, 'tenant_context_unavailable');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}
type Plan = Awaited<ReturnType<typeof tenantPagePlan>>;
function viewAt(result: Plan, index: number) {
  const section = result.plans[index];
  assert.ok('view' in section && section.view, `section ${index} must have a view`);
  return section.view;
}

/** These are helper/compiler tests, not enrollment or public authentication proof. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-page-ops-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  const adapter = new SqliteAdapter(path, 'Tenant page operations');
  t.after(async () => {
    try {
      await adapter.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE site(id TEXT NOT NULL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT);
    CREATE TABLE parent(id TEXT NOT NULL PRIMARY KEY, code TEXT UNIQUE,
      site_code TEXT REFERENCES site(code), name TEXT);
    CREATE TABLE child(id TEXT NOT NULL PRIMARY KEY, parent_code TEXT REFERENCES parent(code),
      name TEXT, amount INTEGER, at TEXT);
    CREATE TABLE child_pk(id TEXT NOT NULL PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
    CREATE TABLE grandchild(id TEXT NOT NULL PRIMARY KEY, child_id TEXT REFERENCES child(id), name TEXT);
    CREATE TABLE site_child(id TEXT NOT NULL PRIMARY KEY, site_code TEXT REFERENCES site(code), amount INTEGER);
    CREATE TABLE site_child_pk(id TEXT NOT NULL PRIMARY KEY, site_id TEXT REFERENCES site(id));
    CREATE TABLE composite_parent(id TEXT NOT NULL PRIMARY KEY, zone TEXT NOT NULL, code TEXT NOT NULL,
      UNIQUE(zone,code));
    CREATE TABLE composite_child(id TEXT NOT NULL PRIMARY KEY, zone TEXT, parent_code TEXT,
      FOREIGN KEY(zone,parent_code) REFERENCES composite_parent(zone,code));
    INSERT INTO site VALUES ('site-id-a','SITE-CODE-A','Site A'),('site-id-b','SITE-CODE-B','Site B');
    INSERT INTO parent VALUES ('parent-id-a','PARENT-CODE-A','SITE-CODE-A','Parent A'),
      ('parent-id-b','PARENT-CODE-B','SITE-CODE-B','Parent B'),('parent-null',NULL,NULL,'Null parent');
    INSERT INTO child VALUES ('child-a1','PARENT-CODE-A','A1',3,'2026-09-07'),
      ('child-a2','PARENT-CODE-A','A2',7,'2026-09-08'),('child-b','PARENT-CODE-B','B',900,'2026-09-08'),
      ('unrelated-null',NULL,'Not a child of the null-code parent',999,'2026-09-08');
    INSERT INTO child_pk VALUES ('pk-a','parent-id-a'),('pk-b','parent-id-b');
    INSERT INTO grandchild VALUES ('grand-a','child-a1','Grand A'),('grand-b','child-b','Grand B');
    INSERT INTO site_child VALUES ('site-a1','SITE-CODE-A',11),('site-a2','SITE-CODE-A',13),('site-b','SITE-CODE-B',900);
    INSERT INTO site_child_pk VALUES ('site-pk-a','site-id-a'),('site-pk-b','site-id-b');
    INSERT INTO composite_parent VALUES ('composite-a','north','same'),('composite-b','south','same'),
      ('composite-c','north','different');
    INSERT INTO composite_child VALUES ('composite-child-a','north','same'),('composite-child-b','south','same'),
      ('composite-child-c','north','different');`);
  const schema = await adapter.introspect();
  const reader = (overrides: Partial<Pick<Adapter, 'query' | 'count'>> = {}): Adapter => ({
    dialect: 'sqlite',
    introspect: adapter.introspect.bind(adapter),
    close: async () => {},
    query: adapter.query.bind(adapter),
    count: adapter.count.bind(adapter),
    ...overrides,
  });
  return { adapter, db, schema, reader };
}

test('alternate-unique root values anchor lists/counts/sums/breakdowns/timelines, not the caller PK', async (t) => {
  const f = await fixture(t),
    key = { id: 'parent-id-a' };
  const definition = page(
    childList,
    { kind: 'metric', from: 'child', path: 'parent_code', fn: 'count' },
    { kind: 'metric', from: 'child', path: 'parent_code', fn: 'sum', column: 'amount' },
    { kind: 'breakdown', from: 'child', path: 'parent_code', by: 'name' },
    { kind: 'timeline', streams: [{ from: 'child', path: 'parent_code', at: 'at', show: 'name' }] },
  );
  const before = structuredClone({ key, definition }),
    result = await tenantPagePlan(f.adapter, f.schema, definition, key, now);
  assert.deepEqual({ key, definition }, before);
  assert.deepEqual(plain(viewAt(result, 0).filter), { groups: [[{ path: 'parent_code', op: '=', value: 'PARENT-CODE-A' }]] });
  assert.deepEqual((await f.adapter.runView(viewAt(result, 0))).rows.map((row) => row.id).sort(), ['child-a1', 'child-a2']);
  assert.equal(await f.adapter.countView(viewAt(result, 1)), 2);
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 2))).rows.map((row) => [row.id, row.value]),
    [['parent-id-a', 10]],
  );
  const breakdown = result.plans[3];
  assert.ok(breakdown.kind === 'breakdown' && breakdown.breakdown);
  const groups = await f.adapter.runBreakdown(breakdown.breakdown);
  assert.deepEqual(groups.rows.map((row) => row.name).sort(), ['A1', 'A2']);
  const timeline = result.plans[4];
  assert.ok(timeline.kind === 'timeline' && timeline.streams[0].view);
  assert.deepEqual(
    (await f.adapter.runView(timeline.streams[0].view)).rows.map((row) => row.name),
    ['A2', 'A1'],
  );
});

test('about-parent lookup via unique code supplies actual parent PK and every relationship target key', async (t) => {
  const f = await fixture(t),
    definition = page(
      { kind: 'metric', from: 'site_child', path: 'site_code', of: 'site_code', fn: 'sum', column: 'amount' },
      { kind: 'list', from: 'site_child', path: 'site_code', of: 'site_code', columns: ['id'] },
      { kind: 'list', from: 'site_child_pk', path: 'site_id', of: 'site_code', columns: ['id'] },
      // A timeline stream's `about` is planned the same way, on the same scoped read.
      { kind: 'timeline', streams: [{ from: 'site_child', path: 'site_code', at: 'amount', show: 'id', of: 'site_code' }] },
    );
  const result = await tenantPagePlan(f.adapter, f.schema, definition, { id: 'parent-id-a' }, now);
  const timeline = result.plans[3];
  assert.ok(timeline.kind === 'timeline' && timeline.streams[0].view);
  assert.deepEqual(
    (await f.adapter.runView(timeline.streams[0].view)).rows.map((row) => row.id),
    ['site-a2', 'site-a1'],
  );
  assert.deepEqual(plain(viewAt(result, 0).filter), { groups: [[{ path: 'id', op: '=', value: 'site-id-a' }]] });
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 0))).rows.map((row) => [row.id, row.value]),
    [['site-id-a', 24]],
  );
  assert.deepEqual((await f.adapter.runView(viewAt(result, 1))).rows.map((row) => row.id).sort(), ['site-a1', 'site-a2']);
  assert.deepEqual(plain(viewAt(result, 2).filter), { groups: [[{ path: 'site_id', op: '=', value: 'site-id-a' }]] });
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 2))).rows.map((row) => row.id),
    ['site-pk-a'],
  );
});

test('composite alternate-unique terminal columns are all read and bound despite a single-column root PK', async (t) => {
  const f = await fixture(t),
    definition: PageDef = {
      ...page({ kind: 'list', from: 'composite_child', path: 'zone+parent_code', columns: ['id'] }),
      base: 'composite_parent',
    };
  const result = await tenantPagePlan(f.adapter, f.schema, definition, { id: 'composite-a' }, now);
  assert.deepEqual(plain(viewAt(result, 0).filter), {
    groups: [
      [
        { path: 'zone', op: '=', value: 'north' },
        { path: 'parent_code', op: '=', value: 'same' },
      ],
    ],
  });
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 0))).rows.map((row) => row.id),
    ['composite-child-a'],
  );
});

test('multi-hop reverse paths obtain alternate keys from the terminal root, not the first child', async (t) => {
  const f = await fixture(t),
    definition = page({ kind: 'list', from: 'grandchild', path: 'child_id.parent_code', columns: ['id'] });
  const result = await tenantPagePlan(f.adapter, f.schema, definition, { id: 'parent-id-a' }, now);
  assert.deepEqual(plain(viewAt(result, 0).filter), { groups: [[{ path: 'child_id.parent_code', op: '=', value: 'PARENT-CODE-A' }]] });
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 0))).rows.map((row) => row.id),
    ['grand-a'],
  );
});

test('a similar list matches the stored row’s own values, read in the root read, and a NULL value is empty', async (t) => {
  const f = await fixture(t);
  const queries: Array<{ columns?: string[] }> = [];
  const adapter = f.reader({
    query: async (input) => {
      queries.push(input);
      return f.adapter.query(input);
    },
  });
  const definition: PageDef = {
    ...page({ kind: 'list', from: 'child', path: '', columns: ['id'], similar: { same: ['parent_code'], near: { amount: 1 } } }),
    base: 'child',
  };
  const result = await tenantPagePlan(adapter, f.schema, definition, { id: 'child-a2' }, now);
  // One exact-root read both admits and supplies the match values.
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].columns, ['id', 'parent_code', 'amount']);
  assert.deepEqual(plain(viewAt(result, 0).filter), {
    groups: [
      [
        { path: 'parent_code', op: '=', value: 'PARENT-CODE-A' },
        { path: 'amount', op: '>=', value: 0 },
        { path: 'amount', op: '<=', value: 14 },
        { path: 'id', op: '!=', value: 'child-a2' },
      ],
    ],
  });
  assert.deepEqual(
    (await f.adapter.runView(viewAt(result, 0))).rows.map((row) => row.id),
    ['child-a1'],
  );
  const blank = await tenantPagePlan(f.adapter, f.schema, definition, { id: 'unrelated-null' }, now);
  const plan = blank.plans[0];
  assert.ok('empty' in plan && plan.empty);
  assert.equal('view' in plan && Boolean(plan.view), false);
});

test('reference counts use stored alternate values and retain ordinary PK relationships', async (t) => {
  const f = await fixture(t),
    key = { id: 'parent-id-a' };
  const result = await tenantReferences(f.adapter, f.schema, 'parent', key);
  assert.deepEqual(result.references.map((ref) => [ref.table, ref.count]).sort(), [
    ['child', 2],
    ['child_pk', 1],
  ]);
  const alternate = result.references.find((ref) => ref.table === 'child');
  assert.ok(alternate);
  assert.deepEqual(plain(alternate.filter), { groups: [[{ column: 'parent_code', op: '=', value: 'PARENT-CODE-A' }]] });
  assert.deepEqual(alternate.toColumns, ['code']);
  assert.deepEqual(key, { id: 'parent-id-a' });
});

test('reference counts bind the complete composite alternate key rather than cross-counting equal codes', async (t) => {
  const f = await fixture(t),
    result = await tenantReferences(f.adapter, f.schema, 'composite_parent', { id: 'composite-a' });
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].count, 1);
  assert.deepEqual(plain(result.references[0].filter), {
    groups: [
      [
        { column: 'zone', op: '=', value: 'north' },
        { column: 'parent_code', op: '=', value: 'same' },
      ],
    ],
  });
});

for (const section of [
  childList,
  { kind: 'metric' as const, from: 'child', path: 'parent_code', fn: 'count' as const },
  { kind: 'breakdown' as const, from: 'child', path: 'parent_code', by: 'name' },
  { kind: 'timeline' as const, streams: [{ from: 'child', path: 'parent_code', at: 'at', show: 'name' }] },
])
  test(`NULL alternate root key refuses ${section.kind} planning instead of selecting unrelated NULL children`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM child WHERE parent_code IS NULL').get()!.n, 1);
    await assert.rejects(tenantPagePlan(f.adapter, f.schema, page(section), { id: 'parent-null' }, now), safe);
  });

test('NULL forward about reference yields an empty section, not an unfiltered parent view', async (t) => {
  const f = await fixture(t),
    result = await tenantPagePlan(
      f.adapter,
      f.schema,
      page({ kind: 'list', from: 'site_child', path: 'site_code', of: 'site_code', columns: ['id'] }),
      { id: 'parent-null' },
      now,
    );
  assert.equal(result.plans.length, 1);
  const plan = result.plans[0];
  assert.ok('empty' in plan && plan.empty);
  assert.equal('view' in plan && Boolean(plan.view), false);
});

test('reference enumeration never emits an IS NULL relation for a nullable unique root value', async (t) => {
  const f = await fixture(t),
    result = await tenantReferences(f.adapter, f.schema, 'parent', { id: 'parent-null' });
  assert.equal(
    result.references.some((ref) => ref.table === 'child'),
    false,
  );
  assert.deepEqual(
    result.references.map((ref) => [ref.table, ref.count]),
    [['child_pk', 0]],
  );
});

for (const operation of ['plan', 'references'] as const)
  test(`${operation} fails wholly when its single exact-root read fails`, async (t) => {
    const f = await fixture(t),
      failure = new TenantContextError();
    let queries = 0,
      counts = 0;
    const adapter = f.reader({
      query: async () => {
        queries++;
        throw failure;
      },
      count: async (...args) => {
        counts++;
        return f.adapter.count(...args);
      },
    });
    const work =
      operation === 'plan'
        ? tenantPagePlan(adapter, f.schema, page(childList), { id: 'parent-id-a' }, now)
        : tenantReferences(adapter, f.schema, 'parent', { id: 'parent-id-a' });
    await assert.rejects(work, safe);
    assert.equal(queries, 1);
    assert.equal(counts, 0);
  });

test('about-parent lookup failure rejects the entire plan rather than retaining earlier root sections', async (t) => {
  const f = await fixture(t),
    failure = new TenantContextError();
  let parentReads = 0;
  const adapter = f.reader({
    query: async (input) => {
      if (input.table === 'site') {
        parentReads++;
        throw failure;
      }
      return f.adapter.query(input);
    },
  });
  await assert.rejects(
    tenantPagePlan(
      adapter,
      f.schema,
      page(childList, { kind: 'list', from: 'site_child', path: 'site_code', of: 'site_code', columns: ['id'] }),
      { id: 'parent-id-a' },
      now,
    ),
    safe,
  );
  assert.equal(parentReads, 1);
});

test('a later reference count failure rejects the whole result despite a successful first count', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const completed: number[] = [];
  const adapter = f.reader({
    count: async (...args) => {
      if (++attempts === 2) throw new TenantContextError();
      const count = await f.adapter.count(...args);
      completed.push(count);
      return count;
    },
  });
  await assert.rejects(tenantReferences(adapter, f.schema, 'parent', { id: 'parent-id-a' }), safe);
  assert.equal(attempts, 2);
  assert.equal(completed.length, 1);
  assert.ok(completed[0] > 0);
});

test('caller-supplied alternate values cannot supplement or override an exact root PK before a query', async (t) => {
  const f = await fixture(t);
  let countCalls = 0,
    queryCalls = 0;
  const adapter = f.reader({
    query: async (input) => {
      queryCalls++;
      return f.adapter.query(input);
    },
    count: async (...args) => {
      countCalls++;
      return f.adapter.count(...args);
    },
  });
  const keys: Array<Record<string, string | number>> = [{ id: 'parent-id-a', code: 'PARENT-CODE-B' }, { code: 'PARENT-CODE-A' }];
  for (const key of keys) {
    await assert.rejects(tenantPagePlan(adapter, f.schema, page(childList), key, now));
    await assert.rejects(tenantReferences(adapter, f.schema, 'parent', key));
  }
  assert.equal(countCalls, 0);
  assert.equal(queryCalls, 0);
});
