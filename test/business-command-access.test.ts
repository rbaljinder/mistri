import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adapter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { resource, setFieldCeilings } from './support/appCeilings.js';
import type { DatabaseSchema, ForeignKey } from '../packages/engine/src/shared/schema.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandDefinitionError,
  callerRead,
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
} from '../packages/mistri/src/server/commands/businessCommands.js';

const actor: BusinessCommandActor = { id: 'verified-account', appId: 'loans', roles: ['approver'] };
const query = (table: string) => ({ table, limit: 10, offset: 0 });

function fixture() {
  const calls: Array<{ operation: string; connection: string; table?: string; request?: unknown }> = [];
  let handlerCalls = 0;
  const writable = new Set(['primary-db', 'stock-db']);
  const schema: DatabaseSchema = {
    label: 'Command fixture',
    dialect: 'sqlite',
    readAt: '2026-09-06',
    foreignKeys: [],
    tables: ['loan', 'note', 'reference', 'secret', 'generic_record', 'inventory.asset', 'inventory.audit'].map((id) => ({
      id,
      name: id.split('.').at(-1)!,
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false },
        { name: 'loan_id', type: 'integer', nullable: true, primaryKey: false },
        { name: 'version', type: 'integer', nullable: false, primaryKey: false },
      ],
    })),
  };
  const sql = { text: 'fixture', params: [] };
  const adapters = new Map<string, Adapter>();
  for (const connection of ['primary-db', 'stock-db']) {
    const record = (operation: string, table?: string, request?: unknown) => {
      calls.push({ operation, connection, table, request });
    };
    const transaction: WriteTransaction = {
      query: async (request) => {
        record('query', request.table, request);
        return { columns: ['name'], rows: [{ name: 'Known record' }], ms: 0, sql };
      },
      count: async (table) => {
        record('count', table);
        return 1;
      },
      insert: async (request) => {
        record('insert', request.table, request);
        return { key: { id: 2 }, applied: request.values, sql };
      },
      update: async (request) => {
        record('update', request.table, request);
        return { affected: 1, applied: request.values, sql };
      },
      remove: async (request) => {
        record('remove', request.table, request);
        return { affected: 1, sql };
      },
    };
    adapters.set(connection, {
      ...transaction,
      dialect: 'sqlite',
      introspect: async () => schema,
      close: async () => {},
      transaction: async (run) => {
        record('begin');
        try {
          const result = await run(transaction);
          record('commit');
          return result;
        } catch (error) {
          record('rollback');
          throw error;
        }
      },
    });
  }
  const connectionFor = (resource: string) => {
    if (!schema.tables.some((table) => table.id === resource)) throw new Error('Unknown fixture resource.');
    return resource.startsWith('inventory.') ? 'stock-db' : 'primary-db';
  };
  const resources: RuntimeResources = {
    schema,
    adapter: adapters.get('primary-db')!,
    connections: ['primary-db', 'stock-db'],
    connectionFor,
    toPhysical: (resource) => {
      connectionFor(resource);
      return `physical_${resource.split('.').at(-1)}`;
    },
    toLogical: (table) => table.replace(/^physical_/, ''),
    toLogicalAt: (table, connection) => `${connection === 'stock-db' ? 'inventory.' : ''}${table.replace(/^physical_/, '')}`,
    forConnection: (connection) => {
      const adapter = adapters.get(connection);
      if (!adapter) throw new Error('Unknown fixture connection.');
      return adapter;
    },
  };
  const app = parseAppConfig(
    {
      id: 'loans',
      name: 'Loans',
      sources: { operations: { connection: 'primary-db', default: true }, inventory: { connection: 'stock-db' } },
      resources: {
        loan: { access: 'write' },
        note: { access: 'write' },
        reference: {},
        generic_record: { access: 'write' },
        'inventory.asset': { access: 'write' },
        'inventory.audit': { access: 'write' },
      },
      auth: {
        roles: {
          approver: { read: true, commands: ['approve-loan'] },
          viewer: { read: true },
          incomplete: { read: ['loan'], commands: ['approve-loan'] },
          writer: { read: true, write: ['generic_record'] },
        },
      },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'command fixture',
  );
  const definition = (source = 'operations', target = 'loan', read = ['loan', 'reference'], write = ['loan']) =>
    defineCommand({
      targets: 'none',
      source,
      target,
      read,
      write,
      input: {},
      output: { parse: (value: unknown) => value },
      handle: (): unknown => {
        handlerCalls++;
        return undefined;
      },
    });
  let registry = defineCommands({ 'approve-loan': definition() });
  const bind = () => bindBusinessCommands({ app, registry, resources, writableConnection: (connection) => writable.has(connection) });
  return {
    app,
    schema,
    resources,
    calls,
    writable,
    adapters,
    definition,
    bind,
    setRegistry: (next: typeof registry) => {
      registry = next;
    },
    handlerCalls: () => handlerCalls,
  };
}

