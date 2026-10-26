import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { createApiMcpReadArguments } from '../packages/mistri/src/server/api/apiMcpReadArguments.js';
import { previewApiMcpReadTools } from '../packages/mistri/src/server/api/apiMcpReadTools.js';
import { planApiReadRequest, planApiItemReadRequest, planApiViewReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';

const instant = new Date('2026-09-14T00:00:00Z');
const app = () =>
  parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { person: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person', query: 'rank > 2' } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['people'],
        resources: {
          person: { fields: ['id', 'name', 'rank'], filters: ['id', 'name', 'rank'], sorts: ['rank'] },
        },
      },
    },
    'MCP arguments',
  );
const schema = (): DatabaseSchema => ({
  label: '',
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
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
        { name: 'rank', type: 'INTEGER', primaryKey: false, nullable: false },
      ],
    },
  ],
});

test('typed list arguments obey the actual preview schema and shared request decoder', () => {
  for (const integers of ['number', 'decimal-string'] as const) {
    const definition = app(),
      catalog = schema(),
      policy = { integers };
    const arguments_ = {
      limit: 4,
      count: true,
      fields: 'name',
      sort: '-rank',
      id: [integers === 'number' ? 7 : '7'],
      rank: '3..8',
      name: ['A+B', '100%'],
      cursor: 'opaque',
    };
    const preview = previewApiMcpReadTools(definition, catalog, policy, { roles: ['reader'], operations: ['list:person'] });
    // Runtime-only annotations are not JSON Schema assertions.
    const ajv = new Ajv2020({ strict: false });
    assert.equal(ajv.compile(preview.tools[0].inputSchema as Record<string, unknown>)(arguments_), true);
    const decoded = createApiMcpReadArguments(definition, catalog, 'list:person', policy).decode(arguments_, instant);
    assert.ok('query' in decoded);
    const planned = planApiReadRequest(definition, catalog, decoded.operationId, decoded.query, policy);
    assert.equal(planned.limit, 4);
    assert.equal(planned.count, true);
    assert.deepEqual(planned.responseFields, ['id', 'name']);
    assert.equal(planned.unverifiedCursor, 'opaque');
    assert.equal(decoded.authorization, 'pending');
    assert.ok(Object.isFrozen(decoded));
  }
});
test('item scalar and complete composite keys reuse exact raw-key encoding', () => {
  const definition = app(),
    catalog = schema(),
    policy = { integers: 'decimal-string' as const };
  const scalar = createApiMcpReadArguments(definition, catalog, 'item:person', policy);
  const large = scalar.decode({ id: '9007199254740993' }, instant);
  assert.ok('key' in large);
  assert.equal(large.key, '9007199254740993');
  assert.throws(() => scalar.decode({ id: 7 }, instant));
  catalog.tables[0].columns[1].primaryKey = true;
  const composite = createApiMcpReadArguments(definition, catalog, 'item:person', policy);
  const decoded = composite.decode({ key: { id: '7', name: 'A/B,=+%' } }, instant);
  assert.ok('key' in decoded);
  assert.equal(decoded.key, 'id=7,name=A%2FB%2C%3D%2B%25');
  assert.throws(() => composite.decode({ key: { id: '7' } }, instant));
  assert.throws(() => composite.decode({ key: { id: '7', name: 'A', extra: 'x' } }, instant));
});
test('refuse coercions, unsupported controls, malformed shapes and lossy text filters', () => {
  const codec = createApiMcpReadArguments(app(), schema(), 'list:person', { integers: 'decimal-string' });
  for (const args of [
    { q: 'person' },
    { limit: '4' },
    { count: 'false' },
    { fields: ['id'] },
    { name: 'A' },
    { name: [] },
    { name: [' A'] },
    { name: ['A,B'] },
    { name: ['A..B'] },
    { rank: [7] },
    { rank: ['07'] },
    { rank: '8..3' },
    { sort: 'rank,-rank' },
    { name: null },
    { name: [''] },
    { name: ['\ud800'] },
    { limit: 501 },
    { cursor: 'x'.repeat(4097) },
  ]) {
    assert.throws(() => codec.decode(args, instant));
  }
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => codec.decode({ name: sparse }, instant));
  let getters = 0;
  assert.throws(() =>
    codec.decode(
      Object.defineProperty({}, 'limit', {
        enumerable: true,
        get() {
          getters++;
          return 4;
        },
      }),
      instant,
    ),
  );
  assert.throws(() =>
    codec.decode(
      new Proxy(
        {},
        {
          ownKeys() {
            getters++;
            return [];
          },
        },
      ),
      instant,
    ),
  );
  assert.equal(getters, 0);
});
test('captured authoring cannot drift and views retain their standing question', () => {
  const definition = app(),
    catalog = schema(),
    policy = { integers: 'number' as const };
  const view = createApiMcpReadArguments(definition, catalog, 'view:people', policy);
  definition.api!.resources.person.filters.push('hidden');
  catalog.tables[0].columns[0].type = 'BLOB';
  assert.ok('query' in view.decode({ rank: [3] }, instant));
  assert.throws(() => view.decode({ hidden: ['leak'] }, instant));
  assert.throws(() => createApiMcpReadArguments(app(), schema(), 'list:missing', policy));
});
test('date, boolean and finite numeric filters retain typed spellings without approximate conversion', () => {
  const definition = app(),
    catalog = schema();
  catalog.dialect = 'postgres';
  catalog.tables[0].columns[2].type = 'REAL';
  catalog.tables[0].columns.push(
    { name: 'day', type: 'DATE', primaryKey: false, nullable: false },
    { name: 'flag', type: 'BOOLEAN', primaryKey: false, nullable: false },
  );
  definition.api!.resources.person.fields.push('day', 'flag');
  definition.api!.resources.person.filters.push('day', 'flag');
  const codec = createApiMcpReadArguments(definition, catalog, 'list:person', { integers: 'number' });
  const result = codec.decode({ day: '2026-09-01..2026-09-30', flag: [false], rank: [1.5] }, instant);
  assert.ok('query' in result);
  assert.match(result.query, /flag=false/);
  for (const args of [{ day: ['2026-02-30'] }, { flag: ['false'] }, { rank: ['1.5'] }]) {
    assert.throws(() => codec.decode(args, instant));
  }
});
test('finite exponent spellings expand exactly and round-trip through actual HTTP filter parsing', () => {
  const definition = app(),
    catalog = schema(),
    policy = { integers: 'number' as const };
  catalog.tables[0].columns[2].type = 'REAL';
  const codec = createApiMcpReadArguments(definition, catalog, 'list:person', policy);
  for (const value of [1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MIN_VALUE, -Number.MAX_VALUE, 0, -0, 1000000000000000100]) {
    const decoded = codec.decode({ rank: [value] }, instant);
    assert.ok('query' in decoded);
    const spelling = new URLSearchParams(decoded.query).get('rank')!;
    assert.doesNotMatch(spelling, /[eE]/);
    assert.ok(spelling.length <= 400);
    const plan = planApiReadRequest(definition, catalog, decoded.operationId, decoded.query, policy);
    const predicate = plan.filters[0];
    assert.equal(predicate.kind, 'equals');
    assert.ok('value' in predicate);
    assert.ok(Object.is(predicate.value, value === 0 ? 0 : value));
  }
});

