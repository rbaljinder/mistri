import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkApiCommandCatalog } from '../packages/mistri/src/server/api/apiCommandCatalog.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool, text, optional, list, type Shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { CommandInput } from '../packages/mistri/src/shared/command.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

function fixture(targets: 'one' | 'many' | 'none' = 'one') {
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
  const input: CommandInput = targets === 'none' ? { note: { type: 'text' } } : {};
  const ref = { id: 'change', version: 1, input, ...(targets === 'none' ? {} : { target: 'item', targets }) };
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
      views: {
        items: { kind: 'list', from: 'item' },
        ...(targets === 'none' ? { create: { kind: 'form', label: 'Create item', command: ref } } : {}),
      },
      home: 'items',
      ...(targets === 'none' ? { nav: ['items', 'create'] } : {}),
    },
    'fixture',
  );
  const api = parseTestApi({ version: 1, roles: ['operator', 'incomplete', 'viewer'], commands: [ref] }, Object.keys(app.auth!.roles!))!;
  const command = defineCommand({
    source: 'business',
    target: 'item',
    input,
    ...(targets === 'none' ? { targets } : { targets }),
    read: ['reference'],
    output: shape({ ok: bool() }),
    handle() {
      calls++;
      return { ok: true };
    },
    validate() {
      calls++;
    },
    ...(targets === 'none'
      ? {}
      : {
          availability() {
            calls++;
            return [];
          },
        }),
  });
  const registry = defineCommands({ change: command });
  const evidence = { connectionFor: () => 'private', writableConnection: () => true, transactionalConnection: () => true };
  return {
    app,
    api,
    schema,
    registry,
    evidence,
    calls: () => calls,
    check: () => checkApiCommandCatalog(api, app, schema, registry, evidence),
  };
}

for (const targets of ['one', 'many', 'none'] as const)
  test(`command catalog checks ${targets} without invoking trusted code`, () => {
    const f = fixture(targets),
      result = f.check(),
      op = result.operations[0];
    assert.equal(result.stage, 'command-validation-foundation');
    assert.equal(result.wireValidation, 'pending');
    assert.equal(op.targets, targets);
    assert.deepEqual(op.eligibleRoles, ['operator']);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(op) && Object.isFrozen(op.read));
    assert.equal(f.calls(), 0);
  });

test('an exposure resolved from another commands module fails closed', () => {
  // The App names the command; its contract is the registration's. A reference the App was
  // loaded with that says another version was resolved from another module.
  const f = fixture();
  Object.assign(f.api.commands[0].command, { version: 2 });
  assert.throws(f.check, { message: 'api.commands.change: the App was loaded with another commands module.' });
  assert.equal(f.calls(), 0);
});

test('role grants cannot be combined to satisfy one command', () => {
  const f = fixture();
  f.api.roles = ['incomplete', 'viewer'];
  assert.throws(f.check, /whole command footprint/);
});

test('untargeted API-only commands are explicitly deferred', () => {
  const f = fixture('none');
  delete f.app.views.create;
  assert.throws(f.check, /untargeted exposure requires an existing signed-in form/);
});

test('opaque outputs are refused without parsing', () => {
  const f = fixture();
  let called = false;
  const command = defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    output: {
      parse() {
        called = true;
        return {};
      },
    },
    handle() {
      called = true;
      return {};
    },
  });
  assert.throws(() => checkApiCommandCatalog(f.api, f.app, f.schema, defineCommands({ change: command }), f.evidence), /opaque/);
  assert.equal(called, false);
});

test('known output descriptors must pass the exact structural renderer without executing command code', () => {
  const outputs: Shape<unknown>[] = [text({ pattern: /x/i }), optional(bool()), list(optional(bool()))];
  for (const output of outputs) {
    const f = fixture();
    let calls = 0;
    const command = defineCommand({
      source: 'business',
      target: 'item',
      input: {},
      output,
      handle() {
        calls++;
        throw new Error('must not execute');
      },
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
    });
    assert.throws(() => checkApiCommandCatalog(f.api, f.app, f.schema, defineCommands({ change: command }), f.evidence), /Command output/);
    assert.equal(calls, 0);
  }
});

test('catalog output schema validates canonical projected output, not unprojected handler data', () => {
  const f = fixture();
  const output = shape({ ok: bool(), note: optional(text()), rows: list(shape({ label: text() })) });
  const command = defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    output,
    handle() {
      throw new Error('must not execute');
    },
  });
  const result = checkApiCommandCatalog(f.api, f.app, f.schema, defineCommands({ change: command }), f.evidence);
  for (const flag of ['wireValidation', 'envelopeValidation', 'execution', 'publication'] as const) assert.equal(result[flag], 'pending');
  const schema = result.operations[0].outputSchema;
  assert.ok(Object.isFrozen(schema));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const raw = { ok: true, rows: [{ label: 'Visible', hidden: true }], hidden: 'private' };
  assert.equal(validate(raw), false);
  assert.equal(validate(JSON.parse(canonicalCommandJson(output.parse(raw)))), true);
  assert.equal(validate({ ok: true, rows: [{}] }), false);
});

test('physical capabilities must be attested and cannot be assumed', () => {
  const f = fixture();
  f.evidence.transactionalConnection = () => false;
  assert.throws(f.check, /transaction support/);
});

test('public registrations are never API callable', () => {
  const f = fixture('none');
  delete f.app.views.create;
  for (const role of Object.values(f.app.auth!.roles!)) delete role.commands;
  const command = defineCommand({
    targets: 'none',
    source: 'business',
    target: 'item',
    public: true,
    input: { note: { type: 'text' } },
    output: shape({ ok: bool() }),
    handle: () => ({ ok: true }),
  });
  assert.throws(() => checkApiCommandCatalog(f.api, f.app, f.schema, defineCommands({ change: command }), f.evidence), /public commands/);
});

test('unknown registrations are refused', () => {
  const g = fixture();
  g.api.commands[0].command.id = 'missing';
  assert.throws(g.check, /unregistered command/);
});

test('undeclared API roles remain explicit refusals', () => {
  const f = fixture();
  f.api.roles = ['unknown'];
  assert.throws(f.check, /every API role/);
});

test('a read the command elevates opens the App form to a role, never the App API', () => {
  const f = fixture();
  const elevated = defineCommands({
    change: defineCommand({
      source: 'business',
      target: 'item',
      targets: 'one',
      input: {},
      read: ['reference'],
      elevate: { read: ['reference'] },
      output: shape({ ok: bool() }),
      handle() {
        return { ok: true };
      },
      availability() {
        return [];
      },
    }),
  });
  // The App binds it for a role that cannot read the reference table...
  const result = checkApiCommandCatalog(f.api, f.app, f.schema, elevated, f.evidence);
  // ...but the API publishes a command only to a role that reads its whole footprint.
  assert.deepEqual(result.operations[0].eligibleRoles, ['operator']);
});
