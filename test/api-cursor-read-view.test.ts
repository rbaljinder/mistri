import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { createApiCursorReadView } from '../packages/mistri/src/server/api/apiCursorReadView.js';
const clock = new Date('2026-09-13T12:00:00Z');
function fixture() {
  const schema: DatabaseSchema = {
    label: 'PG',
    dialect: 'postgres',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'tenant', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true },
          { name: 'rank', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'day', type: 'DATE', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'items',
      views: { items: { kind: 'list', from: 'item', query: 'rank < 3 or rank > 8' } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['items'],
        resources: {
          item: {
            fields: ['tenant', 'id', 'rank', 'name', 'day'],
            sorts: ['rank', 'name'],
            filters: ['rank', 'name', 'day'],
          },
        },
      },
    },
    'fixture',
  );
  const context = {
    secret: Buffer.alloc(32, 7),
    scopeFingerprint: 'account:token:revision:roles:operations',
    deploymentId: 'server-one',
    catalogId: 'schema-one',
    ttlMs: 86400000 * 2,
  };
  const options = { integers: 'decimal-string' as const };
  const run = (query = '', operationId = 'list:item', now = clock) =>
    createApiCursorReadView(app, schema, { operationId, query }, options, context, now);
  return { app, schema, context, options, run };
}
test('authenticated composite-key continuation preserves standing and refinements, count stays uncontinued', () => {
  const f = fixture(),
    query = 'sort=-rank&fields=name&rank=1..10&limit=3&count=true';
  const first = f.run(query, 'view:items');
  const token = first.sealNext({ rank: '9', tenant: '2', id: '9007199254740993', name: 'last returned' });
  const next = f.run(query + '&cursor=' + token, 'view:items');
  assert.equal(next.rows.filter!.groups.length, 6);
  assert.equal(next.count.filter!.groups.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(next.count)), JSON.parse(JSON.stringify(first.count)));
  assert.deepEqual(
    next.rows.filter!.groups[2].slice(-3).map((term) => ({ ...term })),
    [
      { path: 'rank', op: '=', value: '9' },
      { path: 'tenant', op: '=', value: '2' },
      { path: 'id', op: '>', value: '9007199254740993' },
    ],
  );
  assert.equal(next.rows.limit, 4);
  assert.ok(Object.isFrozen(next.rows.filter!.groups[0]));
  assert.equal(next.authorization, 'pending');
  assert.equal(next.execution, 'pending');
  assert.throws(() => first.sealNext({ tenant: '2', id: '1' }));
});
test('bindings cover scope/deployment/catalog, projection, limit/count, ordering and effective filters', () => {
  const f = fixture(),
    query = 'sort=-rank&fields=name&limit=3&count=true';
  const token = f.run(query).sealNext({ rank: '9', tenant: '2', id: '3' });
  for (const changed of [
    'sort=rank&fields=name&limit=3&count=true',
    'sort=-rank&fields=rank&limit=3&count=true',
    'sort=-rank&fields=name&limit=4&count=true',
    'sort=-rank&fields=name&limit=3&count=false',
    query + '&name=x',
  ]) {
    assert.throws(() => f.run(changed + '&cursor=' + token));
  }
  for (const key of ['scopeFingerprint', 'deploymentId', 'catalogId'] as const) {
    const changed = { ...f.context, [key]: 'changed' };
    assert.throws(() =>
      createApiCursorReadView(f.app, f.schema, { operationId: 'list:item', query: query + '&cursor=' + token }, f.options, changed, clock),
    );
  }
  assert.ok(f.run('count=true&limit=3&fields=name&sort=-rank&%63ursor=' + token));
  assert.throws(() => f.run(query + '&cursor=' + token + '&%63ursor=' + token));
  assert.throws(() => f.run(query + '&cursor=' + token + '&bad=%FF'));
  assert.throws(() => f.run(query + '&cursor=' + token, 'list:item', new Date(clock.getTime() + f.context.ttlMs)));
});
test('relative standing predicates invalidate when reevaluation changes, not just wall-clock milliseconds', () => {
  const f = fixture();
  Object.assign(f.app.views.items, { query: 'day = today' });
  const first = f.run('', 'view:items'),
    token = first.sealNext({ tenant: '1', id: '2' });
  assert.ok(f.run('cursor=' + token, 'view:items', new Date(clock.getTime() + 1000)));
  assert.throws(() => f.run('cursor=' + token, 'view:items', new Date(clock.getTime() + 86400000)));
});
test('actual numeric schema and exposure identity bind even if caller catalogId is accidentally reused', () => {
  const f = fixture(),
    token = f.run().sealNext({ tenant: '1', id: '2' });
  f.schema.tables[0].columns.find((column) => column.name === 'id')!.type = 'INTEGER';
  assert.throws(() => f.run('cursor=' + token));
  f.schema.tables[0].columns.find((column) => column.name === 'id')!.type = 'BIGINT';
  f.schema.readAt = 'different inspection time';
  assert.ok(f.run('cursor=' + token));
  f.app.api!.resources.item.filters.push('tenant');
  assert.throws(() => f.run('cursor=' + token));
});
test('text orders and continues by bytes, exactly: the order and every boundary term carry the binary collation', () => {
  const f = fixture(),
    first = f.run('sort=-name');
  assert.equal(first.collationValidation, 'binary-text');
  assert.deepEqual(
    first.rows.orderBy!.map((order) => ({ ...order })),
    [
      { path: 'name', direction: 'desc', collation: 'binary' },
      { path: 'tenant', direction: 'asc' },
      { path: 'id', direction: 'asc' },
    ],
  );
  // Case, accents and trailing spaces are data: the cursor keeps them as given.
  const token = first.sealNext({ name: 'Ábc ', tenant: '1', id: '2' });
  const next = f.run('sort=-name&cursor=' + token);
  assert.deepEqual(
    next.rows.filter!.groups.map((group) => group.map((term) => ({ ...term }))),
    [
      [{ path: 'name', op: '<', value: 'Ábc ', collation: 'binary' }],
      [
        { path: 'name', op: '=', value: 'Ábc ', collation: 'binary' },
        { path: 'tenant', op: '>', value: '1' },
      ],
      [
        { path: 'name', op: '=', value: 'Ábc ', collation: 'binary' },
        { path: 'tenant', op: '=', value: '1' },
        { path: 'id', op: '>', value: '2' },
      ],
    ],
  );
  // The count is the original question: its filter has no boundary terms.
  assert.doesNotMatch(JSON.stringify(next.count.filter), /collation/);
});
test('date ordering, arbitrary plans, hostile inputs and token tampering stay refused', () => {
  const f = fixture();
  f.app.api!.resources.item.sorts.push('day');
  assert.throws(() => f.run('sort=day'));
  assert.throws(() => f.run('', 'item:item'));
  const token = f.run().sealNext({ tenant: '1', id: '2' });
  assert.throws(() => f.run('cursor=' + token.slice(0, -3) + 'AAA'));
  let getters = 0;
  assert.throws(() =>
    createApiCursorReadView(f.app, f.schema, { operationId: 'list:item', query: '', plan: {} } as never, f.options, f.context, clock),
  );
  const context = { ...f.context };
  Object.defineProperty(context, 'secret', {
    enumerable: true,
    get() {
      getters++;
      return f.context.secret;
    },
  });
  assert.throws(() => createApiCursorReadView(f.app, f.schema, { operationId: 'list:item', query: '' }, f.options, context, clock));
  assert.equal(getters, 0);
});
test('native boolean ordering uses typed false boundary and keeps numeric complete key suffix', () => {
  const f = fixture();
  f.schema.tables[0].columns.push({ name: 'active', type: 'BOOLEAN', nullable: false, primaryKey: false });
  f.app.api!.resources.item.fields.push('active');
  f.app.api!.resources.item.sorts.push('active');
  const token = f.run('sort=active').sealNext({ active: false, tenant: '1', id: '2' });
  const next = f.run('sort=active&cursor=' + token);
  assert.deepEqual({ ...next.rows.filter!.groups[0][0] }, { path: 'active', op: '>', value: false });
});

