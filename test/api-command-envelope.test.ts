/** Pure internal envelope contracts, not HTTP request or native authority tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createApiCommandEnvelopeBundle } from '../packages/mistri/src/server/api/apiCommandEnvelope.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { canonicalKey, commandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { commandJournalValidation } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

function fixture(many = false) {
  let calls = 0;
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
  return { schema, make: () => createApiCommandEnvelopeBundle(app, schema, registry, evidence), calls: () => calls };
}
const request = {
  command: 'edit',
  commandVersion: 1,
  key: { part: 'a', id: '1' },
  expectedVersion: 0,
  idempotencyKey: 'envelope_request_0001',
  input: { note: ' hi ' },
};

test('complete one-target contracts render without business callbacks and validate shared raw envelopes', () => {
  const f = fixture(),
    bundle = f.make(),
    operation = bundle.operations[0];
  assert.equal(f.calls(), 0);
  assert.equal(bundle.transport, 'pending');
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(operation.schemas.executeRequest);
  for (const raw of [
    request,
    { ...request, expectedVersion: Number.MAX_SAFE_INTEGER - 1 },
    { ...request, input: {} },
    { ...request, expectedVersion: -1 },
    { ...request, expectedVersion: Number.MAX_SAFE_INTEGER },
    { ...request, expectedVersion: 1.2 },
    { ...request, commandVersion: 2 },
    { ...request, input: { unknown: 1 } },
    { ...request, idempotencyKey: 'short' },
    { ...request, key: { part: 'a' } },
    { ...request, key: { part: 'a', id: '1.5' } },
    { ...request, extra: true },
  ]) {
    let accepted = true;
    try {
      operation.validateExecuteRequest(raw);
    } catch {
      accepted = false;
    }
    assert.equal(validate(raw), accepted, JSON.stringify(raw));
  }
  assert.equal(f.calls(), 0);
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(operation.schemas));
  const parsed = operation.validateExecuteRequest(request);
  assert.notEqual(parsed, request);
  assert.ok('key' in parsed);
  assert.equal(parsed.key.id, '1');
});

test('execution and normalized recovery responses keep exact identities and projected output', () => {
  const operation = fixture().make().operations[0],
    ajv = new Ajv2020({ strict: true });
  const execute = {
    status: 'applied',
    receiptId: 'receipt',
    command: 'edit',
    commandVersion: 1,
    resource: 'item',
    key: request.key,
    result: { ok: true },
    replayed: false,
  };
  assert.equal(ajv.compile(operation.schemas.executeResult)(execute), true);
  operation.validateExecuteResult(request, execute);
  assert.throws(() => operation.validateExecuteResult(request, { ...execute, key: { part: 'different', id: 1 } }));
  assert.throws(() => operation.validateExecuteResult(request, { ...execute, result: { ok: true, secret: 'hidden' } }));
  const scope = { command: request.command, commandVersion: 1, idempotencyKey: request.idempotencyKey };
  operation.validateRecoveryRequest(scope);
  assert.throws(() => operation.validateRecoveryRequest({ ...scope, input: {} }));
  const recovery = {
    status: 'applied',
    receiptId: 'receipt',
    command: 'edit',
    commandVersion: 1,
    resource: 'item',
    targets: [request.key],
    result: { ok: true },
    recovered: true,
  };
  assert.equal(ajv.compile(operation.schemas.recoveryResult)(recovery), true);
  operation.validateRecoveryResult(recovery);
  operation.validateRecoveryResult({ status: 'not_found', outcome: 'unknown' });
  assert.throws(() => operation.validateRecoveryResult({ status: 'not_found', outcome: 'not_applied' }));
  assert.throws(() => operation.validateRecoveryResult({ ...recovery, targets: [] }));
  assert.throws(() => operation.validateRecoveryResult({ ...recovery, input: {} }));
});

test('many-target contracts preserve shared envelope bounds, identity and ordered result correlation', () => {
  const f = fixture(true),
    operation = f.make().operations[0],
    ajv = new Ajv2020({ strict: true });
  const check = ajv.compile(operation.schemas.executeRequest),
    output = ajv.compile(operation.schemas.executeResult);
  const { key: first, expectedVersion: _revision, ...common } = request;
  const keys = [first, { part: 'b', id: 2 }];
  const multi = { ...common, keys, expectedVersions: [0, 1] };
  for (const value of [request, multi, { ...multi, keys: [first], expectedVersions: [0] }]) {
    assert.equal(check(value), true);
    operation.validateExecuteRequest(value);
  }
  const bulk = { ...multi, keys: Array.from({ length: 200 }, (_, id) => ({ part: 'a', id })), expectedVersions: Array(200).fill(0) };
  assert.equal(check(bulk), true);
  operation.validateExecuteRequest(bulk);
  for (const invalid of [
    { ...multi, keys: [] },
    { ...multi, expectedVersions: [] },
    { ...multi, expectedVersions: [0] },
    { ...multi, expectedVersions: [-1, 0] },
    { ...multi, keys: [first, { id: 1, part: 'a' }] },
    { ...multi, keys: [first, { id: 2 }] },
    { ...multi, key: first },
    { ...bulk, keys: [...bulk.keys, { part: 'a', id: 201 }], expectedVersions: Array(201).fill(0) },
  ]) {
    assert.throws(() => operation.validateExecuteRequest(invalid));
  }
  // JSON Schema intentionally does not claim aligned lengths or semantic uniqueness.
  assert.equal(check({ ...multi, expectedVersions: [0] }), true);
  assert.equal(check({ ...multi, keys: [first, { id: 1, part: 'a' }] }), true);
  const applied = {
    status: 'applied',
    receiptId: 'receipt',
    command: 'edit',
    commandVersion: 1,
    resource: 'item',
    key: first,
    keys,
    result: { ok: true },
    replayed: false,
  };
  assert.equal(output(applied), true);
  operation.validateExecuteResult(multi, applied);
  const { keys: _keys, ...single } = applied;
  operation.validateExecuteResult(request, single);
  for (const invalid of [
    single,
    { ...applied, keys: [...keys].reverse() },
    { ...applied, keys: [first] },
    { ...applied, key: keys[1] },
    { ...applied, keys: [first, { part: 'a', id: 1 }] },
  ]) {
    assert.throws(() => operation.validateExecuteResult(multi, invalid));
  }
  assert.throws(() => operation.validateExecuteResult(request, { ...applied, keys: [first] }));
  const recovery = {
    status: 'applied',
    receiptId: 'receipt',
    command: 'edit',
    commandVersion: 1,
    resource: 'item',
    targets: keys,
    result: { ok: true },
    recovered: true,
  };
  assert.equal(ajv.compile(operation.schemas.recoveryResult)(recovery), true);
  operation.validateRecoveryResult(recovery);
  for (const targets of [[], [first, { id: 1, part: 'a' }], [...bulk.keys, { part: 'a', id: 201 }]]) {
    assert.throws(() => operation.validateRecoveryResult({ ...recovery, targets }));
  }
  assert.throws(() => fixture().make().operations[0].validateExecuteRequest(multi));
  assert.equal(f.calls(), 0);
});

test('numeric key end anchors agree with actual shared parser; receipt IDs agree with journal validation', () => {
  const f = fixture(),
    operation = f.make().operations[0],
    ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(operation.schemas.executeRequest);
  const table = commandCatalog(f.schema, ['item'], (name) => name)!.item;
  for (const tail of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const key = { part: 'a', id: `1${tail}` };
    assert.equal(canonicalKey(table, key), undefined);
    assert.equal(validate({ ...request, key }), false);
    assert.throws(() => operation.validateExecuteRequest({ ...request, key }));
  }
  const validateResult = ajv.compile(operation.schemas.executeResult);
  const journalText: typeof commandJournalValidation.text = commandJournalValidation.text;
  for (const receiptId of ['r', 'r r', '🙂', '', ' r', 'r ', 'r\n', 'r\tq', '\u0085', '\ud800']) {
    let accepted = true;
    try {
      journalText(receiptId, 'receipt ID', 128);
    } catch {
      accepted = false;
    }
    const result = {
      status: 'applied',
      receiptId,
      command: 'edit',
      commandVersion: 1,
      resource: 'item',
      key: request.key,
      result: { ok: true },
      replayed: false,
    };
    assert.equal(validateResult(result), accepted, JSON.stringify(receiptId));
    if (accepted) operation.validateExecuteResult(request, result);
    else assert.throws(() => operation.validateExecuteResult(request, result));
  }
});