test('complete composite tool keys obey both advertised integer representations', () => {
  for (const integers of ['number', 'decimal-string'] as const) {
    const definition = app(),
      catalog = schema(),
      policy = { integers };
    catalog.tables[0].columns[1].primaryKey = true;
    const preview = previewApiMcpReadTools(definition, catalog, policy, { roles: ['reader'], operations: ['item:person'] });
    const validate = new Ajv2020({ strict: false }).compile(preview.tools[0].inputSchema as Record<string, unknown>);
    const codec = createApiMcpReadArguments(definition, catalog, 'item:person', policy);
    const id = integers === 'number' ? 7 : '9007199254740993';
    const args = { key: { id, name: '日本語😀/,%=+' } };
    assert.equal(validate(args), true);
    const decoded = codec.decode(args, instant);
    assert.ok('key' in decoded);
    const planned = planApiItemReadRequest(definition, catalog, decoded.operationId, decoded.key, policy);
    assert.equal(planned.key.name, args.key.name);
    assert.equal(planned.key.id, id);
    for (const invalid of [
      { key: null },
      { key: { id } },
      { key: { ...args.key, extra: 'x' } },
      { key: { ...args.key, id: integers === 'number' ? '7' : 7 } },
    ]) {
      assert.equal(validate(invalid), false);
      assert.throws(() => codec.decode(invalid, instant));
    }
  }
});

