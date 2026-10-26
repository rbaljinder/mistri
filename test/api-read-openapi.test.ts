import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { createApiReadEnvelopeCodec } from '../packages/mistri/src/server/api/apiReadEnvelope.js';
import { createApiReadKeyCodec } from '../packages/mistri/src/server/api/apiReadKey.js';
import { planApiReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';

const app = () =>
  parseAppConfig(
    {
      id: 'directory',
      name: 'Directory',
      resources: { person: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person', show: ['secret'] } },
      api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'name'], filters: ['name'], sorts: ['id'] } } },
    },
    'spec',
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
        { name: 'secret', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
});

test('actual nullable scalar exposures retain imported scalar types in both integer modes', () => {
  for (const integers of ['number', 'decimal-string'] as const) {
    const definition = app(),
      catalog = schema();
    catalog.dialect = 'postgres';
    const fields = [
      ['quantity', 'INTEGER'],
      ['active', 'BOOLEAN'],
      ['score', 'REAL'],
      ['day', 'DATE'],
      ['name', 'TEXT'],
    ];
    catalog.tables[0].columns = [
      catalog.tables[0].columns[0],
      ...fields.map(([name, type]) => ({ name, type, nullable: true, primaryKey: false })),
    ];
    definition.api!.resources.person.fields = ['id', ...fields.map(([name]) => name)];
    definition.api!.resources.person.filters = fields.map(([name]) => name);
    const imported = readOpenApi(renderApiReadOpenApi(definition, catalog, { integers }).document);
    assert.deepEqual(imported.skipped, []);
    assert.deepEqual(
      imported.resources[0].columns.slice(1).map((column) => [column.name, column.type, column.nullable]),
      [
        ['quantity', integers === 'number' ? 'integer' : 'string', true],
        ['active', 'boolean', true],
        ['score', 'number', true],
        ['day', 'string', true],
        ['name', 'string', true],
      ],
    );
    assert.deepEqual(
      Object.keys(imported.resources[0].filters),
      fields.map(([name]) => name),
    );
  }
});

test('actual composite path keys refuse even when a row has an unrelated key field', () => {
  for (const misleadingKey of [false, true]) {
    const definition = app(),
      catalog = schema();
    catalog.tables[0].columns[1].primaryKey = true;
    if (misleadingKey) {
      catalog.tables[0].columns.push({ name: 'key', type: 'TEXT', nullable: false, primaryKey: false });
      definition.api!.resources.person.fields.push('key');
    }
    const imported = readOpenApi(renderApiReadOpenApi(definition, catalog, { integers: 'number' }).document);
    assert.equal(imported.resources.length, 0);
    assert.match(imported.skipped[0].reason, /composite object key/);
  }
});

test('private read preview describes closed status-specific HTTP error envelopes', () => {
  const document = renderApiReadOpenApi(app(), schema(), { integers: 'decimal-string' }).document;
  const codes = {
    400: 'invalid_request',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    405: 'method_not_allowed',
    429: 'rate_limited',
    503: 'temporarily_unavailable',
  };
  for (const entry of Object.values(document.paths)) {
    const responses = (entry as { get: { responses: Record<string, any> } }).get.responses;
    assert.deepEqual(Object.keys(responses), ['200', ...Object.keys(codes)]);
    for (const [status, code] of Object.entries(codes)) {
      const response = responses[status];
      const validate = new Ajv2020({ strict: true }).compile(response.content['application/json'].schema);
      const body = { error: { code, message: 'The API request could not be completed.' } };
      assert.equal(validate(body), true);
      for (const invalid of [
        { error: 'Not found.' },
        { code, message: body.error.message },
        { error: { ...body.error, code: 'unrecognized' } },
        { error: { code, message: 'Private detail' } },
        { error: { ...body.error, token: 'hidden' } },
        { ...body, account: 'hidden' },
      ]) {
        assert.equal(validate(invalid), false);
      }
      assert.ok(Object.isFrozen(response.content['application/json'].schema.properties.error));
    }
  }
});

