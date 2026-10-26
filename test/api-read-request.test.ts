import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { planApiItemReadRequest, planApiReadRequest, planApiViewReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';

const app = () =>
  parseAppConfig(
    {
      id: 'directory',
      name: 'Directory',
      resources: { person: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person', query: 'rank > 2' } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['people'],
        resources: {
          person: { fields: ['id', 'name', 'rank'], filters: ['id', 'rank'], sorts: ['rank'] },
        },
      },
    },
    'request',
  );
const schema = (): DatabaseSchema => ({
  label: 'Logical',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'person',
      name: 'person',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'rank', type: 'INTEGER', nullable: false, primaryKey: false },
        { name: 'secret', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
});
const options = { integers: 'decimal-string' as const };

test('sparse response retains keys but not the internal tie-order projection', () => {
  const plan = planApiReadRequest(app(), schema(), 'list:person', 'fields=name&sort=-rank&rank=2..8&limit=25&count=true', options);
  assert.deepEqual(plan.responseFields, ['id', 'name']);
  assert.deepEqual(plan.fetchFields, ['id', 'name', 'rank']);
  assert.deepEqual(plan.order, [
    { column: 'rank', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ]);
  assert.deepEqual(plan.boundary.after({ id: 9, rank: 4, name: 'not a boundary field' }), [
    [{ field: 'rank', operator: '<', value: '4' }],
    [
      { field: 'rank', operator: '=', value: '4' },
      { field: 'id', operator: '>', value: '9' },
    ],
  ]);
  assert.deepEqual(plan.filters, [{ field: 'rank', kind: 'range', min: '2', max: '8' }]);
  assert.equal(plan.limit, 25);
  assert.equal(plan.count, true);
  const row = plan.response.encodeRow({ id: 7, name: 'A', rank: 3, secret: 'hidden' });
  assert.deepEqual({ ...row }, { id: '7', name: 'A' });
  const validate = new Ajv2020().compile(plan.response.schema);
  assert.equal(validate(row), true);
  assert.equal(validate({ ...row, rank: '3' }), false);
  const page = plan.envelope.encode({
    items: [{ id: 7, name: 'A', rank: 3 }],
    next: null,
    count: { value: 1, exact: true, capped: false },
  });
  assert.deepEqual({ ...page.items[0] }, { id: '7', name: 'A' });
  assert.throws(() => plan.envelope.encode({ items: [], next: null }));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.fetchFields));
});

test('exact typed values and opaque cursor never imply principal or cursor authority', () => {
  const plan = planApiReadRequest(app(), schema(), 'list:person', 'id=9007199254740993&cursor=untrusted', options);
  assert.deepEqual(plan.filters, [{ field: 'id', kind: 'equals', value: '9007199254740993' }]);
  assert.equal(plan.authorization, 'pending');
  assert.equal(plan.execution, 'pending');
  assert.equal(plan.cursorVerification, 'pending');
  assert.equal(plan.unverifiedCursor, 'untrusted');
  assert.equal(plan.limit, 50);
  assert.equal(plan.count, false);
  assert.throws(() => planApiReadRequest(app(), schema(), 'list:person', 'id=9007199254740993', { integers: 'number' }));
});

test('view, item, undeclared operation and unsupported filters refuse without a query fallback', () => {
  for (const operation of ['view:people', 'item:person', 'list:secret']) {
    assert.throws(() => planApiReadRequest(app(), schema(), operation, '', options), /resource lists only/);
  }
  for (const query of ['q=person', 'secret=hidden', 'rank=high', 'rank=9..2', 'rank=1&rank=2', 'sort=secret']) {
    assert.throws(() => planApiReadRequest(app(), schema(), 'list:person', query, options));
  }
});

test('sparse fields do not bypass unsupported full-exposure wire types', () => {
  const catalog = schema();
  catalog.tables[0].columns[1].type = 'BLOB';
  assert.throws(() => planApiReadRequest(app(), catalog, 'list:person', 'fields=id', options), /cannot represent/);
});

test('later App, schema and option mutation cannot widen an existing plan response', () => {
  const definition = app(),
    catalog = schema(),
    settings = { ...options };
  const plan = planApiReadRequest(definition, catalog, 'list:person', 'fields=name&sort=-rank', settings);
  definition.api!.resources.person.fields.push('secret');
  catalog.tables[0].columns[0].type = 'TEXT';
  (settings as { integers: string }).integers = 'number';
  assert.deepEqual({ ...plan.response.encodeRow({ id: 8, name: 'B', secret: 'hidden' }) }, { id: '8', name: 'B' });
  assert.throws(() => plan.envelope.encode({ items: [], next: null, count: { value: 0, exact: true, capped: false } }));
  assert.deepEqual(plan.fetchFields, ['id', 'name', 'rank']);
});

