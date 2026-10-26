import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { previewApiMcpReadTools } from '../packages/mistri/src/server/api/apiMcpReadTools.js';
import { planApiReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';

const app = () =>
  parseAppConfig(
    {
      id: 'directory',
      name: 'Directory',
      resources: { person: {} },
      auth: { roles: { reader: { read: true }, nobody: {} } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person' } },
      api: {
        version: 1,
        roles: ['reader'],
        resources: { person: { fields: ['id', 'description'], filters: ['description'], sorts: ['id'] } },
        views: ['people'],
      },
    },
    'mcp',
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
        { name: 'description', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'secret', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
});
const scope = { operations: ['list:person', 'item:person', 'view:people'], roles: ['reader'] };
const options = { integers: 'decimal-string' as const };
const object = (value: unknown) => value as Record<string, any>;

test('private discovery narrows explicit operations and whole eligible roles without defaults', () => {
  const definition = app(),
    db = schema();
  const result = previewApiMcpReadTools(definition, db, options, scope);
  assert.equal(result.tools.length, 3);
  assert.equal(result.authorization, 'pending');
  assert.equal(result.execution, 'pending');
  assert.equal(result.cursorVerification, 'pending');
  for (const narrowed of [
    { ...scope, roles: [] },
    { ...scope, operations: [] },
    { ...scope, roles: ['nobody'] },
  ])
    assert.equal(previewApiMcpReadTools(definition, db, options, narrowed).tools.length, 0);
  assert.equal(previewApiMcpReadTools(definition, db, options, { ...scope, operations: ['item:person'] }).tools.length, 1);
  assert.ok(Object.isFrozen(result.tools) && Object.isFrozen(result.tools[0].inputSchema));
  const visible = JSON.stringify(result.tools);
  for (const hidden of ['secret', 'eligibleRoles', 'standing-contract', 'connection', 'bearer'])
    assert.equal(visible.includes(hidden), false);
  assert.deepEqual(
    result.bindings.map((binding) => binding.operationId),
    scope.operations,
  );
});

test('names are bounded and stable across labels/version, separated by App identity', () => {
  const definition = app(),
    db = schema();
  const first = previewApiMcpReadTools(definition, db, options, scope);
  definition.name = 'New title';
  definition.views.people.label = 'New view';
  definition.api!.version = 2;
  const changed = previewApiMcpReadTools(definition, db, options, scope);
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    changed.tools.map((tool) => tool.name),
  );
  for (const tool of first.tools) assert.match(String(tool.name), /^[A-Za-z0-9_-]{1,64}$/);
  definition.id = 'other';
  const other = previewApiMcpReadTools(definition, db, options, scope);
  assert.ok(other.tools.every((tool, index) => tool.name !== first.tools[index].name));
});

test('typed arrays and composite key objects reuse actual schemas; properties named description survive', () => {
  const definition = app(),
    db = schema();
  db.tables[0].columns[1].primaryKey = true;
  const result = previewApiMcpReadTools(definition, db, options, scope);
  const list = object(result.tools[0].inputSchema),
    item = object(result.tools[1].inputSchema);
  assert.equal(list.properties.description.type, 'array');
  assert.equal(list.properties.description.items.type, 'string');
  assert.equal(list.properties.limit.type, 'integer');
  assert.deepEqual(item.properties.key.required, ['id', 'description']);
  assert.equal(item.properties.key.properties.id.type, 'string');
  assert.equal(JSON.stringify(result.tools).includes('"$ref"'), false);
});

test('real sparse/default rows validate against list schema without weakening full item requiredness', () => {
  const definition = app(),
    db = schema(),
    result = previewApiMcpReadTools(definition, db, options, scope);
  const ajv = new Ajv2020({ strict: false });
  const list = ajv.compile(result.tools[0].outputSchema as object),
    item = ajv.compile(result.tools[1].outputSchema as object);
  const sparse = planApiReadRequest(definition, db, 'list:person', 'fields=id', options);
  const full = planApiReadRequest(definition, db, 'list:person', '', options);
  const sparseRow = sparse.response.encodeRow({ id: 1 });
  const fullRow = full.response.encodeRow({ id: 1, description: 'hello' });
  assert.ok(list({ items: [sparseRow], next: null }));
  assert.ok(list({ items: [fullRow], next: null }));
  assert.ok(item(fullRow));
  assert.equal(item(sparseRow), false);
  assert.equal(list({ items: [{ ...fullRow, secret: 'hidden' }], next: null }), false);
  assert.equal(list({ items: [{ id: '1', description: null }], next: null }), false);
  assert.throws(() => full.response.encodeRow({ id: 1 }));
});

test('hostile/missing/duplicate scope data refuses without invoking accessors', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('private');
  };
  for (const value of [
    undefined,
    {},
    { operations: [] },
    { ...scope, extra: true },
    { ...scope, operations: ['list:person', 'list:person'] },
    { ...scope, roles: ['reader', 'reader'] },
    Object.defineProperty({}, 'roles', { get: trap }),
    new Proxy({}, { get: trap, ownKeys: trap }),
  ])
    assert.throws(() => previewApiMcpReadTools(app(), schema(), options, value));
  assert.equal(calls, 0);
});

test('text keys keep dot-segment refusal and numeric filters keep typed-array/range unions', () => {
  const definition = app(),
    db = schema();
  definition.api!.resources.person.filters = ['id'];
  const numeric = previewApiMcpReadTools(definition, db, options, scope);
  const filter = object(numeric.tools[0].inputSchema).properties.id;
  assert.equal(filter.anyOf[0].type, 'array');
  assert.equal(filter.anyOf[0].items.type, 'string');
  assert.equal(filter.anyOf[1].type, 'string');
  db.tables[0].columns[0].type = 'TEXT';
  const text = previewApiMcpReadTools(definition, db, options, scope);
  const input = new Ajv2020({ strict: false }).compile(text.tools[1].inputSchema as object);
  assert.ok(input({ id: '日本語' }));
  assert.equal(input({ id: '.' }), false);
  assert.equal(input({ id: '..' }), false);
  assert.equal(input({ id: 'valid', sql: 'query' }), false);
});