test('single text path parameters reuse key codec constraints rather than unconstrained row schemas', () => {
  const definition = app(),
    catalog = schema();
  catalog.tables[0].columns[0].type = 'TEXT';
  const operation = checkApiReadCatalog(definition.api!, definition, catalog).operations.find((operation) => operation.kind === 'item')!;
  const codec = createApiReadKeyCodec(operation, catalog, { integers: 'decimal-string' });
  const preview = renderApiReadOpenApi(definition, catalog, { integers: 'decimal-string' });
  const parameter = (preview.document.paths['/person/{id}'] as any).get.parameters[0];
  assert.deepEqual(parameter, { name: 'id', in: 'path', required: true, ...codec.parameter });
  const validate = new Ajv2020({ strict: true }).compile(parameter.schema);
  for (const value of ['', '.', '..', '\u0000', '\ud800']) assert.equal(validate(value), false);
  for (const value of ['id', '日本語😀', 'a/b']) assert.equal(validate(value), true);
});

test('private read preview has deterministic paths and imports sparse lists conservatively', () => {
  const definition = app(),
    catalog = schema();
  const result = renderApiReadOpenApi(definition, catalog, { integers: 'decimal-string' });
  assert.equal(result.stage, 'private-read-spec-preview');
  assert.equal(result.requestSchemas, 'pending');
  assert.equal(result.document.openapi, '3.1.0');
  assert.deepEqual(Object.keys(result.document.paths), ['/person', '/person/{id}']);
  const roundTrip = readOpenApi(result.document);
  assert.equal(roundTrip.resources.length, 1);
  assert.deepEqual(roundTrip.skipped, []);
  assert.deepEqual(
    roundTrip.resources[0].columns.map((column) => [column.name, column.nullable]),
    [
      ['id', false],
      ['name', true],
    ],
  );
  assert.equal(roundTrip.resources[0].paging.kind, 'cursor');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.ok(Object.isFrozen(result.document.paths));
  catalog.tables[0].columns.push({ name: 'private_added', type: 'TEXT', primaryKey: false, nullable: true });
  definition.views.people.label = 'Presentation changed';
  assert.deepEqual(renderApiReadOpenApi(definition, catalog, { integers: 'decimal-string' }), result);
});

test('generated row schemas enforce the explicit integer strategy and closed projection with real Ajv', () => {
  const ajv = new Ajv2020({ strict: true });
  for (const integers of ['decimal-string', 'number'] as const) {
    const result = renderApiReadOpenApi(app(), schema(), { integers });
    const row = Object.values(result.document.components.schemas)[0];
    const validate = ajv.compile(row);
    assert.equal(validate({ id: integers === 'number' ? 42 : '9223372036854775807', name: 'A' }), true);
    assert.equal(validate({ id: integers === 'number' ? '42' : 42, name: 'A' }), false);
    assert.equal(validate({ id: integers === 'number' ? 42 : '42', name: 'A', secret: 'hidden' }), false);
    assert.equal(validate({ name: 'A' }), false);
  }
});