test('binding and authorization never execute the handler or query data; explicit command grants do not require CRUD writes', async () => {
  const f = fixture();
  const bound = f.bind();
  const authorized = bound.authorize('approve-loan', actor);
  assert.equal(authorized.command.source, 'operations');
  assert.equal(authorized.resource, 'loan');
  assert.deepEqual(authorized.actor, actor);
  assert.deepEqual(f.calls, []);
  assert.equal(f.handlerCalls(), 0);
  assert.deepEqual(resolveAppAccess(f.app, f.schema, actor.roles.slice()).writable, new Set());
  const result = await authorized.transaction(async (tx) => {
    await tx.query(query('reference'));
    await tx.update({ table: 'loan', key: { id: 1 }, values: { name: 'Approved' } });
    return 'finished';
  });
  assert.equal(result, 'finished');
  assert.deepEqual(
    f.calls.map(({ operation, connection, table }) => [operation, connection, table]),
    [
      ['begin', 'primary-db', undefined],
      ['query', 'primary-db', 'reference'],
      ['update', 'primary-db', 'loan'],
      ['commit', 'primary-db', undefined],
    ],
  );
  assert.equal(f.handlerCalls(), 0);
});

test('setup rejects missing named-source ownership, absent auth/access and unknown command grants', () => {
  for (const key of ['sources', 'auth'] as const) {
    const f = fixture();
    delete f.app[key];
    assert.throws(f.bind, BusinessCommandDefinitionError, key);
    assert.deepEqual(f.calls, []);
  }
  const undefaulted = fixture();
  for (const source of Object.values(undefaulted.app.sources!)) source.default = false;
  assert.throws(undefaulted.bind, BusinessCommandDefinitionError, 'default source');
  assert.deepEqual(undefaulted.calls, []);
  const f = fixture();
  f.app.auth!.roles!.viewer.commands = ['unregistered-command'];
  assert.throws(f.bind, BusinessCommandDefinitionError);
  assert.equal(f.handlerCalls(), 0);
});

test('a root field rule on a command footprint binds: generic reads narrow, the command reads its footprint whole', async () => {
  const f = fixture();
  setFieldCeilings(f.app, { loan: { read: ['id', 'name', 'version'] } });
  const authorized = f.bind().authorize('approve-loan', actor);
  assert.equal(f.calls.length, 0);
  assert.deepEqual([...resolveAppAccess(f.app, f.schema, ['approver']).fields!.get('loan')!.read], ['id', 'name', 'version']);
  // loan_id is outside the ceiling; the handler, the App's own server code, still reads and writes it.
  await authorized.transaction(async (tx) => {
    await tx.query({ ...query('loan'), columns: ['id', 'loan_id'] });
    await tx.update({ table: 'loan', key: { id: 1 }, values: { loan_id: 7 } });
  });
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'query', 'update', 'commit'],
  );
  const g = fixture();
  g.app.auth!.roles!.writer.fields = { generic_record: { read: ['id', 'name'], write: ['name'] } };
  assert.equal(g.bind().authorize('approve-loan', actor).resource, 'loan');
});