test('item requests share exact keys and full projection without claiming existence or access', () => {
  const plan = planApiItemReadRequest(app(), schema(), 'item:person', '9007199254740993', options);
  assert.deepEqual({ ...plan.key }, { id: '9007199254740993' });
  assert.equal(plan.authorization, 'pending');
  assert.equal(plan.execution, 'pending');
  assert.deepEqual(plan.responseFields, ['id', 'name', 'rank']);
  assert.ok(Object.isFrozen(plan.key));
  for (const raw of ['01', '1e2', '1/2', '%ZZ', '1?fields=name']) {
    assert.throws(() => planApiItemReadRequest(app(), schema(), 'item:person', raw, options));
  }
  assert.throws(() => planApiItemReadRequest(app(), schema(), 'list:person', '1', options), /item operations only/);
});

test('composite item paths preserve encoded separators within individual key values', () => {
  const catalog = schema();
  catalog.tables[0].columns[1].primaryKey = true;
  const plan = planApiItemReadRequest(app(), catalog, 'item:person', 'name=A%2CB%3DC,id=7', options);
  assert.deepEqual({ ...plan.key }, { id: '7', name: 'A,B=C' });
  assert.throws(() => planApiItemReadRequest(app(), catalog, 'item:person', 'id=7', options));
});

test('view default tab retains standing predicates while refinements and explicit sort stay independent', () => {
  const definition = app();
  Object.assign(definition.views.people, {
    tabs: [
      { label: 'High rank', query: 'rank >= 5 sort rank desc' },
      { label: 'Others', query: 'rank < 5' },
    ],
  });
  const now = new Date('2026-09-13T12:00:00Z');
  const plan = planApiViewReadRequest(definition, schema(), 'view:people', 'fields=name&rank=6..8', options, now);
  assert.equal(plan.tab, 'high-rank');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.standingFilter)), {
    groups: [
      [
        { path: 'rank', op: '>', value: 2 },
        { path: 'rank', op: '>=', value: 5 },
      ],
    ],
  });
  assert.deepEqual(plan.filters, [{ field: 'rank', kind: 'range', min: '6', max: '8' }]);
  assert.equal(plan.filterComposition, 'standing-and-refinements');
  assert.deepEqual(plan.order, [
    { column: 'rank', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ]);
  assert.deepEqual(plan.responseFields, ['id', 'name']);
  assert.deepEqual(plan.fetchFields, ['id', 'name', 'rank']);
  const other = planApiViewReadRequest(definition, schema(), 'view:people', 'segment=others&sort=rank', options, now);
  assert.deepEqual(JSON.parse(JSON.stringify(other.standingFilter)), {
    groups: [
      [
        { path: 'rank', op: '>', value: 2 },
        { path: 'rank', op: '<', value: 5 },
      ],
    ],
  });
  assert.equal(other.order[0].direction, 'asc');
  assert.throws(() => planApiViewReadRequest(definition, schema(), 'view:people', 'segment=unknown', options, now));
  assert.throws(() => planApiViewReadRequest(definition, schema(), 'list:person', '', options, now));
});

test('view date questions evaluate against the supplied clock, not the catalog validation clock', () => {
  const definition = app();
  Object.assign(definition.views.people, { query: 'name = today' });
  const first = planApiViewReadRequest(definition, schema(), 'view:people', '', options, new Date(2026, 8, 13, 12));
  const second = planApiViewReadRequest(definition, schema(), 'view:people', '', options, new Date(2026, 8, 14, 12));
  assert.notDeepEqual(first.standingFilter, second.standingFilter);
  assert.equal(JSON.stringify(first.standingFilter).includes('2026-09-13'), true);
  assert.equal(first.authorization, 'pending');
  assert.equal(first.execution, 'pending');
  assert.ok(Object.isFrozen(first.standingFilter));
  assert.throws(() => planApiViewReadRequest(definition, schema(), 'view:people', '', options, new Date(NaN)), /clock/);
});

test('no-tab views preserve query order before authored sort fallback', () => {
  const definition = app(),
    now = new Date('2026-09-13T12:00:00Z');
  Object.assign(definition.views.people, { query: 'rank > 2 sort rank desc', sort: 'id asc' });
  const fromQuery = planApiViewReadRequest(definition, schema(), 'view:people', '', options, now);
  assert.equal(fromQuery.tab, null);
  assert.deepEqual(fromQuery.order, [
    { column: 'rank', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ]);
  Object.assign(definition.views.people, { query: 'rank > 2', sort: 'rank asc' });
  const fallback = planApiViewReadRequest(definition, schema(), 'view:people', '', options, now);
  assert.deepEqual(fallback.order, [
    { column: 'rank', direction: 'asc' },
    { column: 'id', direction: 'asc' },
  ]);
  const explicit = planApiViewReadRequest(definition, schema(), 'view:people', 'sort=-rank', options, now);
  assert.equal(explicit.order[0].direction, 'desc');
  assert.deepEqual(explicit.standingFilter, fallback.standingFilter);
});