test('generated list response validates real envelopes through resolved component references', () => {
  for (const integers of ['decimal-string', 'number'] as const) {
    const definition = app(),
      catalog = schema();
    const result = renderApiReadOpenApi(definition, catalog, { integers });
    const path = result.document.paths['/person'] as {
      get: {
        parameters: Array<{ name: string }>;
        responses: { '200': { content: { 'application/json': { schema: Record<string, unknown> } } } };
      };
    };
    const response = path.get.responses['200'].content['application/json'].schema;
    const ajv = new Ajv2020({ strict: true });
    for (const keyword of [
      'x-mistri-max-utf8-bytes',
      'x-mistri-unicode-scalar-values',
      'x-mistri-control-characters',
      'x-mistri-exact-uncapped-count',
      'x-mistri-count-presence',
      'components',
      'x-mistri-primary-key',
      'x-mistri-default-fields',
      'x-mistri-projection-validation',
    ]) {
      ajv.addKeyword({ keyword });
    }
    // Preserve the generated #/components/schemas/Row reference verbatim.
    // components is a container annotation, not a replacement row validator.
    const validate = ajv.compile({ ...response, components: result.document.components });
    const operation = checkApiReadCatalog(definition.api!, definition, catalog).operations[0];
    const encode = (countRequested: boolean) => createApiReadEnvelopeCodec(operation, catalog, { integers, limit: 500, countRequested });
    const row = { id: 42, name: 'Visible', secret: 'projected away' };
    const plain = encode(false).encode({ items: [row], next: null });
    const counted = encode(true).encode({ items: [row], next: 'opaque', count: { value: 10000, exact: true, capped: true } });
    for (const value of [plain, counted]) assert.equal(validate(value), true, JSON.stringify(validate.errors));
    for (const value of [
      { ...plain, items: [{ ...plain.items[0], secret: 'not allowed' }] },
      { ...plain, next: '' },
      { ...plain, items: Array.from({ length: 501 }, () => plain.items[0]) },
      { ...counted, count: { value: 9999, exact: true, capped: true } },
      { ...counted, count: { value: 10000, exact: false, capped: true } },
      { ...counted, count: { value: 10001, exact: true, capped: false } },
    ])
      assert.equal(validate(value), false);
    assert.equal(
      path.get.parameters.some((parameter) => parameter.name === 'fields'),
      true,
    );
    // Generic docs accept either count presence; the request-specific codec
    // still refuses a count when it was not asked for.
    assert.equal(validate(counted), true);
    assert.throws(() => encode(false).encode(counted));
    // Byte-count and cross-field constraints remain annotated runtime rules.
    const oversizedCursor = { ...plain, next: '😀'.repeat(1025) };
    assert.equal(validate(oversizedCursor), true);
    assert.throws(() => encode(false).encode(oversizedCursor));
  }
});

test('unsupported transport shapes refuse rather than inventing a published contract', () => {
  assert.throws(() => renderApiReadOpenApi(app(), schema(), {} as never), /integer representation/);
  const temporal = schema();
  temporal.tables[0].columns[1].type = 'TIMESTAMP';
  assert.throws(() => renderApiReadOpenApi(app(), temporal, { integers: 'decimal-string' }), /cannot represent/);
});

test('sparse list schemas retain complete keys while item and request codecs stay exact', () => {
  for (const composite of [false, true]) {
    const definition = app(),
      catalog = schema();
    if (composite) {
      catalog.tables[0].columns.push({ name: 'part', type: 'INTEGER', nullable: false, primaryKey: true });
      definition.api!.resources.person.fields.push('part');
    }
    const options = { integers: 'decimal-string' as const };
    const document = renderApiReadOpenApi(definition, catalog, options).document;
    const path = document.paths['/person'].get as {
      parameters: Array<{ name: string; schema: object }>;
      responses: { '200': { content: { 'application/json': { schema: object } } } };
    };
    const ajv = new Ajv2020({ strict: true });
    for (const keyword of [
      'components',
      'x-mistri-max-utf8-bytes',
      'x-mistri-unicode-scalar-values',
      'x-mistri-control-characters',
      'x-mistri-exact-uncapped-count',
      'x-mistri-count-presence',
      'x-mistri-primary-key',
      'x-mistri-default-fields',
      'x-mistri-projection-validation',
    ])
      ajv.addKeyword({ keyword });
    const validate = ajv.compile({ ...path.responses['200'].content['application/json'].schema, components: document.components });
    const raw = { id: 42, name: 'Visible', ...(composite ? { part: 7 } : {}), secret: 'hidden' };
    const sparse = planApiReadRequest(definition, catalog, 'list:person', 'fields=id', options);
    const full = planApiReadRequest(definition, catalog, 'list:person', '', options);
    const selected = planApiReadRequest(definition, catalog, 'list:person', 'fields=name', options);
    const sparseEnvelope = sparse.envelope.encode({ items: [raw], next: null });
    assert.equal(validate(sparseEnvelope), true);
    assert.equal(validate(full.envelope.encode({ items: [raw], next: null })), true);
    const sparseRow = sparseEnvelope.items[0];
    assert.equal(Object.hasOwn(sparseRow, 'name'), false);
    assert.equal(validate({ items: [{ ...sparseRow, secret: 'leak' }], next: null }), false);
    assert.equal(validate({ items: [{ name: 'Missing keys' }], next: null }), false);
    if (composite) assert.equal(validate({ items: [{ id: '42' }], next: null }), false);
    // Generic response cannot express its dependency on the request's fields.
    assert.equal(validate({ items: [sparseRow], next: null }), true);
    assert.throws(() => selected.response.encodeRow(sparseRow));
    assert.equal(ajv.compile(document.components.schemas.Row_706572736f6e)(sparseRow), false);
    const fields = ajv.compile(path.parameters.find((parameter) => parameter.name === 'fields')!.schema);
    assert.equal(fields('id,name'), true);
    for (const value of ['', 'id,', 'secret', 'name\n']) assert.equal(fields(value), false);
    assert.throws(() => planApiReadRequest(definition, catalog, 'list:person', 'fields=id,id', options));
  }
});

