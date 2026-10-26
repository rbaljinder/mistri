import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresSnapshotReads } from '../packages/mistri/src/server/api/postgresSnapshotReads.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { SqlFragment } from '../packages/engine/src/adapters/adapter.js';

function fixture() {
  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'Held',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'public.people',
        name: 'people',
        schema: 'public',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', primaryKey: true, nullable: false },
          { name: 'name', type: 'text', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  let active = true,
    result: Record<string, unknown>[] = [{ id: '9007199254740993', name: 'One' }];
  let afterExecute = () => {};
  const statements: SqlFragment[] = [];
  const adapter = postgresSnapshotReads({
    schema,
    assertCurrent: () => {
      assert.ok(active, 'expired snapshot');
    },
    execute: async (statement) => {
      statements.push(statement);
      afterExecute();
      return { columns: Object.keys(result[0] ?? {}), rows: result, ms: 1, sql: statement };
    },
  });
  const view: ViewDef = {
    id: 'people',
    name: 'People',
    base: 'public.people',
    columns: [{ path: 'id' }, { path: 'name' }],
    limit: 2,
    orderBy: [{ path: 'id', direction: 'asc' }],
  };
  return {
    adapter,
    view,
    statements,
    schema,
    retire: () => {
      active = false;
    },
    rows: (value: Record<string, unknown>[]) => {
      result = value;
    },
    after: (callback: () => void) => {
      afterExecute = callback;
    },
  };
}

test('snapshot bridge compiles mapped views without another connection or numeric coercion', async () => {
  const f = fixture();
  const resources = createAppResources(f.adapter, f.schema, { person: 'public.people' });
  const result = await resources.adapter.runView!({ ...f.view, base: 'person' });
  assert.deepEqual(result.rows, [{ id: '9007199254740993', name: 'One' }]);
  assert.equal(result.resolved[0].table, 'person');
  assert.match(f.statements[0].text, /"public"\."people"/);
  assert.equal(f.statements.length, 1);
  assert.ok(Object.isFrozen(f.adapter));
});

test('snapshot bridge refuses unrelated adapter operations and stale continuations', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.query({} as never), /only checked views/);
  await assert.rejects(f.adapter.count('public.people'), /only checked views/);
  await assert.rejects(f.adapter.close(), /only checked views/);
  assert.equal(f.adapter.transaction, undefined);
  assert.equal(f.adapter.runSql, undefined);
  f.after(f.retire);
  await assert.rejects(f.adapter.runView!(f.view), /expired snapshot/);
  await assert.rejects(f.adapter.introspect(), /expired snapshot/);
  await assert.rejects(f.adapter.countView!(f.view, 10001), /expired snapshot/);
  assert.equal(f.statements.length, 1);
});

test('named source mapping uses the same held snapshot compiler', async () => {
  const f = fixture();
  const source = createAppSourceAdapter({ main: { adapter: f.adapter, schema: f.schema, resources: { person: 'public.people' } } }, 'main');
  const result = await source.adapter.runView!({ ...f.view, base: 'person' });
  assert.deepEqual(result.rows, [{ id: '9007199254740993', name: 'One' }]);
  assert.equal(result.resolved[0].table, 'person');
  assert.equal(f.statements.length, 1);
  f.retire();
  await assert.rejects(source.adapter.runView!({ ...f.view, base: 'person' }), /expired snapshot/);
});

test('snapshot count is bounded in SQL and refuses malformed or unsafe native values', async () => {
  const f = fixture();
  f.rows([{ n: '10001' }]);
  assert.equal(await f.adapter.countView!(f.view, 10001), 10001);
  assert.ok(f.statements[0].params.includes(10001) || f.statements[0].text.includes('10001'));
  for (const rows of [
    [],
    [{ n: null }],
    [{ n: '01' }],
    [{ n: '1e3' }],
    [{ n: '-1' }],
    [{ n: '9007199254740993' }],
    [{ n: -0 }],
    [{ n: '1\n' }],
    [{ n: '10002' }],
    [{ n: 1 }, { n: 2 }],
  ]) {
    f.rows(rows);
    await assert.rejects(f.adapter.countView!(f.view, 10001), /count is unavailable/);
  }
});