test('a role rule that only narrows reads on a command footprint binds: its generic reads narrow, the command still runs', () => {
  for (const where of ['granted', 'inactive', 'secondary'] as const) {
    const f = fixture();
    if (where === 'granted') f.app.auth!.roles!.approver.fields = { reference: { read: ['id'] }, loan: { read: ['id', 'name'] } };
    if (where === 'inactive') f.app.auth!.roles!.viewer.fields = { reference: { read: ['id'] } };
    if (where === 'secondary') {
      f.setRegistry(defineCommands({ 'approve-loan': f.definition('inventory', 'asset', ['asset', 'audit'], ['asset']) }));
      f.app.auth!.roles!.viewer.fields = { 'inventory.audit': { read: ['id'] } };
    }
    const bound = f.bind();
    assert.equal(bound.authorize('approve-loan', actor).command.source, where === 'secondary' ? 'inventory' : 'operations');
    assert.deepEqual(f.calls, []);
    if (where === 'granted') {
      // What the role reads generically is narrowed; the command's footprint is not.
      assert.deepEqual([...resolveAppAccess(f.app, f.schema, ['approver']).fields!.get('reference')!.read], ['id']);
    }
  }
});

test('a command requires visible eligibility columns while its revision stays server-owned', () => {
  const f = fixture();
  f.setRegistry(
    defineCommands({
      'approve-loan': defineCommand({
        source: 'operations',
        target: 'loan',
        read: ['loan'],
        write: ['loan'],
        when: "name = 'Pending'",
        input: {},
        output: { parse: (value: unknown) => value },
        handle: () => undefined,
      }),
    }),
  );
  f.app.auth!.roles!.approver.fields = { loan: { read: ['id', 'loan_id', 'version'] } };
  assert.throws(f.bind, /role "approver", which does not read a column of "loan" its "when" judges/);
  f.app.auth!.roles!.approver.fields = { loan: { read: ['id', 'name'] } };
  assert.doesNotThrow(f.bind);
  // A revision is server-owned even when hidden from every role.
  f.app.auth!.roles!.approver.fields = undefined;
  resource(f.app, 'loan').hidden = ['version'];
  assert.doesNotThrow(f.bind);
  delete resource(f.app, 'loan').hidden;
  f.app.auth!.roles!.approver.fields = { loan: { read: ['id', 'name', 'version'] } };
  assert.equal(f.bind().authorize('approve-loan', actor).resource, 'loan');
  // The same rule on a role not granted the command narrows only that role's reads.
  f.app.auth!.roles!.approver.fields = undefined;
  f.app.auth!.roles!.viewer.fields = { loan: { read: ['id', 'loan_id'] } };
  assert.equal(f.bind().authorize('approve-loan', actor).resource, 'loan');
});

test('setup validates command source, footprint existence, app ceilings, views and physical transaction support', () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => f.setRegistry(defineCommands({ 'approve-loan': f.definition('missing') })),
    (f) => f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'missing', ['missing'], ['missing']) })),
    (f) => f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'secret', ['secret'], ['secret']) })),
    (f) => f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'reference', ['reference'], ['reference']) })),
    (f) => {
      f.schema.tables.find((table) => table.id === 'loan')!.isView = true;
    },
    (f) => {
      f.writable.delete('primary-db');
    },
    (f) => {
      delete f.adapters.get('primary-db')!.transaction;
    },
    (f) => {
      f.resources.connectionFor = (resource) => (resource === 'reference' ? 'stock-db' : 'primary-db');
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(f.bind, BusinessCommandDefinitionError);
    assert.deepEqual(f.calls, []);
  }
});