test('composite item preview describes decoded objects with standard simple exploded serialization', () => {
  for (const integers of ['decimal-string', 'number'] as const) {
    const definition = app(),
      catalog = schema();
    catalog.tables[0].columns[1].primaryKey = true;
    const document = renderApiReadOpenApi(definition, catalog, { integers }).document;
    assert.deepEqual(Object.keys(document.paths), ['/person', '/person/{key}']);
    const path = document.paths['/person/{key}'] as { get: { parameters: Array<Record<string, unknown>> } };
    const parameter = path.get.parameters[0];
    assert.equal(parameter.name, 'key');
    assert.equal(parameter.in, 'path');
    assert.equal(parameter.required, true);
    assert.equal(parameter.style, 'simple');
    assert.equal(parameter.explode, true);
    assert.deepEqual(parameter['x-mistri-key-columns'], ['id', 'name']);
    const validate = new Ajv2020({ strict: true }).compile(parameter['x-mistri-decoded-key-schema'] as object);
    const operation = checkApiReadCatalog(definition.api!, definition, catalog).operations.find((operation) => operation.kind === 'item')!;
    const codec = createApiReadKeyCodec(operation, catalog, { integers });
    const key = { id: integers === 'number' ? 42 : '9223372036854775807', name: 'A,=/雪%' };
    const segment = codec.encode(key);
    assert.ok(segment.includes('name=A%2C%3D%2F%E9%9B%AA%25'));
    assert.equal(validate(codec.decode(segment)), true);
    assert.equal(validate(codec.decode(segment.split(',').reverse().join(','))), true);
    assert.equal(validate({ id: key.id }), false);
    assert.equal(validate({ ...key, secret: 'hidden' }), false);
    for (const invalid of ['id=42', 'id=42,name=a,name=b', 'id=042,name=a', 'id=42,name=%FF']) {
      assert.throws(() => codec.decode(invalid));
    }
    // Object validation precedes serialization; raw segment strings are not inputs.
    const ajv = new Ajv2020({ strict: true });
    assert.equal(ajv.compile(parameter.schema as object)(key), true);
    assert.equal(ajv.compile(parameter.schema as object)('id=42'), false);
    assert.ok(Object.isFrozen(parameter['x-mistri-decoded-key-schema']));
  }
});

test('reserved resource namespaces cannot occupy future view or command paths', () => {
  for (const resource of ['views', 'commands']) {
    const definition = app(),
      catalog = schema();
    definition.resources = { [resource]: definition.resources!.person };
    definition.api!.resources = { [resource]: definition.api!.resources.person };
    if ('table' in definition.views.people) definition.views.people.table = resource;
    Object.assign(catalog.tables[0], { id: resource, name: resource });
    assert.throws(() => renderApiReadOpenApi(definition, catalog, { integers: 'decimal-string' }), /reserved route namespace/);
  }
});

test('named sorts and totals each refuse independently of tabs', () => {
  for (const change of [{ sorts: [{ label: 'Newest', sort: 'id desc' }] }, { totals: ['id'] }]) {
    const definition = app();
    definition.api!.views = [{ view: 'people' }];
    Object.assign(definition.views.people, change);
    assert.throws(() => renderApiReadOpenApi(definition, schema(), { integers: 'number' }), /named sorts or totals/);
  }
});

