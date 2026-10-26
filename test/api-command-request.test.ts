/** Pure route → envelope mapping: every mapped envelope is checked against the
 * existing envelope contract, so the mapping cannot drift from the executor's. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiCommandRequestMapper } from '../packages/mistri/src/server/api/apiCommandRequest.js';
import { createApiCommandEnvelopeBundle } from '../packages/mistri/src/server/api/apiCommandEnvelope.js';
import { parseApiCommandRoute } from '../packages/mistri/src/server/api/apiCommandRoute.js';
import { ApiCommandRequestError } from '../packages/mistri/src/server/api/apiCommandHeaders.js';
import { parseCommandRecoveryRequest } from '../packages/mistri/src/server/commands/commandPayload.js';
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
  let calls = 0;
  const registry = defineCommands({
    edit: defineCommand({
      source: 'business',
      target: 'item',
      input,
      ...(many ? { targets: 'many' as const } : {}),
      output: shape({ ok: bool() }),
      validate() {
        calls++;
      },
      availability() {
        calls++;
        return [];
      },
      handle() {
        calls++;
        return { ok: true };
      },
    }),
  });
  const evidence = { connectionFor: () => 'private', writableConnection: () => true, transactionalConnection: () => true };
  return {
    mapper: createApiCommandRequestMapper(app, schema, registry, evidence, { integers }),
    contract: createApiCommandEnvelopeBundle(app, schema, registry, evidence).operations[0],
    calls: () => calls,
  };
}
const idempotencyKey = 'mapping_request_0001';
const code = (expected: string) => (error: unknown) => error instanceof ApiCommandRequestError && error.code === expected;
const one = (rawKey: string) => parseApiCommandRoute(`/api/apps/app/v1/item/${rawKey}/commands/edit/v1`);
const manyRoute = parseApiCommandRoute('/api/apps/app/v1/item/commands/edit/v1');

test('a one-target route, its headers and body become the envelope the executor already accepts', () => {
  for (const integers of ['decimal-string', 'number'] as const) {
    const f = fixture(false, integers);
    const envelope = f.mapper.map(one('part=a%2Cb,id=41'), { expectedVersion: 3, idempotencyKey }, { note: ' hi ' });
    assert.deepEqual(envelope, {
      command: 'edit',
      commandVersion: 1,
      key: { part: 'a,b', id: integers === 'number' ? 41 : '41' },
      expectedVersion: 3,
      idempotencyKey,
      input: { note: ' hi ' },
    });
    assert.ok(Object.isFrozen(envelope));
    f.contract.validateExecuteRequest(envelope);
    assert.equal(f.calls(), 0);
  }
});

test('a many-target body maps to aligned keys and revisions under the same wire key policy', () => {
  const f = fixture(true, 'decimal-string');
  const body = {
    targets: [
      { key: { part: 'a', id: '1' }, version: 0 },
      { key: { id: '9007199254740993', part: 'b' }, version: 7 },
    ],
    input: {},
  };
  const envelope = f.mapper.map(manyRoute, { idempotencyKey }, body);
  assert.deepEqual(envelope, {
    command: 'edit',
    commandVersion: 1,
    keys: [
      { part: 'a', id: '1' },
      { part: 'b', id: '9007199254740993' },
    ],
    expectedVersions: [0, 7],
    idempotencyKey,
    input: {},
  });
  f.contract.validateExecuteRequest(envelope);
  // A many command still takes the one-target route: one key is the same operation.
  f.contract.validateExecuteRequest(f.mapper.map(one('part=a,id=1'), { expectedVersion: 0, idempotencyKey }, {}));
  // Body keys accept a safe number or a canonical decimal string, as the envelope
  // contract does; the chosen representation decides the result, and nothing
  // that would lose precision is ever accepted.
  const bodyKeys = (mapper: typeof f.mapper, id: unknown) => {
    const mapped = mapper.map(manyRoute, { idempotencyKey }, { targets: [{ key: { part: 'a', id }, version: 0 }], input: {} });
    assert.ok('keys' in mapped);
    return mapped.keys;
  };
  assert.deepEqual(bodyKeys(f.mapper, 1), [{ part: 'a', id: '1' }]);
  assert.throws(() => bodyKeys(f.mapper, Number.MAX_SAFE_INTEGER + 1), code('invalid_request'));
  const numeric = fixture(true, 'number');
  assert.deepEqual(bodyKeys(numeric.mapper, 1), [{ part: 'a', id: 1 }]);
  assert.deepEqual(bodyKeys(numeric.mapper, '1'), [{ part: 'a', id: 1 }]);
  for (const id of ['9007199254740993', Number.MAX_SAFE_INTEGER + 1, '01', 1.5]) {
    assert.throws(() => bodyKeys(numeric.mapper, id), code('invalid_request'), String(id));
  }
  assert.throws(
    () => numeric.mapper.map(one('part=a,id=9007199254740993'), { expectedVersion: 0, idempotencyKey }, {}),
    code('invalid_request'),
  );
});

test('recovery maps to the scope-only envelope and never takes a target, revision or input', () => {
  const f = fixture(false, 'decimal-string');
  const envelope = f.mapper.map(parseApiCommandRoute(`/api/apps/app/v1/commands/edit/v1/receipts/${idempotencyKey}`), {}, undefined);
  assert.deepEqual(envelope, { command: 'edit', commandVersion: 1, idempotencyKey });
  assert.deepEqual(parseCommandRecoveryRequest(envelope), envelope);
});

test('a route that names no exposed targeted operation is not found; malformed keys and bodies are invalid', () => {
  const f = fixture(false, 'decimal-string'),
    headers = { expectedVersion: 0, idempotencyKey };
  for (const path of [
    '/api/apps/other/v1/item/part=a,id=1/commands/edit/v1',
    '/api/apps/app/v2/item/part=a,id=1/commands/edit/v1',
    '/api/apps/app/v1/team/part=a,id=1/commands/edit/v1',
    '/api/apps/app/v1/item/part=a,id=1/commands/missing/v1',
  ]) {
    assert.throws(() => f.mapper.map(parseApiCommandRoute(path), headers, {}), code('not_found'), path);
  }
  assert.throws(
    () => f.mapper.map(manyRoute, { idempotencyKey }, { targets: [{ key: { part: 'a', id: '1' }, version: 0 }], input: {} }),
    code('not_found'),
  );
  // A control character in the segment never gets this far: the route refuses it.
  for (const rawKey of ['part=a', 'part=a,id=1,extra=2', 'part=a,part=b,id=1', 'id=1.5,part=a', 'part=,id=1']) {
    assert.throws(() => f.mapper.map(one(rawKey), headers, {}), code('invalid_request'), rawKey);
  }
  const many = fixture(true, 'decimal-string'),
    target = { key: { part: 'a', id: '1' }, version: 0 };
  for (const body of [
    null,
    [],
    { targets: [target] },
    { targets: [target], input: {}, extra: 1 },
    { targets: [], input: {} },
    { targets: Array.from({ length: 201 }, (_, index) => ({ key: { part: 'a', id: String(index) }, version: 0 })), input: {} },
    { targets: [{ ...target, version: -1 }], input: {} },
    { targets: [{ ...target, version: 1.5 }], input: {} },
    { targets: [{ ...target, version: Number.MAX_SAFE_INTEGER }], input: {} },
    { targets: [{ ...target, note: 1 }], input: {} },
    { targets: [{ key: { part: 'a' }, version: 0 }], input: {} },
    { targets: 'a', input: {} },
  ]) {
    assert.throws(() => many.mapper.map(manyRoute, { idempotencyKey }, body), code('invalid_request'), JSON.stringify(body)?.slice(0, 80));
  }
  assert.equal(f.calls() + many.calls(), 0);
});

test('stored target keys answer in the API integer representation, whatever client recorded them', () => {
  assert.deepEqual(fixture(false, 'decimal-string').mapper.targetKey('edit', { part: 'a', id: 1 }), { part: 'a', id: '1' });
  assert.deepEqual(fixture(false, 'number').mapper.targetKey('edit', { part: 'a', id: '1' }), { part: 'a', id: 1 });
  assert.throws(() => fixture(false, 'number').mapper.targetKey('edit', { part: 'a', id: '9007199254740993' }), code('invalid_request'));
  assert.throws(() => fixture(false, 'decimal-string').mapper.targetKey('missing', { part: 'a', id: 1 }), code('not_found'));
});