test('unknown commands, missing identities, wrong app and insufficient verified grants deny before transaction', () => {
  const f = fixture();
  const bound = f.bind();
  const invalid: BusinessCommandActor[] = [
    { ...actor, id: '' },
    { ...actor, id: ' ' },
    { ...actor, appId: 'other-app' },
    { ...actor, roles: [] },
    { ...actor, roles: ['unknown'] },
    { ...actor, roles: ['viewer'] },
    { ...actor, roles: ['writer'] },
    { ...actor, roles: ['incomplete'] },
    { ...actor, roles: ['constructor'] },
  ];
  for (const identity of invalid) assert.throws(() => bound.authorize('approve-loan', identity), AppAccessDenied);
  for (const id of ['missing', 'constructor', '*']) assert.throws(() => bound.authorize(id, actor), AppAccessDenied);
  assert.deepEqual(f.calls, []);
});

test('every transaction operation is confined to bare source-local footprint names', async () => {
  const operations: Array<(tx: WriteTransaction, table: string) => Promise<unknown>> = [
    (tx, table) => tx.query(query(table)),
    (tx, table) => tx.count(table),
    (tx, table) => tx.insert({ table, values: { name: 'No' } }),
    (tx, table) => tx.update({ table, key: { id: 1 }, values: { name: 'No' } }),
    (tx, table) => tx.remove({ table, key: { id: 1 } }),
  ];
  for (const operation of operations) {
    for (const table of ['note', 'secret', 'inventory.asset', 'operations.loan', 'physical_loan', 'loan.name', 'constructor']) {
      const f = fixture();
      const authorized = f.bind().authorize('approve-loan', actor);
      await assert.rejects(
        authorized.transaction((tx) => operation(tx, table)),
        AppAccessDenied,
      );
      assert.deepEqual(
        f.calls.map((call) => call.operation),
        ['begin', 'rollback'],
      );
    }
  }
  for (const operation of operations.slice(2)) {
    const f = fixture();
    await assert.rejects(
      f
        .bind()
        .authorize('approve-loan', actor)
        .transaction((tx) => operation(tx, 'reference')),
      AppAccessDenied,
    );
    assert.deepEqual(
      f.calls.map((call) => call.operation),
      ['begin', 'rollback'],
    );
  }
});

test('secondary command transactions keep their source and translate bare names to logical secondary addresses', async () => {
  const f = fixture();
  f.setRegistry(defineCommands({ 'approve-loan': f.definition('inventory', 'asset', ['asset', 'audit'], ['asset', 'audit']) }));
  const authorized = f.bind().authorize('approve-loan', actor);
  assert.equal(authorized.resource, 'inventory.asset');
  assert.equal(authorized.command.target, 'asset');
  await authorized.transaction(async (tx) => {
    await tx.query(query('asset'));
    await tx.count('audit');
    await tx.insert({ table: 'audit', values: { name: 'Checked' } });
    await tx.update({ table: 'asset', key: { id: 1 }, values: { name: 'Ready' } });
    await tx.remove({ table: 'audit', key: { id: 2 } });
  });
  assert.deepEqual(
    f.calls.map(({ operation, connection, table }) => [operation, connection, table]),
    [
      ['begin', 'stock-db', undefined],
      ['query', 'stock-db', 'inventory.asset'],
      ['count', 'stock-db', 'inventory.audit'],
      ['insert', 'stock-db', 'inventory.audit'],
      ['update', 'stock-db', 'inventory.asset'],
      ['remove', 'stock-db', 'inventory.audit'],
      ['commit', 'stock-db', undefined],
    ],
  );
});

test('physical read-only changes are rechecked when opening a previously authorized transaction', async () => {
  const f = fixture();
  const authorized = f.bind().authorize('approve-loan', actor);
  f.writable.delete('primary-db');
  let ran = false;
  await assert.rejects(
    async () =>
      authorized.transaction(async () => {
        ran = true;
      }),
    AppAccessDenied,
  );
  assert.equal(ran, false);
  assert.deepEqual(f.calls, []);
});

