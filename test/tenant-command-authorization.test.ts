import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { CommandJournal, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import { parseAppConfig, resolveAppAccess, resourceCeiling } from '../packages/mistri/src/shared/app.js';
import { resource, roles, setCeilings, setFieldCeilings } from './support/appCeilings.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import {
  createBusinessCommandAuthorizer,
  type BusinessCommandAuthorizationOptions,
} from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import { commandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';

const actor: BusinessCommandActor = { id: 'alice', appId: 'app', roles: ['operator'] };
const owner = { storeId: 'store', sourceId: 'business', tenantId: 'north' };
const request = {
  command: 'change',
  commandVersion: 1,
  key: { id: 'one' },
  expectedVersion: 0,
  input: { value: 'new' },
  idempotencyKey: 'request-0000000001',
};

function fixture() {
  const schema: DatabaseSchema = {
    label: 'Private',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: ['item', 'reference', 'extra'].map((id) => ({
      id,
      name: id,
      schema: '',
      isView: false,
      columns: ['id', 'tenant_id', 'value', 'revision'].map((name) => ({
        name,
        type: name === 'revision' ? 'INTEGER' : 'TEXT',
        nullable: false,
        primaryKey: name === 'id',
      })),
    })),
  };
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      auth: {
        roles: {
          operator: { read: true, commands: ['change'] },
          inactive: { read: true },
          incomplete: { read: ['item'], commands: ['change'] },
        },
      },
      sources: { business: { connection: 'private' } },
      resources: { item: { access: 'write' }, reference: { access: 'write' }, extra: { access: 'write' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'fixture',
  );
  let calls = 0;
  const command = defineCommand({
    source: 'business',
    target: 'item',
    read: ['item', 'reference'],
    write: ['item'],
    input: { value: { label: 'Value', type: 'text', optional: true } },
    output: { parse: (value) => value },
    handle: () => {
      calls++;
      return { ok: true };
    },
  });
  const options: BusinessCommandAuthorizationOptions = {
    app,
    schema,
    registry: defineCommands({ change: command }),
    connectionFor: () => 'private',
    writableConnection: () => true,
    transactionalConnection: () => true,
    managedOwnership: { item: 'tenant_id', reference: 'tenant_id' },
  };
  return { app, schema, command, options, create: () => createBusinessCommandAuthorizer(options), calls: () => calls };
}

test('pure metadata has frozen arrays, exact local mapping and no transaction or handler authority', () => {
  const f = fixture(),
    authorizer = f.create(),
    authorized = authorizer.authorize('change', actor);
  assert.equal(f.calls(), 0);
  /* `creates` is a lookup in the App's signed-in forms, not authority: it
     reads no transaction and never reaches a handler. */
  assert.deepEqual(Object.keys(authorizer).sort(), ['authorize', 'creates']);
  assert.equal(authorizer.creates('change'), false);
  assert.equal(f.calls(), 0);
  assert.deepEqual(Object.keys(authorized).sort(), [
    'actor',
    'catalog',
    'command',
    'connection',
    'keyColumns',
    'read',
    'resource',
    'table',
    'write',
  ]);
  // The footprint's catalog is what `db` and the target preload read: columns and keys, no connection.
  assert.deepEqual(Object.keys(authorized.catalog ?? {}).sort(), ['item', 'reference']);
  assert.deepEqual(authorized.read, ['item', 'reference']);
  assert.deepEqual(authorized.write, ['item']);
  assert.deepEqual(authorized.keyColumns, ['id']);
  assert.equal(authorized.connection, 'private');
  for (const value of [
    authorizer,
    authorized,
    authorized.read,
    authorized.write,
    authorized.keyColumns,
    authorized.actor,
    authorized.actor.roles,
    authorized.catalog,
    authorized.catalog?.item,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(authorized.table('reference'), 'reference');
  assert.equal(authorized.table('item', true), 'item');
  for (const local of ['extra', 'business.item', 'constructor', 'item.value'])
    assert.throws(() => authorized.table(local), AppAccessDenied);
  assert.throws(() => authorized.table('reference', true), AppAccessDenied);
});

test('managed root owner-only hiding binds without granting generic CRUD or owner writes', () => {
  const f = fixture();
  setFieldCeilings(f.app, { item: { read: ['id', 'value'], write: ['id', 'value'] } });
  assert.equal(f.create().authorize('change', actor).resource, 'item');
  assert.equal(f.app.auth!.roles!.operator.write, false);
  assert.deepEqual([...resolveAppAccess(f.app, f.schema, ['operator']).fields!.get('item')!.write], []);
  f.app.resources!.item.fields!.read.push('tenant_id');
  assert.equal(f.create().authorize('change', actor).resource, 'item');
});

/* A column rule on the footprint — the root's, an active role's or one no
   one holds — narrows generic reads and writes, and never the handler: it
   reads what its footprint needs as the service-level code it is
   (tenantCommandTransaction.ts). So every one of them binds, in a tenant
   App as in any other. */
for (const place of ['root', 'operator', 'inactive'] as const) {
  for (const narrowed of ['read', 'write'] as const) {
    test(`${place} ${narrowed} restriction on a footprint column binds`, () => {
      const f = fixture();
      const rule = narrowed === 'read' ? { read: ['id'], write: ['id'] } : { read: ['id', 'value'], write: ['id'] };
      if (place === 'root') setFieldCeilings(f.app, { item: rule });
      else f.app.auth!.roles![place].fields = { item: narrowed === 'read' ? { read: ['id'] } : { read: ['id', 'value'] } };
      assert.equal(f.create().authorize('change', actor).resource, 'item');
    });
  }
}

for (const role of ['operator', 'inactive'] as const) {
  for (const resource of ['item', 'reference'] as const) {
    test(`${role} column rule on ${resource} binds, with or without the owner column`, () => {
      for (const read of [
        ['id', 'tenant_id', 'value'],
        ['id', 'value'],
      ]) {
        const f = fixture();
        f.app.auth!.roles![role].fields = { [resource]: { read } };
        assert.equal(f.create().authorize('change', actor).resource, 'item');
      }
    });
  }
}

test('normal App field ceilings and complete composite PK readability remain mandatory', () => {
  const f = fixture();
  f.schema.tables[0].columns[1].primaryKey = true;
  setFieldCeilings(f.app, { item: { read: ['id', 'value'], write: ['id', 'value'] } });
  assert.throws(f.create, /complete primary key readable/);
  f.app.resources!.item.fields!.read.push('tenant_id');
  assert.deepEqual(f.create().authorize('change', actor).keyColumns, ['id', 'tenant_id']);
});

for (const managed of [{ item: 'missing' }, { missing: 'tenant_id' }, { item: '' }, { item: 1 }, null]) {
  test(`invalid managed ownership ${JSON.stringify(managed)} refuses construction`, () => {
    const f = fixture();
    f.options.managedOwnership = managed as unknown as typeof f.options.managedOwnership;
    assert.throws(f.create, BusinessCommandDefinitionError);
  });
}

test('field rules outside the footprint stay ordinary, and rules on it bind without a managed owner', () => {
  const f = fixture();
  setFieldCeilings(f.app, { extra: { read: ['id'], write: [] } });
  assert.equal(f.create().authorize('change', actor).resource, 'item');
  resource(f.app, 'reference').fields = { read: ['id', 'value'], write: ['id', 'value'] };
  f.options.managedOwnership = { item: 'tenant_id' };
  assert.equal(f.create().authorize('change', actor).resource, 'item');
  delete f.options.managedOwnership;
  assert.equal(f.create().authorize('change', actor).resource, 'item');
});

for (const mutate of [
  (f: ReturnType<typeof fixture>) => {
    f.app.auth!.roles!.inactive.write = ['item'];
  },
  (f: ReturnType<typeof fixture>) => {
    f.app.auth!.roles!.inactive.commands = ['missing'];
  },
  (f: ReturnType<typeof fixture>) => {
    f.schema.tables[0].isView = true;
  },
  (f: ReturnType<typeof fixture>) => {
    f.options.connectionFor = (table) => (table === 'reference' ? 'other' : 'private');
  },
  (f: ReturnType<typeof fixture>) => {
    f.options.writableConnection = () => false;
  },
  (f: ReturnType<typeof fixture>) => {
    f.options.transactionalConnection = () => false;
  },
  (f: ReturnType<typeof fixture>) => {
    setCeilings(f.app, ['reference']);
  },
  (f: ReturnType<typeof fixture>) => {
    setCeilings(f.app, resourceCeiling(f.app).read, []);
  },
])
  test(`existing command ceiling/CRUD/source gate ${mutate.toString()} remains enforced`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(f.create);
    assert.equal(f.calls(), 0);
  });

/* A command that names no record may only update its target's rows, which already point where they point (field
   report R10): startup cannot tell, so it starts, and a write that sets a reference the footprint cannot prove is
   refused by name when it is made (command-footprint-references.test.ts). */
test('a command naming no record starts though its target points at a table outside its footprint', () => {
  const f = fixture();
  const extra = f.schema.tables.find((table) => table.id === 'extra')!;
  (extra.columns.find((column) => column.name === 'value') as { references?: unknown }).references = { table: 'reference', column: 'id' };
  const command = defineCommand({
    source: 'business',
    target: 'extra',
    targets: 'none',
    read: ['item'],
    write: ['item', 'extra'],
    output: { parse: (value) => value },
    handle: () => ({ ok: true }),
  });
  assert.doesNotThrow(() => createBusinessCommandAuthorizer({ ...f.options, registry: defineCommands({ change: command }) }));
});

test('current actor must have matching App, command grant and complete read footprint', () => {
  const f = fixture(),
    authorizer = f.create();
  for (const identity of [
    { ...actor, appId: 'other' },
    { ...actor, roles: ['inactive'] },
    { ...actor, roles: ['incomplete'] },
    { ...actor, roles: [] },
    { ...actor, id: ' ' },
  ]) {
    assert.throws(() => authorizer.authorize('change', identity), AppAccessDenied);
  }
  assert.throws(() => authorizer.authorize('missing', actor), AppAccessDenied);
});

test('App, schema, ownership, callbacks and actor are captured without retaining mutable policy', () => {
  const f = fixture(),
    authorizer = f.create();
  f.app.auth!.roles!.operator.commands = [];
  f.schema.tables[0].columns[0].primaryKey = false;
  f.options.connectionFor = () => 'other';
  f.options.managedOwnership = { item: 'value' };
  const identity = { ...actor, roles: ['operator'], secret: 'not returned' };
  const authorized = authorizer.authorize('change', identity);
  identity.roles.length = 0;
  identity.id = 'other';
  assert.deepEqual(authorized.actor, actor);
  assert.equal(authorized.connection, 'private');
  assert.deepEqual(authorized.keyColumns, ['id']);
  assert.equal('secret' in authorized.actor, false);
});

for (const target of ['options', 'app', 'schema', 'registry', 'managedOwnership', 'actor'] as const) {
  test(`${target} proxy/getter data cannot execute hooks`, () => {
    let hooks = 0;
    for (const kind of ['proxy', 'getter'] as const) {
      const f = fixture();
      if (target === 'actor') {
        const value =
          kind === 'proxy'
            ? new Proxy(actor, {
                get: () => {
                  hooks++;
                  throw new Error();
                },
                ownKeys: () => {
                  hooks++;
                  return [];
                },
              })
            : Object.defineProperty({ ...actor }, 'roles', {
                get() {
                  hooks++;
                  return ['operator'];
                },
                enumerable: true,
              });
        assert.throws(() => f.create().authorize('change', value), AppAccessDenied);
      } else if (target === 'options') {
        const value =
          kind === 'proxy'
            ? new Proxy(f.options, {
                ownKeys: () => {
                  hooks++;
                  return [];
                },
              })
            : Object.defineProperty({ ...f.options }, 'app', {
                get() {
                  hooks++;
                  return f.app;
                },
                enumerable: true,
              });
        assert.throws(() => createBusinessCommandAuthorizer(value), BusinessCommandDefinitionError);
      } else {
        const original = f.options[target]!;
        const value =
          kind === 'proxy'
            ? new Proxy(original, {
                ownKeys: () => {
                  hooks++;
                  return [];
                },
                getPrototypeOf: () => {
                  hooks++;
                  return null;
                },
              })
            : Object.defineProperty({}, 'hostile', {
                get() {
                  hooks++;
                  return null;
                },
                enumerable: true,
              });
        Object.assign(f.options, { [target]: value });
        assert.throws(f.create, BusinessCommandDefinitionError);
      }
    }
    assert.equal(hooks, 0);
  });
}

test('actor projection ignores unrelated getters and rejects inherited identity or nested role proxies', () => {
  const authorizer = fixture().create();
  let hooks = 0;
  const identity = Object.defineProperty({ ...actor }, 'secret', {
    get() {
      hooks++;
      return 'private';
    },
  });
  assert.deepEqual(authorizer.authorize('change', identity).actor, actor);
  assert.throws(() => authorizer.authorize('change', Object.create(actor)), AppAccessDenied);
  assert.throws(
    () =>
      authorizer.authorize('change', {
        ...actor,
        roles: new Proxy(['operator'], {
          ownKeys: () => {
            hooks++;
            return [];
          },
        }),
      }),
    AppAccessDenied,
  );
  assert.equal(hooks, 0);
});

test('forged command instances and proxy metadata callbacks refuse without invoking traps', () => {
  let hooks = 0;
  const f = fixture();
  f.options.registry = {
    change: new Proxy(f.command, {
      get: () => {
        hooks++;
        throw new Error();
      },
    }),
  };
  assert.throws(f.create, BusinessCommandDefinitionError);
  f.options.registry = defineCommands({ change: f.command });
  f.options.writableConnection = new Proxy(() => true, {
    apply: () => {
      hooks++;
      return true;
    },
  });
  assert.throws(f.create, BusinessCommandDefinitionError);
  assert.equal(hooks, 0);
});

for (const callback of ['connectionFor', 'writableConnection', 'transactionalConnection'] as const) {
  test(`${callback} refuses native async metadata and consumes its rejected result`, async () => {
    const f = fixture();
    Object.assign(f.options, { [callback]: () => Promise.reject(new Error('private callback failure')) });
    assert.throws(f.create, BusinessCommandDefinitionError);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('secondary-source metadata and ownership use exact logical addresses while table accepts only local names', () => {
  const f = fixture();
  f.app.sources!.business.default = false;
  f.app.sources!.directory = { connection: 'unused', default: true };
  for (const table of f.schema.tables) table.id = `business.${table.id}`;
  f.app.resources = Object.fromEntries(
    Object.entries(f.app.resources ?? {}).map(([name, block]) => [`business.${name}`, { ...block, source: 'business' }]),
  );
  roles(f.app).incomplete.read = ['business.item'];
  setFieldCeilings(f.app, { 'business.item': { read: ['id', 'value'], write: ['id', 'value'] } });
  f.options.managedOwnership = { 'business.item': 'tenant_id' };
  const authorized = f.create().authorize('change', actor);
  assert.equal(authorized.resource, 'business.item');
  assert.deepEqual(authorized.read, ['business.item', 'business.reference']);
  assert.equal(authorized.table('item', true), 'business.item');
  assert.throws(() => authorized.table('business.item'), AppAccessDenied);
});

function execution(
  receiptOwner?: AuthorizedBusinessCommand['receiptOwner'],
  resource = 'item',
  validate: (value: unknown) => unknown = (value) => value,
) {
  const f = fixture();
  let stored: StoredCommandReceipt | undefined,
    transactions = 0;
  const { version: _version, ...definition } = f.command;
  const command = defineCommand({ ...definition, validate: validate as never });
  const records: WriteTransaction = {
    query: async () => ({
      columns: ['id', 'tenant_id', 'value', 'version'],
      rows: [{ id: 'one', tenant_id: 'north', value: 'old', version: 0 }],
      ms: 0,
      sql: { text: '', params: [] },
    }),
    count: async () => assert.fail('This command must not count'),
    insert: async () => assert.fail('This command must not insert'),
    remove: async () => assert.fail('This command must not remove'),
    update: async () => assert.fail('This command must not update'),
  };
  const journal: CommandJournal = {
    find: async () => stored,
    commit: async (receipt) => {
      stored = { ...receipt };
    },
  };
  const authorized: AuthorizedBusinessCommand = {
    command,
    actor,
    resource,
    keyColumns: ['id'],
    versionField: 'version',
    catalog: commandCatalog(f.schema, command.read, (local) => local)!,
    ...(receiptOwner === undefined ? {} : { receiptOwner }),
    transaction: async (run) => run(records),
    commandTransaction: async (run) => {
      transactions++;
      return run(records, journal);
    },
  };
  const binding: BusinessCommandBinding = { authorize: () => authorized };
  return {
    binding,
    authorized,
    fingerprint: () => stored?.fingerprint,
    transactions: () => transactions,
    run: () => executeBusinessCommand(binding, actor, request),
  };
}

test('ordinary fingerprint bytes remain exactly unchanged when no owner is present', async () => {
  const f = execution();
  await f.run();
  const expected = createHash('sha256')
    .update(
      canonicalCommandJson({
        command: request.command,
        commandVersion: 1,
        source: 'business',
        target: 'item',
        key: request.key,
        expectedVersion: 0,
        input: request.input,
      }),
    )
    .digest('hex');
  assert.equal(f.fingerprint(), expected);
});

test('tenant/store/resolved resource separate fingerprints without adding execution revisions or deployment', async () => {
  const cases = [
    execution(owner),
    execution({ ...owner, tenantId: 'south' }),
    execution({ ...owner, storeId: 'other' }),
    execution(owner, 'business.item'),
    execution(),
  ];
  for (const f of cases) await f.run();
  assert.equal(new Set(cases.map((f) => f.fingerprint())).size, cases.length);
  const replay = cases[0];
  Object.assign(replay.authorized, { membershipVersion: '99', deployment: 'new-deployment', roles: ['another-role'] });
  assert.equal((await replay.run()).replayed, true);
});

test('tenant owner and resolved resource are detached before a trusted validator can mutate them', async () => {
  const mutable = { ...owner };
  const f = execution(mutable, 'item', (value) => {
    mutable.tenantId = 'south';
    Object.assign(f.authorized, { resource: 'other' });
    return value;
  });
  const baseline = execution(owner);
  await baseline.run();
  assert.equal((await f.run()).resource, 'item');
  assert.equal(f.fingerprint(), baseline.fingerprint());
});

test('matching a different command source changes the fingerprint; changing stable owner cannot replay an old one', async () => {
  const f = execution({ ...owner }),
    other = execution({ ...owner, sourceId: 'other' });
  const { version: _version, ...definition } = other.authorized.command;
  Object.assign(other.authorized, { command: defineCommand({ ...definition, source: 'other' }) });
  await f.run();
  await other.run();
  assert.notEqual(f.fingerprint(), other.fingerprint());
  Object.assign(f.authorized, { receiptOwner: { ...owner, tenantId: 'south' } });
  await assert.rejects(f.run, (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'idempotency_conflict');
});

for (const receiptOwner of [
  null,
  {},
  { ...owner, tenantId: 'North' },
  { ...owner, tenantId: 'north ' },
  { ...owner, sourceId: 'other' },
  { ...owner, sourceId: 'business.alias' },
  { ...owner, storeId: '' },
  { ...owner, storeId: 'x'.repeat(257) },
  { ...owner, storeId: '\ud800' },
  { ...owner, membershipVersion: '2' },
  { ...owner, deployment: 'new' },
  { ...owner, connection: '/private.db' },
]) {
  test(`malformed receipt owner ${JSON.stringify(receiptOwner)} refuses before transaction`, async () => {
    const f = execution(receiptOwner as AuthorizedBusinessCommand['receiptOwner']);
    await assert.rejects(f.run, BusinessCommandExecutionError);
    assert.equal(f.transactions(), 0);
  });
}

test('receipt-owner property/getters/proxies/thenables never execute hostile hooks', async () => {
  let hooks = 0;
  const thenable = { ...owner };
  Reflect.set(thenable, 'then', () => {
    hooks++;
  });
  for (const value of [
    new Proxy(owner, {
      ownKeys: () => {
        hooks++;
        return [];
      },
    }),
    Object.defineProperty({ ...owner }, 'tenantId', {
      get() {
        hooks++;
        return 'north';
      },
      enumerable: true,
    }),
    thenable,
  ]) {
    const f = execution(value);
    await assert.rejects(f.run);
    assert.equal(f.transactions(), 0);
  }
  const f = execution();
  Object.defineProperty(f.authorized, 'receiptOwner', {
    get() {
      hooks++;
      return owner;
    },
  });
  await assert.rejects(f.run);
  assert.equal(hooks, 0);
});

test('request owner cannot replace the private receipt owner', async () => {
  const f = execution(owner);
  await assert.rejects(executeBusinessCommand(f.binding, actor, { ...request, receiptOwner: { ...owner, tenantId: 'south' } }));
  assert.equal(f.transactions(), 0);
});