test('view tab parameter uses the same checked identifiers and default as request planning', () => {
  const definition = app();
  definition.api!.views = [{ view: 'people' }];
  Object.assign(definition.views.people, {
    tabs: [
      { label: 'First group', query: 'id > 2' },
      { label: 'All', query: '' },
    ],
  });
  const result = renderApiReadOpenApi(definition, schema(), { integers: 'number' });
  const view = result.document.paths['/views/people'] as { get: { parameters: Array<{ name: string; schema: object }> } };
  const tab = view.get.parameters.find((parameter) => parameter.name === 'segment')!;
  assert.deepEqual(tab.schema, { type: 'string', enum: ['first-group', 'all'], default: 'first-group' });
  const validate = new Ajv2020().compile(tab.schema);
  assert.equal(validate('first-group'), true);
  assert.equal(validate('First group'), false);
  const resource = result.document.paths['/person'] as { get: { parameters: Array<{ name: string }> } };
  assert.equal(
    resource.get.parameters.some((parameter) => parameter.name === 'segment' || parameter.name === 'tab'),
    false,
  );
});

test('sort parameter schema only admits declared field spellings and directions', () => {
  const result = renderApiReadOpenApi(app(), schema(), { integers: 'number' });
  const resource = result.document.paths['/person'] as { get: { parameters: Array<{ name: string; schema: object }> } };
  const sort = resource.get.parameters.find((parameter) => parameter.name === 'sort')!;
  const validate = new Ajv2020().compile(sort.schema);
  for (const value of ['id', '-id']) assert.equal(validate(value), true);
  for (const value of ['', 'name', 'secret', '+id', 'id desc', 'id,', 'id\n']) assert.equal(validate(value), false);
});

test('exposed list view gets a distinct operation and shares its resource row reference', () => {
  const definition = app();
  definition.api!.views = [{ view: 'people' }];
  const result = renderApiReadOpenApi(definition, schema(), { integers: 'number' });
  assert.deepEqual(Object.keys(result.document.paths), ['/person', '/person/{id}', '/views/people']);
  assert.equal(Object.keys(result.document.components.schemas).length, 2);
  const paths = result.document.paths as Record<
    string,
    {
      get: {
        operationId: string;
        parameters: Array<{ name: string }>;
        responses: {
          '200': { content: { 'application/json': { schema: { $ref?: string; properties?: { items: { items: { $ref: string } } } } } } };
        };
      };
    }
  >;
  const response = (path: string) => paths[path].get.responses['200'].content['application/json'].schema;
  assert.equal(response('/person').properties!.items.items.$ref, response('/views/people').properties!.items.items.$ref);
  assert.notEqual(response('/person/{id}').$ref, response('/views/people').properties!.items.items.$ref);
  assert.equal(new Set(Object.values(paths).map((path) => path.get.operationId)).size, 3);
  assert.equal(
    paths['/person/{id}'].get.parameters.some((parameter) => parameter.name === 'fields'),
    false,
  );
  assert.equal(
    paths['/views/people'].get.parameters.some((parameter) => parameter.name === 'fields'),
    true,
  );
});

test('item key schemas use the actual scalar encoder and app IDs are URL escaped', () => {
  const ajv = new Ajv2020({ strict: true });
  for (const [type, value, wrong] of [
    ['TEXT', 'key/a?b', 1],
    ['INTEGER', 42, '42'],
  ] as const) {
    const definition = app(),
      catalog = schema();
    definition.id = 'directory/part ?#%é';
    catalog.tables[0].columns[0].type = type;
    const result = renderApiReadOpenApi(definition, catalog, { integers: 'number' });
    assert.equal(result.document.servers[0].url, `/api/apps/${encodeURIComponent(definition.id)}/v1`);
    const item = result.document.paths['/person/{id}'] as {
      get: { parameters: Array<{ name: string; in: string; required: boolean; schema: object }> };
    };
    const parameter = item.get.parameters[0];
    assert.equal(parameter.name, 'id');
    assert.equal(parameter.in, 'path');
    assert.equal(parameter.required, true);
    const validate = ajv.compile(parameter.schema);
    assert.equal(validate(value), true);
    assert.equal(validate(wrong), false);
    assert.equal(validate(null), false);
  }
  const floatKey = schema();
  floatKey.tables[0].columns[0].type = 'REAL';
  assert.throws(() => renderApiReadOpenApi(app(), floatKey, { integers: 'number' }), /item key/);
});
