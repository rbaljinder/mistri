/** Pure command API document: every rendered schema is compiled and checked
 * against the payloads the command transport actually produces and accepts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { renderApiCommandOpenApi } from '../packages/mistri/src/server/api/apiCommandOpenApi.js';
import { createApiCommandRequestMapper } from '../packages/mistri/src/server/api/apiCommandRequest.js';
import { apiTransportProblem, commandProblem, projectApiCommandAnswer } from '../packages/mistri/src/server/api/apiCommandResponse.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

function fixture(many: boolean, integers: 'decimal-string' | 'number') {
  const schema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'Logical',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'part', type: 'TEXT', primaryKey: true, nullable: false },
          { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
          { name: 'revision', type: 'INTEGER', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  const input = { note: { type: 'text' as const, optional: true } };
  const app = parseTestApp(
    {
      id: 'app',
      name: 'App',
      sources: { business: { connection: 'private' } },
      resources: { item: { access: 'write' } },
      auth: { roles: { editor: { read: true, commands: ['edit'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'fixture',
  );
  app.api = parseTestApi(
    { version: 1, roles: ['editor'], commands: [{ id: 'edit', version: 1, target: 'item', input, ...(many ? { targets: 'many' } : {}) }] },
    ['editor'],
  )!;
  const registry = defineCommands({
    edit: defineCommand({
      source: 'business',
      target: 'item',
      input,
      ...(many ? { targets: 'many' as const } : {}),
      output: shape({ ok: bool() }),
      handle() {
        return { ok: true };
      },
    }),
  });
  const evidence = { connectionFor: () => 'private', writableConnection: () => true, transactionalConnection: () => true };
  return {
    doc: renderApiCommandOpenApi(app, schema, registry, evidence, { integers }),
    mapper: createApiCommandRequestMapper(app, schema, registry, evidence, { integers }),
  };
}
type Doc = ReturnType<typeof fixture>['doc'];
const compile = (doc: Doc, schema: unknown) =>
  new Ajv2020({ strict: false }).compile({ ...(schema as object), components: { schemas: doc.schemas } });
const op = (doc: Doc, path: string, method: 'post' | 'get') => (doc.paths[path] as Record<string, any>)[method];
const jsonSchema = (content: any, type = 'application/json') => content[type].schema;
const onePath = '/item/{key}/commands/edit/v1',
  manyPath = '/item/commands/edit/v1';
const receiptPath = '/commands/edit/v1/receipts/{idempotencyKey}';

test('paths follow the transport grammar; a many command also takes the one-target route', () => {
  assert.deepEqual(Object.keys(fixture(false, 'decimal-string').doc.paths).sort(), [receiptPath, onePath, `${onePath}/prepare`].sort());
  const doc = fixture(true, 'number').doc;
  assert.deepEqual(Object.keys(doc.paths).sort(), [receiptPath, manyPath, onePath, `${onePath}/prepare`].sort());
  const one = op(doc, onePath, 'post');
  assert.deepEqual(
    one.parameters.map((parameter: { name: string; in: string }) => `${parameter.in}:${parameter.name}`),
    ['path:key', 'header:If-Match', 'header:Idempotency-Key'],
  );
  assert.equal(one.parameters[0].style, 'simple');
  assert.equal(one.parameters[0].explode, true);
  assert.deepEqual(
    op(doc, manyPath, 'post').parameters.map((parameter: { name: string }) => parameter.name),
    ['Idempotency-Key'],
  );
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.paths) && Object.isFrozen(doc.schemas));
  const statuses = Object.keys(one.responses).sort();
  assert.deepEqual(statuses, ['200', '400', '401', '403', '404', '405', '409', '410', '422', '428', '429', '500', '503']);
});

test('request bodies accept what the mapper accepts: the input object, and lenient lossless many-target keys', () => {
  const { doc, mapper } = fixture(true, 'decimal-string');
  const oneBody = compile(doc, jsonSchema(op(doc, onePath, 'post').requestBody.content));
  assert.equal(oneBody({ note: 'hi' }), true);
  assert.equal(oneBody({}), true);
  assert.equal(oneBody({ unknown: 1 }), false);
  const manyBody = compile(doc, jsonSchema(op(doc, manyPath, 'post').requestBody.content));
  for (const id of ['1', 1]) {
    const body = { targets: [{ key: { part: 'a', id }, version: 0 }], input: {} };
    assert.equal(manyBody(body), true, String(id));
    assert.ok(
      mapper.map(
        { kind: 'many', method: 'POST', appId: 'app', version: 1, resource: 'item', command: 'edit', commandVersion: 1 },
        { idempotencyKey: 'mapping_request_0001' },
        body,
      ),
    );
  }
  for (const body of [
    { targets: [], input: {} },
    { targets: [{ key: { part: 'a', id: '1' } }], input: {} },
    { targets: [{ key: { part: 'a', id: '1' }, version: -1 }], input: {} },
    { targets: [{ key: { part: 'a', id: '1' }, version: 0 }] },
    { targets: [{ key: { part: 'a', id: '1' }, version: 0 }], input: {}, extra: 1 },
  ]) {
    assert.equal(manyBody(body), false, JSON.stringify(body));
  }
});

test('responses describe the projected receipts, recovered keys in the chosen integer form, and every problem body', () => {
  for (const integers of ['decimal-string', 'number'] as const) {
    const { doc, mapper } = fixture(false, integers);
    const executed = op(doc, onePath, 'post').responses;
    assert.deepEqual(Object.keys(executed['200'].headers), ['Idempotent-Replayed']);
    const execute = compile(doc, jsonSchema(executed['200'].content));
    const applied = {
      status: 'applied',
      receiptId: 'receipt-1',
      command: 'edit',
      commandVersion: 1,
      resource: 'item',
      key: { part: 'a', id: 1 },
      result: { ok: true },
    };
    for (const replayed of [false, true]) assert.equal(execute(projectApiCommandAnswer('execute', { ...applied, replayed }).value), true);
    assert.equal(execute({ receipt: { id: 'receipt-1', status: 'applied', replayed: false }, result: { ok: 'yes' } }), false);
    const recover = compile(doc, jsonSchema(op(doc, receiptPath, 'get').responses['200'].content));
    const { key: _key, ...stored } = applied;
    const recovered = projectApiCommandAnswer('recover', { ...stored, targets: [{ part: 'a', id: 1 }], recovered: true }, (key) =>
      mapper.targetKey('edit', key),
    ).value;
    assert.equal(recover(recovered), true, integers);
    // The other representation is not what this API answers.
    const wrong = { ...(recovered as object), targets: [{ part: 'a', id: integers === 'number' ? '1' : 1 }] };
    assert.equal(recover(wrong), false, integers);
    const problem = compile(doc, jsonSchema(executed['409'].content, 'application/problem+json'));
    assert.equal(problem(commandProblem('stale_record', 'not_applied', 'reason', { part: 'a', id: 1 })), true);
    assert.equal(problem(apiTransportProblem('precondition_required').value), true);
    assert.equal(problem(projectApiCommandAnswer('recover', { status: 'not_found', outcome: 'unknown' }).value), true);
    assert.equal(problem({ type: 'urn:mistri:problem:x', title: 't', status: 409, code: 'x', detail: 'echoed input' }), false);
  }
});