test('command-owned writes reject overlapping generic CRUD grants even on inactive roles', () => {
  for (const grant of [true, ['loan']]) {
    const f = fixture();
    f.app.auth!.roles!.writer.write = grant;
    assert.throws(f.bind, BusinessCommandDefinitionError);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.setRegistry(defineCommands({ 'approve-loan': f.definition('inventory', 'asset', ['asset'], ['asset']) }));
  f.app.auth!.roles!.writer.write = ['inventory.asset'];
  assert.throws(f.bind, BusinessCommandDefinitionError);
});

test('the overlap refusal names the role, the table and both ways out', () => {
  const f = fixture();
  f.app.auth!.roles!.writer.write = ['generic_record', 'loan'];
  assert.throws(f.bind, (error: Error) => {
    assert.equal(
      error.message,
      'Command "approve-loan" writes "loan", which role "writer" also edits in place [command-and-edit]. ' +
        'Say which of its columns the role edits, fields: { loan: { read: [...], write: [...] } } in the role, or give "loan" a machine whose verbs move its state; ' +
        'or leave "loan" to commands (role "writer": write: [\'generic_record\']).',
    );
    return true;
  });
});

test('every role that edits a command-written table, and every conflict of its revision column, is said in one refusal', () => {
  const f = fixture();
  f.app.auth!.roles!.writer.write = ['generic_record', 'loan'];
  f.app.auth!.roles!.clerk = { read: true, write: ['loan'] } as never;
  assert.throws(f.bind, (error: Error) => {
    assert.match(error.message, /roles "writer", "clerk" also edit in place \[command-and-edit\]/);
    return true;
  });
  // One role names the revision column, another edits the table with no word at all: both are said, in one run.
  f.setRegistry(
    defineCommands({
      'approve-loan': defineCommand({
        source: 'operations',
        target: 'loan',
        read: ['loan'],
        write: ['loan'],
        input: {},
        output: { parse: (value: unknown) => value },
        handle: () => undefined,
      }),
    }),
  );
  f.app.auth!.roles!.writer.fields = { loan: { read: ['id', 'loan_id', 'name', 'version'], write: ['loan_id', 'version'] } };
  assert.throws(f.bind, (error: Error) => {
    const lines = error.message.split('\n');
    assert.equal(lines.length, 2, error.message);
    assert.match(lines[0]!, /writes "loan", which role "clerk" also edits in place/);
    assert.match(lines[1]!, /keeps its revision in "version" of "loan", which roles "writer", "clerk" also edit in place/);
    return true;
  });
});

test('a table a command writes is also edited in place once the role says which columns it edits, or the table has a machine', () => {
  const f = fixture();
  f.app.auth!.roles!.writer.write = ['generic_record', 'loan'];
  // The role edits the loan's link and nothing else: the rest is the command's.
  f.app.auth!.roles!.writer.fields = { loan: { read: ['id', 'loan_id', 'name', 'version'], write: ['loan_id'] } };
  assert.equal(f.bind().authorize('approve-loan', actor).resource, 'loan');
  const writer = resolveAppAccess(f.app, f.schema, ['writer']);
  assert.deepEqual([...writer.fields!.get('loan')!.write].sort(), ['loan_id']);
  // A command that keeps its revision on the edited target: the role may not edit that column.
  f.setRegistry(
    defineCommands({
      'approve-loan': defineCommand({
        source: 'operations',
        target: 'loan',
        read: ['loan'],
        write: ['loan'],
        input: {},
        output: { parse: (value: unknown) => value },
        handle: () => undefined,
      }),
    }),
  );
  f.app.auth!.roles!.writer.fields = { loan: { read: ['id', 'loan_id', 'name', 'version'], write: ['loan_id', 'version'] } };
  assert.throws(f.bind, /keeps its revision in "version" of "loan", which role "writer" also edits in place \[command-and-edit\]/);
  f.app.auth!.roles!.writer.fields = { loan: { read: ['id', 'loan_id', 'name', 'version'], write: ['loan_id'] } };
  assert.equal(f.bind().authorize('approve-loan', actor).resource, 'loan');
  // Or no column rule at all, and a machine: its column moves only by its verbs, whoever edits the rest.
  delete f.app.auth!.roles!.writer.fields;
  f.setRegistry(defineCommands({ 'approve-loan': f.definition() }));
  resource(f.app, 'loan').machine = {
    column: 'name',
    states: [
      { name: 'open', label: 'Open' },
      { name: 'closed', label: 'Closed', final: true },
    ],
    edges: [{ verb: 'approve-loan', from: 'open', to: ['closed'], command: 'approve-loan', label: 'Approve loan' }],
  };
  assert.equal(f.bind().authorize('approve-loan', actor).resource, 'loan');
});

test('a command App missing its requirements is told which, and the line that supplies each', () => {
  const f = fixture();
  const bare = parseAppConfig(
    {
      name: 'Loans',
      connection: 'primary-db',
      resources: { loan: { access: 'write' } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'bare',
  );
  assert.throws(
    () =>
      bindBusinessCommands({
        app: bare,
        registry: defineCommands({ 'approve-loan': f.definition() }),
        resources: f.resources,
        writableConnection: () => true,
      }),
    (error: Error) => {
      assert.equal(
        error.message,
        'Business commands need named sources (connection "primary-db" is not a name a source can have: ' +
          'sources: { main: { connection: "primary-db", default: true } }), and sign-in with role grants, since a command runs only ' +
          "for a role granted it (auth: { roles: { staff: { read: true, commands: ['…'] } } }, and BETTER_AUTH_SECRET in the environment).",
      );
      return true;
    },
  );
});

test('physical writability is rechecked after a queued transaction acquires its connection', async () => {
  const f = fixture();
  const adapter = f.adapters.get('primary-db')!;
  const original = adapter.transaction!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.transaction = async (run) => {
    await gate;
    return original(run);
  };
  const authorized = f.bind().authorize('approve-loan', actor);
  let ran = false;
  const waiting = authorized.transaction(async () => {
    ran = true;
  });
  f.writable.delete('primary-db');
  release();
  await assert.rejects(waiting, AppAccessDenied);
  assert.equal(ran, false);
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'rollback'],
  );
});

test('caught resource mapping and write refusals still force transaction rollback', async () => {
  for (const refuse of [
    (tx: WriteTransaction) => tx.count('inventory.asset'),
    (tx: WriteTransaction) => tx.update({ table: 'reference', key: { id: 1 }, values: { name: 'No' } }),
  ]) {
    const f = fixture();
    const authorized = f.bind().authorize('approve-loan', actor);
    let caught = false;
    await assert.rejects(
      authorized.transaction(async (tx) => {
        await tx.update({ table: 'loan', key: { id: 1 }, values: { name: 'Earlier accepted write' } });
        try {
          await refuse(tx);
        } catch (error) {
          assert.ok(error instanceof AppAccessDenied);
          caught = true;
        }
        return 'Handler tried to swallow the refusal';
      }),
      AppAccessDenied,
    );
    assert.equal(caught, true);
    assert.deepEqual(
      f.calls.map((call) => call.operation),
      ['begin', 'update', 'rollback'],
    );
  }
});

test('concurrent callback operations are serialized before reaching the transaction adapter', async () => {
  const f = fixture();
  const adapter = f.adapters.get('primary-db')!;
  const original = adapter.transaction!;
  let active = 0;
  let maximum = 0;
  adapter.transaction = (run) =>
    original((tx) =>
      run({
        ...tx,
        count: async (table, filter) => {
          maximum = Math.max(maximum, ++active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await tx.count(table, filter);
          } finally {
            active--;
          }
        },
      }),
    );
  await f
    .bind()
    .authorize('approve-loan', actor)
    .transaction(async (tx) => {
      assert.deepEqual(await Promise.all([tx.count('loan'), tx.count('reference'), tx.count('loan')]), [1, 1, 1]);
    });
  assert.equal(maximum, 1);
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'count', 'count', 'count', 'commit'],
  );
});