test('an App with a large catalog pages its lists: the catalog is hashed whole, never capped', () => {
  const f = fixture();
  // Past the 1 MiB and 10,000 nodes a snapshot of request input is held to.
  const tables = Array.from({ length: 400 }, (_, index) => ({
    id: `wide_${index}`,
    name: `wide_${index}`,
    schema: '',
    isView: false,
    columns: Array.from({ length: 40 }, (_, column) => ({
      name: `column_${column}_${'x'.repeat(40)}`,
      type: 'TEXT',
      nullable: true,
      primaryKey: column === 0,
    })),
  }));
  const big: DatabaseSchema = { ...f.schema, tables: [...f.schema.tables, ...tables] };
  assert.ok(JSON.stringify(big).length > 1048576);
  const run = (schema: DatabaseSchema, query: string) =>
    createApiCursorReadView(f.app, schema, { operationId: 'list:item', query }, f.options, f.context, clock);
  const first = run(big, 'sort=rank&limit=2');
  const token = first.sealNext({ rank: '1', tenant: '1', id: '1' });
  assert.ok(run(big, `sort=rank&limit=2&cursor=${token}`).rows.filter);
  // Still the catalog's identity: a column changed anywhere refuses a cursor sealed before it.
  const changed: DatabaseSchema = {
    ...big,
    tables: big.tables.map((table, index) =>
      index === 300 ? { ...table, columns: [...table.columns, { name: 'added', type: 'TEXT', nullable: true, primaryKey: false }] } : table,
    ),
  };
  assert.throws(() => run(changed, `sort=rank&limit=2&cursor=${token}`));
});
