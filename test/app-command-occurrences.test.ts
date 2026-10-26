import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appCommandOccurrences } from '../packages/mistri/src/shared/appCommandOccurrences.js';
import { resourceCommandIds } from '../packages/mistri/src/shared/appCommandIds.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { createBusinessCommandAuthorizer } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bool, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandReferenceCatalogProblem } from '../packages/mistri/src/server/commands/businessCommandReferenceChecks.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

function fixture() {
  const targeted = { id: 'change', version: 1, input: {}, target: 'item' };
  const formInput = { note: { type: 'text' as const } };
  const untargeted = { id: 'create', version: 1, input: formInput };
  const app = parseTestApp(
    {
      id: 'app',
      name: 'App',
      sources: { business: { connection: 'private' } },
      resources: {
        item: {
          access: 'write',
          actions: {
            change: { label: 'Change', command: targeted },
            changeAgain: { label: 'Change again', command: targeted },
          },
        },
      },
      auth: { roles: { operator: { read: true, commands: ['change', 'create'] } } },
      views: {
        items: { kind: 'list', from: 'item' },
        create: { kind: 'form', label: 'Create', command: untargeted },
        public: { kind: 'form', label: 'Public', public: true, command: { id: 'publicCreate', version: 1, input: formInput } },
      },
      home: 'items',
      nav: ['items', 'create'],
    },
    'occurrences',
  );
  const schema: DatabaseSchema = {
    label: 'Logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: ['id', 'revision'].map((name) => ({ name, type: 'INTEGER', nullable: false, primaryKey: name === 'id' })),
      },
    ],
  };
  const base = {
    source: 'business',
    target: 'item',
    input: {},
    output: shape({ ok: bool() }),
    handle() {
      throw new Error('Must not invoke a handler');
    },
  };
  const registry = defineCommands({
    change: defineCommand({ ...base }),
    create: defineCommand({ ...base, targets: 'none', input: formInput }),
    publicCreate: defineCommand({ ...base, targets: 'none', input: formInput, public: true, output: shape({ reference: text() }) }),
  });
  const options = {
    app,
    registry,
    schema,
    connectionFor: () => 'private',
    writableConnection: () => true,
    transactionalConnection: () => true,
  };
  return { app, schema, registry, options, untargeted };
}

test('occurrences preserve duplicate actions, form provenance and original normalized references', () => {
  const { app } = fixture(),
    entries = appCommandOccurrences(app);
  assert.deepEqual(
    entries.map((entry) => [entry.surface, entry.reference.id, entry.path]),
    [
      ['action', 'change', ['resources', 'item', 'actions', '0', 'command']],
      ['action', 'change', ['resources', 'item', 'actions', '1', 'command']],
      ['form', 'create', ['views', 'create', 'command']],
      ['form', 'publicCreate', ['views', 'public', 'command']],
    ],
  );
  assert.equal(entries[0].reference, app.resources!.item.actions![0].command);
  assert.ok(Object.isFrozen(entries) && entries.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.path)));
  assert.deepEqual(resourceCommandIds(app), ['change']);
});

test('loader returns targeted references and refuses a reference resolved from another module', () => {
  const f = fixture();
  // A signed-in command that names no record has a reference too: its form prepares over none.
  assert.deepEqual([...validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }).keys()], ['change', 'create']);
  const action = f.app.resources!.item.actions![1].command!;
  action.version = 2;
  assert.throws(
    () => validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }),
    /resolved at version 2, and its registration is at 1/,
  );
  action.version = 1;
  const form = appCommandOccurrences(f.app).find((entry) => entry.surface === 'form' && entry.view === 'create')!;
  form.reference.version = 2;
  assert.throws(() => validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }), /Form "create".*resolved at version 2/);
});

test('an API-only targeted command has a validated prepare reference', () => {
  const f = fixture();
  f.app.resources!.item.actions = [];
  f.app.api = parseTestApi({ version: 1, roles: ['operator'], commands: [{ id: 'change', version: 1, target: 'item', input: {} }] }, [
    'operator',
  ]);
  assert.equal(validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }).get('change')?.target, 'item');
  assert.ok(f.app.api);
  f.app.api.commands![0].command.version = 2;
  assert.throws(
    () => validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }),
    /API command "change".*resolved at version 2/,
  );
});

test("a command creates by its registration (targets: 'none'), never by a form or API metadata", () => {
  const f = fixture();
  let authorizer = createBusinessCommandAuthorizer(f.options);
  const actor = { id: 'operator', appId: 'app', roles: ['operator'] };
  assert.equal(authorizer.creates('change'), false);
  assert.equal(authorizer.creates('create'), true);
  assert.equal(authorizer.creates('publicCreate'), false);
  assert.deepEqual(authorizer.authorize('change', actor).keyColumns, ['id']);
  assert.deepEqual(authorizer.authorize('create', actor).keyColumns, []);
  assert.throws(() => authorizer.authorize('publicCreate', actor));
  assert.deepEqual(
    authorizer.authorize('publicCreate', {
      id: 'public:public',
      appId: 'app',
      roles: [],
      kind: 'public',
      form: 'public',
    }).keyColumns,
    [],
  );
  assert.throws(() =>
    authorizer.authorize('publicCreate', {
      id: 'public:create',
      appId: 'app',
      roles: [],
      kind: 'public',
      form: 'create',
    }),
  );
  delete f.app.views.create;
  f.app.api = parseTestApi({ version: 1, roles: ['operator'], commands: [f.untargeted] }, ['operator']);
  authorizer = createBusinessCommandAuthorizer(f.options);
  assert.equal(authorizer.creates('create'), true);
  assert.deepEqual(authorizer.authorize('create', actor).keyColumns, []);
  assert.deepEqual(resourceCommandIds(f.app), ['change']);
  assert.deepEqual([...validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }).keys()], ['change', 'create']);
});

test("a form is served its registration's input: the declaration is the command's alone", () => {
  const f = fixture(),
    form = appCommandOccurrences(f.app).find((entry) => entry.surface === 'form' && entry.view === 'create')!;
  assert.deepEqual(form.reference.input, JSON.parse(JSON.stringify(f.registry.create.fields)));
});

test('shared catalog check keeps the containing owner and pruned reference footprint', () => {
  const f = fixture(),
    reference = f.app.resources!.item.actions![0].command!;
  assert.equal(commandReferenceCatalogProblem(f.app, f.registry.change, reference, 'item', f.schema), undefined);
  assert.match(commandReferenceCatalogProblem(f.app, f.registry.change, reference, 'other', f.schema)!, /owning resource/);
  f.schema.tables.push({
    id: 'secret',
    name: 'secret',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    ],
  });
  const input = [{ name: 'lookup', label: 'Lookup', type: 'reference' as const, from: 'secret', by: 'id', labelColumn: 'name' }];
  assert.match(
    commandReferenceCatalogProblem(f.app, f.registry.change, { ...reference, input }, 'item', f.schema)!,
    /unresolved reference.*"secret" is not in the command's `read`.*add "secret" to `read`/,
  );
  assert.match(
    commandReferenceCatalogProblem(f.app, f.registry.create, { id: 'create', version: 1, input }, 'item', f.schema)!,
    /unresolved reference/,
  );
});

test('loader names the first surface resolved from another module', () => {
  const f = fixture(),
    action = f.app.resources!.item.actions![0].command!;
  action.version = 2;
  assert.throws(() => validateBusinessCommandReferences(f.app, f.registry, { schema: f.schema }), {
    message:
      'resources "item", action "Change": command "change" was resolved at version 2, and its registration is at 1; load the App with this commands module.',
  });
});
