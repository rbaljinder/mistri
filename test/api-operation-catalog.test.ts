import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApiOperationCatalog } from '../packages/mistri/src/server/api/apiOperationCatalog.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

function fixture() {
  let calls = 0;
  const schema: DatabaseSchema = {
    label: 'Logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: ['item', 'reference'].map((id) => ({
      id,
      name: id,
      schema: '',
      isView: false,
      columns: ['id', 'revision'].map((name) => ({ name, type: 'INTEGER', nullable: false, primaryKey: name === 'id' })),
    })),
  };
  const app = parseTestApp(
    {
      id: 'app',
      name: 'App',
      sources: { business: { connection: 'private' } },
      resources: { item: { access: 'write' }, reference: {} },
      auth: {
        roles: {
          operator: { read: true, commands: ['change'] },
          incomplete: { read: ['item'], commands: ['change'] },
          viewer: { read: true },
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'fixture',
  );
  const api = parseTestApi(
    {
      version: 1,
      roles: ['operator', 'incomplete', 'viewer'],
      resources: { item: { fields: ['id', 'revision'], filters: ['revision'], sorts: ['id'] } },
      views: ['items'],
      commands: [{ id: 'change', version: 1, target: 'item', input: {} }],
    },
    Object.keys(app.auth!.roles!),
  )!;
  // The private normalized model can exercise future declarations without
  // changing the active App parser's command-exposure refusal.
  app.api = api;
  const registry = defineCommands({
    change: defineCommand({
      source: 'business',
      target: 'item',
      input: {},
      read: ['reference'],
      output: shape({ ok: bool() }),
      validate() {
        calls++;
      },
      initial() {
        calls++;
        return {};
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
    api,
    app,
    schema,
    registry,
    evidence,
    calls: () => calls,
    check: () => checkApiOperationCatalog(app, schema, registry, evidence),
  };
}

test('combined catalog derives IDs and whole-role eligibility without invoking business code', () => {
  const f = fixture(),
    before = structuredClone({ api: f.api, app: f.app, schema: f.schema });
  const result = f.check();
  assert.deepEqual(
    result.operations.map((operation) => operation.id),
    ['list:item', 'item:item', 'view:items', 'command:change'],
  );
  assert.deepEqual(result.operations[0].eligibleRoles, ['incomplete', 'operator', 'viewer']);
  assert.deepEqual(result.operations[3].eligibleRoles, ['operator']);
  assert.equal(result.stage, 'operation-validation-foundation');
  assert.equal(result.authority, 'pending');
  assert.equal(result.execution, 'pending');
  assert.equal(result.publication, 'pending');
  assert.equal(f.calls(), 0);
  assert.deepEqual({ api: f.api, app: f.app, schema: f.schema }, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.operations));
  assert.ok(result.operations.every((operation) => Object.isFrozen(operation) && Object.isFrozen(operation.eligibleRoles)));
  f.api.roles.length = 0;
  assert.equal(result.operations[3].eligibleRoles[0], 'operator');
});

test('command-free catalog has exact read ID/role parity and never consults command evidence', () => {
  const f = fixture();
  f.api.commands = [];
  const fail = () => {
    throw new Error('must not consult command evidence');
  };
  const result = checkApiOperationCatalog(
    f.app,
    f.schema,
    {},
    { connectionFor: fail, writableConnection: fail, transactionalConnection: fail },
  );
  assert.deepEqual(
    result.operations,
    checkApiReadCatalog(f.api, f.app, f.schema).operations.map(({ id, eligibleRoles }) => ({ id, eligibleRoles })),
  );
});

test('real command references, whole footprints and trusted capabilities still refuse', () => {
  for (const change of [{ version: 2 }]) {
    const f = fixture();
    Object.assign(f.api.commands[0].command, change);
    assert.throws(f.check, /resolved at version 2.*registration is at 1/);
    assert.equal(f.calls(), 0);
  }
  const noRegistry = fixture();
  assert.throws(
    () => checkApiOperationCatalog(noRegistry.app, noRegistry.schema, {}, noRegistry.evidence),
    /which the commands module does not register/,
  );
  const split = fixture();
  split.api.roles = ['incomplete', 'viewer'];
  assert.throws(split.check, /whole command footprint/);
  const unsupported = fixture();
  unsupported.evidence.transactionalConnection = () => false;
  assert.throws(unsupported.check, /transaction support/);
  const read = fixture();
  read.api.resources.item.fields = ['revision'];
  assert.throws(read.check, /primary key/);
  const source = fixture();
  const wrongSource = defineCommands({
    change: defineCommand({
      source: 'unknown',
      target: 'item',
      input: {},
      output: shape({ ok: bool() }),
      handle() {
        throw new Error('must not execute');
      },
    }),
  });
  assert.throws(() => checkApiOperationCatalog(source.app, source.schema, wrongSource, source.evidence), /source/);
  let outputCalls = 0;
  const opaque = defineCommands({
    change: defineCommand({
      source: 'business',
      target: 'item',
      input: {},
      output: {
        parse() {
          outputCalls++;
          return { ok: true };
        },
      },
      handle() {
        throw new Error('must not execute');
      },
    }),
  });
  assert.throws(() => checkApiOperationCatalog(source.app, source.schema, opaque, source.evidence), /opaque/);
  assert.equal(outputCalls, 0);
});

test('context restrictions and descriptor-safe capture cannot be bypassed by combined metadata', () => {
  const f = fixture();
  let calls = 0;
  const getter = Object.defineProperty({}, 'api', {
    enumerable: true,
    get() {
      calls++;
      return f.api;
    },
  });
  assert.throws(() => checkApiOperationCatalog(getter as unknown as typeof f.app, f.schema, f.registry, f.evidence));
  assert.throws(() =>
    checkApiOperationCatalog(
      new Proxy(f.app, {
        ownKeys() {
          calls++;
          return [];
        },
      }),
      f.schema,
      f.registry,
      f.evidence,
    ),
  );
  assert.throws(() =>
    checkApiOperationCatalog(
      f.app,
      f.schema,
      f.registry,
      Object.defineProperty({}, 'connectionFor', {
        enumerable: true,
        get() {
          calls++;
          return f.evidence.connectionFor;
        },
      }) as typeof f.evidence,
    ),
  );
  assert.equal(calls, 0);
  const contexts = fixture();
  contexts.app.auth!.rows = 'tenant';
  assert.throws(contexts.check, /tenant contexts/);
  // A second source is served, one connection per request; each table is judged by the engine that reads it.
  const multi = fixture();
  multi.app.sources!.other = { connection: 'second', default: false };
  assert.ok(multi.check().operations.length);
  multi.schema.tables = multi.schema.tables.map((table) => ({ ...table, sourceDialect: 'http' as const }));
  assert.throws(multi.check, /\[api-source-unsupported\]/);
  const absent = fixture();
  delete absent.app.api;
  assert.throws(absent.check, /App's declared API/);
});
