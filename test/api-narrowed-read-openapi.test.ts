import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { narrowApiReadOpenApi } from '../packages/mistri/src/server/api/apiNarrowedReadOpenApi.js';

function fixture() {
  const app = parseAppConfig(
    {
      id: 'scope',
      name: 'Scope',
      home: 'items',
      auth: { roles: { reader: { read: true }, hidden_role: { read: true } } },
      resources: { item: {}, hidden_resource: {} },
      views: { items: { kind: 'list', from: 'item', query: 'id > 1' } },
      api: {
        version: 1,
        roles: ['reader', 'hidden_role'],
        views: ['items'],
        resources: {
          item: { fields: ['id', 'name'], filters: ['name'], sorts: ['id'] },
          hidden_resource: { fields: ['id', 'private_field'], filters: [], sorts: [] },
        },
      },
    },
    'scoped preview',
  );
  const schema: DatabaseSchema = {
    label: '',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      ['item', 'name'],
      ['hidden_resource', 'private_field'],
    ].map(([name, field]) => ({
      id: name,
      name,
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: field, type: 'TEXT', primaryKey: false, nullable: false },
      ],
    })),
  };
  return renderApiReadOpenApi(app, schema, { integers: 'decimal-string' }).document;
}

test('scope selects item/list/view independently and removes private metadata', () => {
  const source = fixture(),
    original = JSON.stringify(source);
  for (const [id, path] of [
    ['item:item', '/item/{id}'],
    ['list:item', '/item'],
    ['view:items', '/views/items'],
  ]) {
    const result = narrowApiReadOpenApi(source, [id]);
    assert.deepEqual(Object.keys(result.paths), [path]);
    assert.equal(result['x-mistri-document'], 'app-api-reads');
    assert.deepEqual(JSON.parse(JSON.stringify(result.servers)), source.servers);
    assert.deepEqual(JSON.parse(JSON.stringify(result.security)), source.security);
    const text = JSON.stringify(result);
    for (const hidden of [
      'hidden_resource',
      'private_field',
      'hidden_role',
      'x-mistri-eligible-roles',
      'x-mistri-standing-contract',
      'id > 1',
    ]) {
      assert.equal(text.includes(hidden), false, hidden);
    }
    assert.ok(Object.isFrozen(result.paths));
    assert.ok(Object.isFrozen(result.components.schemas));
  }
  assert.equal(JSON.stringify(source), original);
  const empty = narrowApiReadOpenApi(source, []);
  assert.deepEqual(empty.paths, {});
  assert.deepEqual(empty.components.schemas, {});
});

test('transitive schema references survive while unreachable components disappear', () => {
  const source = JSON.parse(JSON.stringify(fixture()));
  const get = source.paths['/item/{id}'].get;
  const original = get.responses['200'].content['application/json'].schema;
  source.components.schemas.Wrapper = { type: 'object', properties: { item: original } };
  source.components.schemas.Unused = { type: 'string' };
  get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Wrapper' };
  const result = narrowApiReadOpenApi(source, ['item:item']);
  assert.equal(Object.hasOwn(result.components.schemas, 'Wrapper'), true);
  assert.equal(Object.hasOwn(result.components.schemas, original.$ref.split('/').at(-1)), true);
  assert.equal(Object.hasOwn(result.components.schemas, 'Unused'), false);
  get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Missing' };
  assert.throws(() => narrowApiReadOpenApi(source, ['item:item']));
  get.responses['200'].content['application/json'].schema = { $ref: 'https://example.invalid/private' };
  assert.throws(() => narrowApiReadOpenApi(source, ['item:item']));
});

test('captured scope and document refuse proxies and sparse arrays without invoking traps', () => {
  const source = fixture();
  let traps = 0;
  const handler = {
    get() {
      traps++;
      throw new Error('must not execute');
    },
    ownKeys() {
      traps++;
      throw new Error('must not execute');
    },
  };
  assert.throws(() => narrowApiReadOpenApi(new Proxy(source, handler), ['item:item']));
  assert.throws(() => narrowApiReadOpenApi(source, new Proxy(['item:item'], handler)));
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(() => narrowApiReadOpenApi(source, sparse));
  assert.equal(traps, 0);
});

test('returned projection is detached from later document and scope mutations', () => {
  const source = JSON.parse(JSON.stringify(fixture()));
  const ids = ['item:item'];
  const result = narrowApiReadOpenApi(source, ids),
    before = JSON.stringify(result);
  ids.push('item:hidden_resource');
  source.paths['/item/{id}'].get.responses['200'].content['application/json'].schema.$ref = '#/components/schemas/Missing';
  source.components.schemas = {};
  assert.equal(JSON.stringify(result), before);
  assert.throws(() => narrowApiReadOpenApi(source, ['item:item']));
});

test('reachable malformed or unknown transitive references refuse', () => {
  for (const target of [
    null,
    42,
    'schema',
    { $ref: '#/components/schemas/Missing' },
    { $ref: 42 },
    { $ref: '#/components/parameters/private' },
  ]) {
    const source = JSON.parse(JSON.stringify(fixture()));
    source.components.schemas.Broken = target;
    source.paths['/item/{id}'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Broken' };
    assert.throws(() => narrowApiReadOpenApi(source, ['item:item']));
  }
});

test('scope capture refuses unknown/duplicate IDs and never invokes getters', () => {
  const source = fixture();
  assert.throws(() => narrowApiReadOpenApi(source, ['item:missing']));
  assert.throws(() => narrowApiReadOpenApi(source, ['item:item', 'item:item']));
  let calls = 0;
  const ids = ['item:item'];
  Object.defineProperty(ids, '0', {
    get() {
      calls++;
      return 'item:item';
    },
  });
  assert.throws(() => narrowApiReadOpenApi(source, ids));
  assert.equal(calls, 0);
});