test('binding snapshots app policy and authorization snapshots an immutable verified actor', async () => {
  const f = fixture();
  const bound = f.bind();
  resource(f.app, 'secret').access = 'write';
  f.app.auth!.roles!.viewer.commands = ['approve-loan'];
  f.app.auth!.roles!.approver.read = [];
  f.app.auth!.roles!.approver.commands = [];
  f.app.sources!.operations.connection = 'stock-db';
  assert.throws(() => bound.authorize('approve-loan', { ...actor, roles: ['viewer'] }), AppAccessDenied);

  const original = { ...actor, roles: ['approver'] };
  const authorized = bound.authorize('approve-loan', original);
  original.roles.splice(0, 1, 'viewer');
  original.id = 'different-account';
  original.appId = 'different-app';
  assert.deepEqual(authorized.actor, actor);
  assert.notEqual(authorized.actor, original);
  assert.notEqual(authorized.actor.roles, original.roles);
  assert.equal(Object.isFrozen(authorized), true);
  assert.equal(Object.isFrozen(authorized.actor), true);
  assert.equal(Object.isFrozen(authorized.actor.roles), true);
  assert.throws(() => {
    (authorized.actor.roles as string[]).push('writer');
  }, TypeError);
  await authorized.transaction((tx) => tx.update({ table: 'loan', key: { id: 1 }, values: { name: 'Approved' } }));
  assert.deepEqual(
    f.calls.map((call) => [call.operation, call.connection]),
    [
      ['begin', 'primary-db'],
      ['update', 'primary-db'],
      ['commit', 'primary-db'],
    ],
  );
});