test('nested descriptors, null/undefined and hostile metadata refuse without invoking caller code', () => {
  const codec = createApiMcpReadArguments(app(), schema(), 'list:person', { integers: 'number' });
  let calls = 0;
  const getter = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      calls++;
      return 'x';
    },
  });
  const nestedProxy = new Proxy(['x'], {
    ownKeys() {
      calls++;
      return ['0', 'length'];
    },
  });
  for (const value of [
    undefined,
    null,
    [],
    { count: undefined },
    { count: null },
    { limit: null },
    { cursor: undefined },
    { name: [undefined] },
    { name: [null] },
    { name: getter },
    { name: nestedProxy },
  ]) {
    assert.throws(() => codec.decode(value, instant));
  }
  const hostile = Object.defineProperty({}, 'api', {
    enumerable: true,
    get() {
      calls++;
      return app().api;
    },
  });
  assert.throws(() => createApiMcpReadArguments(hostile as never, schema(), 'list:person', { integers: 'number' }));
  const options = Object.defineProperty({}, 'integers', {
    enumerable: true,
    get() {
      calls++;
      return 'number';
    },
  });
  assert.throws(() => createApiMcpReadArguments(app(), schema(), 'list:person', options as never));
  assert.equal(calls, 0);
});

test('schema annotations do not pretend to enforce lossless CSV or runtime correlation', () => {
  const definition = app(),
    catalog = schema(),
    policy = { integers: 'number' as const };
  const preview = previewApiMcpReadTools(definition, catalog, policy, { roles: ['reader'], operations: ['list:person'] });
  const validate = new Ajv2020({ strict: false }).compile(preview.tools[0].inputSchema as Record<string, unknown>);
  const codec = createApiMcpReadArguments(definition, catalog, 'list:person', policy);
  // Schema covers typed JSON. These additional restrictions belong to the
  // documented shared request boundary; URI encoding cannot repair them.
  for (const args of [
    { name: [' leading'] },
    { name: ['trailing '] },
    { name: ['x,y'] },
    { name: ['x..y'] },
    { sort: 'rank,-rank' },
    { cursor: 'x'.repeat(4097) },
  ]) {
    assert.equal(validate(args), true);
    assert.throws(() => codec.decode(args, instant));
  }
});

test('view tool tabs and relative dates remain tied to the supplied genuine clock', () => {
  const definition = app(),
    catalog = schema(),
    policy = { integers: 'number' as const };
  Object.assign(definition.views.people, {
    query: 'name = today',
    tabs: [
      { label: 'High rank', query: 'rank >= 5' },
      { label: 'Others', query: 'rank < 5' },
    ],
  });
  const codec = createApiMcpReadArguments(definition, catalog, 'view:people', policy);
  const preview = previewApiMcpReadTools(definition, catalog, policy, { roles: ['reader'], operations: ['view:people'] });
  const validate = new Ajv2020({ strict: false }).compile(preview.tools[0].inputSchema as Record<string, unknown>);
  assert.equal(validate({ segment: 'others', rank: [3] }), true);
  let calls = 0;
  const clock = new Date(2026, 8, 13, 12);
  Object.defineProperty(clock, 'getTime', {
    get() {
      calls++;
      throw new Error('not called');
    },
  });
  const decoded = codec.decode({ segment: 'others', rank: [3] }, clock);
  assert.ok('query' in decoded);
  const first = planApiViewReadRequest(definition, catalog, decoded.operationId, decoded.query, policy, clock);
  const second = planApiViewReadRequest(definition, catalog, decoded.operationId, decoded.query, policy, new Date(2026, 8, 14, 12));
  assert.equal(first.tab, 'others');
  assert.notDeepEqual(first.standingFilter, second.standingFilter);
  assert.equal(first.authorization, 'pending');
  assert.equal(first.execution, 'pending');
  assert.equal(validate({ segment: 'missing' }), false);
  assert.throws(() => codec.decode({ segment: 'missing' }, clock));
  assert.throws(() => codec.decode({}, new Date(NaN)));
  assert.throws(() => codec.decode({}, new Proxy(clock, {})));
  assert.equal(calls, 0);
});
