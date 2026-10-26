import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  OpenApiError,
  readOpenApi,
  type HttpCatalog,
  type HttpColumn,
  type HttpColumnType,
  type HttpFilter,
  type HttpPaging,
  type HttpResource,
  type HttpSkip,
} from '../packages/engine/src/adapters/http/openapi.js';

/* A small support-desk API that uses each part of the supported subset once,
   and each refusal once: offset and cursor paging, search, a documented sort,
   filters by column, allOf, int64, 3.1 nullability, a nested document, a
   nested collection, a lone list, a oneOf row and a remote $ref. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const catalog: HttpCatalog = readOpenApi(spec);
const resource = (name: string): HttpResource => {
  const found = catalog.resources.find((each) => each.name === name);
  assert.ok(found, `no resource "${name}"`);
  return found;
};
const columns = (name: string): Record<string, HttpColumn> => Object.fromEntries(resource(name).columns.map((each) => [each.name, each]));

test('only exact scalar-or-null unions become nullable scalar columns', () => {
  const inspect = (property: object) => {
    const row = { type: 'object', required: ['id', 'value'], properties: { id: { type: 'string' }, value: property } };
    const answer = (schema: object) => ({ responses: { 200: { content: { 'application/json': { schema } } } } });
    return readOpenApi({
      openapi: '3.1.0',
      info: { title: 'Unions', version: '1' },
      paths: {
        '/rows': { get: answer({ type: 'array', items: row }) },
        '/rows/{id}': { get: answer(row) },
      },
    }).resources[0].columns[1];
  };
  for (const arms of [
    [{ type: 'null' }, { type: 'string', enum: ['a'], readOnly: true }],
    [{ type: 'string', enum: ['a'], readOnly: true }, { type: 'null' }],
  ]) {
    assert.deepEqual(inspect({ anyOf: arms, description: 'Value' }), {
      name: 'value',
      type: 'string',
      nullable: true,
      readOnly: true,
      allowed: ['a'],
      comment: 'Value',
    });
  }
  for (const property of [
    { anyOf: [{ type: 'string' }, { type: 'number' }] },
    { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'boolean' }] },
    { anyOf: [{ type: 'object' }, { type: 'null' }] },
    { anyOf: [{ anyOf: [{ type: 'string' }] }, { type: 'null' }] },
    { anyOf: [{ type: 'string' }, { type: 'null', not: {} }] },
    { anyOf: [{ type: 'string' }, { type: 'null' }], not: { type: 'null' } },
  ])
    assert.equal(inspect(property).type, 'json');
});

test('a collection and its item become one resource, named by the collection', () => {
  assert.equal(catalog.title, 'Desk API');
  assert.equal(catalog.version, '1.2.0');
  assert.deepEqual(
    catalog.resources.map((each) => each.name),
    ['contacts', 'tickets'],
  );
  const contacts = resource('contacts');
  assert.deepEqual(
    { list: contacts.list, item: contacts.item, key: contacts.key, rows: contacts.rows },
    { list: '/contacts', item: '/contacts/{id}', key: 'id', rows: '' },
  );
  assert.equal(contacts.comment, 'Contacts, newest first');
});

test("columns carry the schema's types, nullability and documented values", () => {
  const contact = columns('contacts');
  assert.deepEqual(contact.id, { name: 'id', type: 'uuid', nullable: false, readOnly: true });
  assert.deepEqual(contact.name, { name: 'name', type: 'string', nullable: false, readOnly: false, comment: 'Full name' });
  // 3.1 says null as a type; a property the schema does not require may be absent, which reads as null.
  assert.equal(contact.email.nullable, true);
  assert.equal(contact.tag.nullable, true);
  assert.deepEqual(contact.status.allowed, ['lead', 'customer', 'churned']);
  assert.equal(contact.status.nullable, false);
  const types: HttpColumnType[] = [contact.score.type, contact.vip.type, contact.created_at.type, contact.birthday.type];
  assert.deepEqual(types, ['number', 'boolean', 'datetime', 'date']);
  // A nested object is one document: shown whole, never edited as a field.
  assert.deepEqual({ type: contact.address.type, readOnly: contact.address.readOnly }, { type: 'json', readOnly: true });
});

test('allOf parts merge into one row, and an int64 key stays text', () => {
  assert.deepEqual(
    resource('tickets').columns.map((each) => each.name),
    ['subject', 'priority', 'labels', 'meta', 'id', 'contact_id'],
  );
  const ticket = columns('tickets');
  assert.deepEqual(ticket.id, { name: 'id', type: 'bigint', nullable: false, readOnly: false });
  assert.equal(ticket.subject.nullable, false);
  assert.deepEqual([ticket.labels.type, ticket.meta.type], ['json', 'json']);
});

test('what a list can do is read from its parameters: filters by column, search, a documented sort', () => {
  const contacts = resource('contacts');
  const status: HttpFilter = { param: 'status', ops: ['='] };
  assert.deepEqual(contacts.filters, { status, tag: { param: 'tag', ops: ['='] } });
  assert.equal(contacts.search, 'q');
  assert.deepEqual(contacts.sort, { param: 'sort', values: ['created_at', '-created_at', 'name'] });
  // A list-valued parameter takes one value or several.
  assert.deepEqual(resource('tickets').filters, { contact_id: { param: 'contact_id', ops: ['=', 'in'] } });
  assert.equal(resource('tickets').sort, undefined);
});

test('paging is inferred, and every inference is listed for the author to confirm', () => {
  const offset: HttpPaging = { kind: 'offset', offset: 'offset', limit: 'limit' };
  assert.deepEqual(resource('contacts').paging, offset);
  assert.deepEqual(resource('tickets').paging, { kind: 'cursor', param: 'cursor', next: '/next_cursor', limit: 'limit' });
  assert.equal(resource('tickets').rows, '/data');
  assert.equal(resource('contacts').guesses.length, 1);
  assert.match(resource('tickets').guesses[0], /^paging: cursor/);
});

test("a column named for another resource's key is guessed to reference it, and says so", () => {
  // `contact_id` beside a `contacts` resource keyed by text: a name, not a foreign key the spec declares.
  assert.equal(columns('tickets').contact_id.references, 'contacts');
  assert.deepEqual(resource('tickets').guesses.slice(1), ['references: contact_id → contacts, by its name']);
  assert.equal(
    Object.values(columns('contacts')).some((column) => column.references),
    false,
  );
});

test('whatever is outside the subset is skipped with its reason, never guessed at', () => {
  const skipped: HttpSkip[] = catalog.skipped;
  const reasons = Object.fromEntries(skipped.map((each) => [each.operation, each.reason]));
  assert.deepEqual(Object.keys(reasons), ['GET /accounts/{id}/notes', 'GET /events', 'GET /health', 'GET /partners']);
  assert.match(reasons['GET /accounts/{id}/notes'], /nested collections/);
  assert.match(reasons['GET /events'], /oneOf/);
  assert.match(reasons['GET /health'], /no item operation/);
  assert.match(reasons['GET /partners'], /remote \$ref/);
});

test('a list and an item that answer different rows are not one resource', () => {
  const row = (id: object) => ({ type: 'object', properties: { id } });
  const answer = (schema: object) => ({ responses: { 200: { description: '', content: { 'application/json': { schema } } } } });
  const result = readOpenApi({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: answer({ type: 'array', items: row({ type: 'string' }) }) },
      '/a/{id}': { get: answer(row({ type: 'integer' })) },
    },
  });
  assert.deepEqual(result.resources, []);
  assert.match(result.skipped[0].reason, /different row shapes/);
});

test('sparse closed lists may omit item-required properties without weakening row-type checks', () => {
  const row = () => ({
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name'],
    properties: { id: { type: 'string' }, name: { type: 'string' } },
  });
  const answer = (schema: object) => ({ responses: { 200: { description: '', content: { 'application/json': { schema } } } } });
  const read = (list: object, item: object) =>
    readOpenApi({
      openapi: '3.1.0',
      info: { title: 'Sparse', version: '1' },
      paths: {
        '/people': { get: answer({ type: 'array', items: list }) },
        '/people/{id}': { get: answer(item) },
      },
    });
  const sparse = { ...row(), required: ['id'] };
  assert.deepEqual(
    read(sparse, row()).resources[0].columns.map((column) => [column.name, column.nullable]),
    [
      ['id', false],
      ['name', true],
    ],
  );
  for (const changed of [
    { ...row(), required: [] },
    { ...row(), additionalProperties: true },
    { ...row(), minProperties: 2 },
    { ...row(), properties: { id: { type: 'string' } } },
    { ...row(), properties: { ...row().properties, name: { type: 'integer' } } },
    { ...row(), properties: { ...row().properties, name: { type: ['string', 'null'] } } },
    { ...row(), 'x-unknown-constraint': true },
  ])
    assert.match(read(sparse, changed).skipped[0].reason, /different row shapes/);
  const metadata = {
    'x-mistri-primary-key': ['id'],
    'x-mistri-default-fields': ['id', 'name'],
    'x-mistri-projection-validation': 'request-codec-requires-exact-selected-fields-plus-complete-key',
  };
  assert.equal(read({ ...sparse, ...metadata }, row()).resources.length, 1);
  for (const changed of [
    { 'x-mistri-primary-key': ['name'] },
    { 'x-mistri-default-fields': ['id'] },
    { 'x-mistri-projection-validation': 'trust-me' },
  ]) {
    assert.match(read({ ...sparse, ...metadata, ...changed }, row()).skipped[0].reason, /different row shapes/);
  }
});

test('OpenAPI 3.0 says null with nullable: true', () => {
  const answer = (schema: object) => ({ responses: { 200: { description: '', content: { 'application/json': { schema } } } } });
  const row = {
    type: 'object',
    required: ['id', 'name'],
    properties: { id: { type: 'string' }, name: { type: 'string', nullable: true } },
  };
  const result = readOpenApi({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/people': { get: answer({ type: 'array', items: row }) },
      '/people/{id}': { get: answer(row) },
    },
  });
  assert.deepEqual(
    result.resources[0].columns.map((each) => [each.name, each.nullable]),
    [
      ['id', false],
      ['name', true],
    ],
  );
});

test('a document outside OpenAPI 3.0 and 3.1 is refused, naming the fix', () => {
  assert.throws(
    () => readOpenApi({ swagger: '2.0', paths: {} }),
    (error: unknown) => error instanceof OpenApiError && /Swagger 2\.0/.test(error.message),
  );
  assert.throws(() => readOpenApi({ openapi: '2.1.0', paths: {} }), /OpenAPI 3\.0 and 3\.1/);
  assert.throws(() => readOpenApi({ openapi: '3.1.0' }), /no "paths"/);
  assert.throws(() => readOpenApi([]), /JSON object/);
});