test('cascade and referenced-key changes cannot escape the command write footprint', async () => {
  const dependent: ForeignKey = {
    name: 'note_loan',
    from: { table: 'note', columns: ['loan_id'] },
    to: { table: 'loan', columns: ['id'] },
    onDelete: 'cascade',
  };
  for (const operation of [
    (tx: WriteTransaction) => tx.remove({ table: 'loan', key: { id: 1 } }),
    (tx: WriteTransaction) => tx.update({ table: 'loan', key: { id: 1 }, values: { id: 2 } }),
  ]) {
    const f = fixture();
    f.schema.foreignKeys.push(dependent);
    f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'loan', ['loan', 'note'], ['loan']) }));
    await assert.rejects(f.bind().authorize('approve-loan', actor).transaction(operation), AppAccessDenied);
    assert.deepEqual(
      f.calls.map((call) => call.operation),
      ['begin', 'rollback'],
    );
  }
  const allowed = fixture();
  allowed.schema.foreignKeys.push(dependent);
  allowed.setRegistry(defineCommands({ 'approve-loan': allowed.definition('operations', 'loan', ['loan', 'note'], ['loan', 'note']) }));
  await allowed
    .bind()
    .authorize('approve-loan', actor)
    .transaction((tx) => tx.remove({ table: 'loan', key: { id: 1 } }));
  assert.deepEqual(
    allowed.calls.map((call) => call.operation),
    ['begin', 'remove', 'commit'],
  );
});

test('restrict dependents still require reads while recursive cascades cannot reach undeclared tables', async () => {
  const f = fixture();
  f.schema.foreignKeys.push({
    name: 'note_loan',
    from: { table: 'note', columns: ['loan_id'] },
    to: { table: 'loan', columns: ['id'] },
    onDelete: 'restrict',
  });
  await assert.rejects(
    f
      .bind()
      .authorize('approve-loan', actor)
      .transaction((tx) => tx.remove({ table: 'loan', key: { id: 1 } })),
    AppAccessDenied,
  );
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'rollback'],
  );
  f.calls.length = 0;
  f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'loan', ['loan', 'note'], ['loan']) }));
  await f
    .bind()
    .authorize('approve-loan', actor)
    .transaction((tx) => tx.remove({ table: 'loan', key: { id: 1 } }));
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'remove', 'commit'],
  );

  f.calls.length = 0;
  f.schema.foreignKeys[0].onDelete = 'cascade';
  f.schema.foreignKeys.push({
    name: 'secret_note',
    from: { table: 'secret', columns: ['loan_id'] },
    to: { table: 'note', columns: ['id'] },
    onDelete: 'cascade',
  });
  f.setRegistry(defineCommands({ 'approve-loan': f.definition('operations', 'loan', ['loan', 'note'], ['loan', 'note']) }));
  await assert.rejects(
    f
      .bind()
      .authorize('approve-loan', actor)
      .transaction((tx) => tx.remove({ table: 'loan', key: { id: 1 } })),
    AppAccessDenied,
  );
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ['begin', 'rollback'],
  );
});

test('an elevated read binds for a role that cannot read the table, and is refused where it is not a plain read of the footprint', async () => {
  const f = fixture();
  const incomplete = { ...actor, roles: ['incomplete'] };
  assert.throws(() => f.bind().authorize('approve-loan', incomplete), AppAccessDenied);
  const elevated = (elevate: unknown, extra: Record<string, unknown> = {}) =>
    defineCommand({
      targets: 'none',
      source: 'operations',
      target: 'loan',
      read: ['loan', 'reference'],
      write: ['loan'],
      elevate,
      input: {},
      output: { parse: (value: unknown) => value },
      handle: () => undefined,
      ...extra,
    } as never);
  f.setRegistry(defineCommands({ 'approve-loan': elevated({ read: ['reference'] }) }));
  const authorized = f.bind().authorize('approve-loan', incomplete);
  assert.deepEqual(callerRead(authorized.command), ['loan']);
  await authorized.transaction(async (tx) => {
    await tx.query(query('reference'));
  });
  assert.deepEqual(
    f.calls.map((call) => [call.operation, call.table]),
    [
      ['begin', undefined],
      ['query', 'reference'],
      ['commit', undefined],
    ],
  );
  // The viewer still lacks the grant: an elevation is never a grant.
  assert.throws(() => f.bind().authorize('approve-loan', { ...actor, roles: ['viewer'] }), AppAccessDenied);

  assert.throws(() => elevated({ read: ['loan'] }), /names the target "loan"/);
  assert.throws(() => elevated({ read: ['note'] }), /not in its read footprint/);
  assert.throws(() => elevated({ read: [] }), /names no table/);
  assert.throws(() => elevated({ write: ['reference'] }), /unknown option: write/);
  assert.throws(
    () => elevated({ read: ['reference'] }, { read: ['loan', 'reference', 'note'], write: ['loan', 'note'], elevate: { read: ['note'] } }),
    /which it writes/,
  );
  assert.throws(() => elevated({ read: ['reference'] }, { public: true }), /public command has no role/);
});

test('check --design lists every elevation, with the granted roles that would not read the table otherwise', async () => {
  const { commandElevations } = await import('../packages/mistri/src/server/build/check.js');
  const f = fixture();
  const registry = defineCommands({
    'approve-loan': defineCommand({
      targets: 'none',
      source: 'operations',
      target: 'loan',
      read: ['loan', 'reference'],
      write: ['loan'],
      elevate: { read: ['reference'] },
      input: {},
      output: { parse: (value: unknown) => value },
      handle: () => undefined,
    }),
  });
  assert.deepEqual(commandElevations(f.app, registry, f.schema), [
    'command "approve-loan" reads "reference" under its own authority, for role "incomplete"',
  ]);
  assert.deepEqual(commandElevations(f.app, defineCommands({ 'approve-loan': f.definition() }), f.schema), []);
});
