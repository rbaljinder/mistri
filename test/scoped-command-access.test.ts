import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig, resolveAppAccess, resourceCeiling } from '../packages/mistri/src/shared/app.js';
import { setCeilings, setFieldCeilings } from './support/appCeilings.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { AppAccessDenied, authorizeResources } from '../packages/mistri/src/server/app/appAccess.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  type BusinessCommandActor,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

type Key = Readonly<Record<string, string | number>>;
type Extractor = (result: unknown) => readonly { table: string; key: Key }[];
const actor: BusinessCommandActor = { id: 'verified-manager', appId: 'desk', roles: ['manager'] };
const query = (table: string) => ({ table, limit: 20, offset: 0 });
const rule = (value = 1): Filter => ({ groups: [[{ column: 'desk', op: '=', value }]] });
const receipt: StoredCommandReceipt = {
  id: 'receipt-1',
  appId: 'desk',
  actorId: actor.id,
  commandId: 'assign',
  commandVersion: 1,
  idempotencyKey: 'attempt-1',
  fingerprint: 'digest',
  resultJson: '{"assigned":true}',
  requestId: 'request-1',
  completedAt: '2026-09-07T12:00:00.000Z',
};
const audit = { target: 'tickets', keyJson: '{"id":1}', changesJson: '[]' };
const notApplied = (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, 'not_applied');
  assert.ok(error.cause instanceof Error);
  return true;
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext, secondary = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-command-access-'));
  const sources: Record<string, AppAdapterSource> = {};
  const databases = new Map<string, DatabaseSync>();
  t.after(async () => {
    try {
      await Promise.all(Object.values(sources).map((source) => source.adapter.close()));
    } finally {
      for (const db of databases.values()) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const source of ['operations', 'archive']) {
    const path = join(directory, `${source}.db`);
    const db = new DatabaseSync(path);
    databases.set(source, db);
    db.exec(`CREATE TABLE raw_person (id INTEGER PRIMARY KEY, desk INTEGER, name TEXT);
      CREATE TABLE raw_ticket (id INTEGER PRIMARY KEY, desk INTEGER DEFAULT 1, name TEXT,
        owner_id INTEGER DEFAULT 1 REFERENCES raw_person(id));
      CREATE TABLE raw_pair (id INTEGER, part TEXT, desk INTEGER, PRIMARY KEY (id, part));
      CREATE TABLE raw_secret (id INTEGER PRIMARY KEY, desk INTEGER);
      CREATE TABLE raw_generic (id INTEGER PRIMARY KEY, desk INTEGER);
      INSERT INTO raw_person VALUES (1, 1, 'Visible'), (2, 2, 'Hidden');
      INSERT INTO raw_ticket VALUES (1, 1, 'Original', 1), (2, 2, 'Hidden', 2);
      INSERT INTO raw_pair VALUES (1, 'a', 1), (1, 'b', 2);
      INSERT INTO raw_secret VALUES (1, 1);
      INSERT INTO raw_generic VALUES (1, 1);`);
    migrateSqliteCommandJournal(path);
    const adapter = new SqliteAdapter(path, source);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: { people: 'raw_person', tickets: 'raw_ticket', pairs: 'raw_pair', secret: 'raw_secret', generic: 'raw_generic' },
    };
  }
  const runtime = createAppSourceAdapter(sources, 'operations');
  const anchors = new Map(['operations', 'archive'].map((source) => [`${source}-db`, runtime.forSource(source)]));
  const resources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: [...anchors.keys()],
    connectionFor: (resource) => `${runtime.resolve(resource).source}-db`,
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (physical) => runtime.catalogs.get('operations')!.toLogical(physical),
    toLogicalAt: (physical, connection) => {
      const source = connection.replace(/-db$/, '');
      const local = runtime.catalogs.get(source)!.toLogical(physical);
      return source === 'operations' ? local : `${source}.${local}`;
    },
    forConnection: (connection) => {
      const anchor = anchors.get(connection);
      if (!anchor) throw new Refusal('Unknown connection');
      return anchor;
    },
  };
  const written = ['tickets', 'generic', 'archive.tickets', 'archive.generic'];
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { operations: { connection: 'operations-db', default: true }, archive: { connection: 'archive-db' } },
      // Every catalog resource is read; four are the write ceiling.
      resources: Object.fromEntries(
        resources.schema.tables.map((table) => [table.id, written.includes(table.id) ? { access: 'write' } : {}]),
      ),
      auth: {
        roles: {
          manager: { read: true, write: false, commands: ['assign'] },
          viewer: { read: true },
          incomplete: { read: ['tickets', 'archive.tickets'], commands: ['assign'] },
          writer: { read: true, write: ['generic'] },
        },
      },
      views: { tickets: { kind: 'list', from: 'tickets' } },
      home: 'tickets',
    },
    'scoped command fixture',
  );
  const owner = secondary ? 'archive' : 'operations';
  const logical = (local: string) => (secondary ? `archive.${local}` : local);
  const definition = (read = ['tickets', 'people', 'pairs']) =>
    defineCommand({
      source: owner,
      target: 'tickets',
      read,
      write: ['tickets'],
      input: {},
      output: { parse: (value: unknown) => value },
      handle: (): unknown => assert.fail('The binder must never invoke a command handler'),
    });
  const registry = { assign: definition() };
  const resultReferences: Record<string, Extractor> = { assign: () => [] };
  const rows: Record<string, boolean | Filter> = Object.fromEntries(resources.schema.tables.map((table) => [table.id, rule()]));
  const writable = new Set(anchors.keys());
  let active = true;
  const assertActive = () => {
    if (!active) throw new AppAccessDenied();
  };
  const bind = () =>
    bindScopedBusinessCommands({
      app,
      resources,
      registry,
      resultReferences,
      writableConnection: (connection) => writable.has(connection),
    });
  const authorize = () => bind().withScope(rows, assertActive).authorize('assign', actor);
  const db = databases.get(owner)!;
  const state = () => ({
    name: db.prepare('SELECT name FROM raw_ticket WHERE id = 1').get()!.name,
    receipt: db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n,
    audit: db.prepare(`SELECT count(*) AS n FROM ${sqliteAuditRows} a`).get()!.n,
  });
  return {
    sources,
    anchors,
    resources,
    app,
    owner,
    logical,
    registry,
    definition,
    resultReferences,
    rows,
    writable,
    assertActive,
    retire: () => {
      active = false;
    },
    bind,
    authorize,
    db,
    databases,
    state,
  };
}

async function earlierWrites(records: WriteTransaction, journal: CommandJournal) {
  await records.update({ table: 'tickets', key: { id: 1 }, values: { name: 'Updated' } });
  await journal.commit(receipt, audit);
}

for (const secondary of [false, true]) {
  const label = secondary ? 'secondary aliases' : 'default aliases';
  test(`${label}: explicit command grants expose five source-local methods and a separate runtime journal`, async (t) => {
    const f = await fixture(t, secondary);
    const binding = f.bind().withScope(f.rows, f.assertActive);
    assert.equal(binding.scoped, true);
    const authorized = binding.authorize('assign', actor);
    assert.equal(authorized.resource, f.logical('tickets'));
    assert.deepEqual(authorized.keyColumns, ['id']);
    assert.equal(typeof authorized.assertTarget, 'function');
    assert.equal(typeof authorized.assertResult, 'function');
    assert.deepEqual(resolveAppAccess(f.app, f.resources.schema, [...actor.roles]).writable, new Set());
    const generic = authorizeResources(f.resources, resolveAppAccess(f.app, f.resources.schema, [...actor.roles]));
    await assert.rejects(
      async () => generic.adapter.update!({ table: f.logical('tickets'), key: { id: 1 }, values: { name: 'Bypass' } }),
      AppAccessDenied,
    );
    assert.equal(
      await commandsOf(authorized).commandTransaction!(async (records, journal) => {
        assert.deepEqual(Reflect.ownKeys(records).sort(), ['count', 'insert', 'query', 'remove', 'update']);
        assert.equal(Object.isFrozen(records), true);
        assert.deepEqual(Reflect.ownKeys(journal).sort(), ['commit', 'find', 'insert', 'nextNumber', 'taken']);
        assert.deepEqual(
          (await records.query(query('tickets'))).rows.map((row) => row.id),
          [1],
        );
        assert.equal(await records.count('people'), 1);
        await authorized.assertTarget!(records, { id: 1 });
        await authorized.assertResult!(records, { id: 1 }, { constant: true });
        await records.insert({ table: 'tickets', values: { id: 3, name: 'Transient' } });
        await records.remove({ table: 'tickets', key: { id: 3 } });
        await earlierWrites(records, journal);
        assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
        return 'committed';
      }),
      'committed',
    );
    assert.deepEqual(f.state(), { name: 'Updated', receipt: 1, audit: 1 });
    const other = f.databases.get(secondary ? 'operations' : 'archive')!;
    assert.equal(other.prepare('SELECT name FROM raw_ticket WHERE id = 1').get()!.name, 'Original');
    assert.equal(other.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n, 0);
  });

  test(`${label}: all five caught mapping refusals roll back earlier records and journal`, async (t) => {
    const f = await fixture(t, secondary);
    const authorized = f.authorize();
    for (const table of ['raw_ticket', 'operations.tickets', 'archive.tickets', 'secret', 'constructor', COMMAND_JOURNAL_TABLES.receipt]) {
      for (const operation of [
        (tx: WriteTransaction) => tx.query(query(table)),
        (tx: WriteTransaction) => tx.count(table),
        (tx: WriteTransaction) => tx.insert({ table, values: { id: 3 } }),
        (tx: WriteTransaction) => tx.update({ table, key: { id: 1 }, values: { name: 'No' } }),
        (tx: WriteTransaction) => tx.remove({ table, key: { id: 1 } }),
      ]) {
        let caught = false;
        await assert.rejects(
          commandsOf(authorized).commandTransaction!(async (records, journal) => {
            await earlierWrites(records, journal);
            await assert.rejects(async () => operation(records));
            caught = true;
          }),
          notApplied,
        );
        assert.equal(caught, true);
        assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
      }
    }
  });

  test(`${label}: current result references require visible exact composite PKs and local names`, async (t) => {
    const f = await fixture(t, secondary);
    let refs: ReturnType<Extractor> = [{ table: 'pairs', key: { id: 1, part: 'a' } }];
    f.resultReferences.assign = () => refs;
    const authorized = f.authorize();
    await commandsOf(authorized).commandTransaction!((records) => authorized.assertResult!(records, { id: 1 }, {}));
    const invalidReferences: ReturnType<Extractor> = [
      { table: 'pairs', key: { id: 1 } },
      { table: 'pairs', key: { id: 1, part: 'b' } },
      { table: 'pairs', key: { id: 1, part: 'a', desk: 1 } },
      { table: 'people', key: { id: 2 } },
      { table: 'people', key: { id: 999 } },
      { table: 'secret', key: { id: 1 } },
      { table: 'archive.people', key: { id: 1 } },
      { table: 'operations.people', key: { id: 1 } },
      { table: 'raw_person', key: { id: 1 } },
      { table: COMMAND_JOURNAL_TABLES.receipt, key: { id: 'receipt-1' } },
    ];
    for (const invalid of invalidReferences) {
      refs = [invalid];
      let caught = false;
      await assert.rejects(
        commandsOf(authorized).commandTransaction!(async (records, journal) => {
          await earlierWrites(records, journal);
          await assert.rejects(authorized.assertResult!(records, { id: 1 }, {}));
          caught = true;
        }),
        notApplied,
      );
      assert.equal(caught, true);
      assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
    }
  });
}

test('scoped authorization denies absent command grants, incomplete reads and forged actor identities', async (t) => {
  const f = await fixture(t);
  const bound = f.bind().withScope(f.rows, f.assertActive);
  for (const identity of [
    { ...actor, id: '' },
    { ...actor, id: ' ' },
    { ...actor, appId: 'foreign' },
    ...['viewer', 'writer', 'incomplete', 'constructor', 'unknown'].map((role) => ({ ...actor, roles: [role] })),
    { ...actor, roles: [] },
  ])
    assert.throws(() => bound.authorize('assign', identity), AppAccessDenied);
  for (const id of ['missing', 'constructor', '*']) assert.throws(() => bound.authorize(id, actor), AppAccessDenied);
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

for (const mutation of [
  'root read',
  'root write',
  'generic writes',
  'unknown source',
  'unknown mapping',
  'unknown extractor',
  'missing extractor',
] as const) {
  test(`binding refuses ${mutation} before execution`, async (t) => {
    const f = await fixture(t);
    if (mutation === 'root read')
      setCeilings(
        f.app,
        resourceCeiling(f.app).read.filter((id) => id !== 'people'),
        resourceCeiling(f.app).write,
      );
    if (mutation === 'root write') setCeilings(f.app, resourceCeiling(f.app).read, []);
    if (mutation === 'generic writes') f.app.auth!.roles!.viewer.write = ['tickets'];
    if (mutation === 'unknown source') delete f.app.sources!.operations;
    if (mutation === 'unknown mapping') f.resources.connectionFor = () => 'missing-db';
    if (mutation === 'unknown extractor') f.resultReferences.missing = () => [];
    if (mutation === 'missing extractor') delete f.resultReferences.assign;
    assert.throws(f.bind);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}

/* A field rule on a role the command is not granted to narrows that role's
   generic reads and nothing the command answers, so it binds. */
test('binding accepts a field rule on a role the command is not granted to', async (t) => {
  const f = await fixture(t);
  f.app.auth!.roles!.viewer.fields = { people: { read: ['id'] } };
  f.bind();
  // And the resource's own ceiling on the footprint: it narrows generic reads, never the handler.
  setFieldCeilings(f.app, { tickets: { read: ['id'] } });
  f.bind();
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

/* A `public: true` command never runs on a row-policy App: its public form
   answers 503 there and no role may hold a public command. So it needs no
   result extractor, an extractor for it is an extra name, and the scoped
   binding never authorizes it. */
const publicDefinition = (owner: string) =>
  defineCommand({
    targets: 'none',
    source: owner,
    target: 'tickets',
    read: ['tickets'],
    write: ['tickets'],
    public: true,
    input: {},
    output: { parse: (value: unknown) => value },
    handle: (): unknown => assert.fail('The binder must never invoke a command handler'),
  });

test('a public command needs no result extractor and binds beside the scoped ones', async (t) => {
  const f = await fixture(t);
  (f.registry as Record<string, unknown>).apply = publicDefinition(f.owner);
  assert.doesNotThrow(f.bind);
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('an extractor for a public command is an extra name and refuses the binding', async (t) => {
  const f = await fixture(t);
  (f.registry as Record<string, unknown>).apply = publicDefinition(f.owner);
  f.resultReferences.apply = () => [];
  assert.throws(f.bind, BusinessCommandDefinitionError);
});

test('the scoped binding never authorizes a public command', async (t) => {
  const f = await fixture(t);
  (f.registry as Record<string, unknown>).apply = publicDefinition(f.owner);
  assert.throws(() => f.bind().withScope(f.rows, f.assertActive).authorize('apply', actor));
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('field rules outside the footprint remain compatible with command grants', async (t) => {
  const f = await fixture(t);
  f.app.auth!.roles!.viewer.fields = { generic: { read: ['id'] } };
  await commandsOf(f.authorize()).commandTransaction!((records) => records.count('tickets'));
});

test('scoped commands require the optional scoped journal capability and never use ordinary fallbacks', async (t) => {
  const f = await fixture(t);
  const anchor = f.anchors.get('operations-db')!;
  let fallbacks = 0,
    callbacks = 0;
  const fallback = async (): Promise<never> => {
    fallbacks++;
    throw new Error('Unscoped fallback');
  };
  anchor.transaction = fallback;
  anchor.commandTransaction = fallback;
  anchor.scopeTransaction = fallback;
  const authorized = f.authorize();
  await assert.rejects(
    async () =>
      authorized.transaction(async () => {
        callbacks++;
      }),
    AppAccessDenied,
  );
  await commandsOf(authorized).commandTransaction!(async (records) => {
    assert.equal(await records.count('tickets'), 1);
  });
  delete commandsOf(anchor).scopeCommandTransaction;
  assert.throws(f.bind, BusinessCommandDefinitionError);
  assert.equal(fallbacks, 0);
  assert.equal(callbacks, 0);
});

test('binding snapshots app, catalog, ownership, source methods, registry and extractor table', async (t) => {
  const f = await fixture(t, true);
  f.resultReferences.assign = () => [{ table: 'people', key: { id: 1 } }];
  const bound = f.bind();
  f.app.auth!.roles!.manager.commands = [];
  f.app.auth!.roles!.viewer.commands = ['assign'];
  f.app.sources!.archive.connection = 'operations-db';
  f.registry.assign = f.definition(['tickets']);
  f.resultReferences.assign = () => {
    throw new Error('Mutated extractor');
  };
  f.resources.schema.tables.length = 0;
  f.resources.schema.foreignKeys.length = 0;
  f.resources.connections.length = 0;
  f.resources.connectionFor = () => 'operations-db';
  f.resources.forConnection = () => {
    throw new Error('Mutated owner lookup');
  };
  f.resources.toPhysical = () => 'raw_secret';
  f.resources.toLogicalAt = () => 'secret';
  f.anchors.get('archive-db')!.scopeCommandTransaction = async () => {
    throw new Error('Mutated scoped method');
  };
  const scoped = bound.withScope(f.rows, f.assertActive);
  assert.throws(() => scoped.authorize('assign', { ...actor, roles: ['viewer'] }), AppAccessDenied);
  const mutableActor = { ...actor, roles: ['manager'] };
  const authorized = scoped.authorize('assign', mutableActor);
  mutableActor.id = 'changed';
  mutableActor.roles.length = 0;
  assert.deepEqual(authorized.actor, actor);
  assert.equal(Object.isFrozen(authorized.actor.roles), true);
  await commandsOf(authorized).commandTransaction!(async (records, journal) => {
    await authorized.assertResult!(records, { id: 1 }, {});
    await earlierWrites(records, journal);
  });
  assert.deepEqual(f.state(), { name: 'Updated', receipt: 1, audit: 1 });
});

test('withScope snapshots all row rules before a queued physical acquisition', async (t) => {
  const f = await fixture(t);
  const anchor = f.anchors.get('operations-db')!;
  const original = commandsOf(anchor).scopeCommandTransaction!.bind(anchor);
  const wait = gate();
  anchor.scopeCommandTransaction = async (rows, run) => {
    await wait.promise;
    return original(rows, run);
  };
  const authorized = f.authorize();
  const pending = commandsOf(authorized).commandTransaction!(async (records) => {
    assert.deepEqual(
      (await records.query(query('tickets'))).rows.map((row) => row.id),
      [1],
    );
    assert.equal(await records.count('people'), 1);
  });
  (f.rows.tickets as Filter).groups[0][0].value = 2;
  f.rows.people = true;
  wait.release();
  await pending;
});

for (const mode of ['unknown table', 'foreign malformed rule', 'inherited', 'getter'] as const) {
  test(`whole row scope refuses ${mode} without invoking accessors`, async (t) => {
    const f = await fixture(t);
    let getters = 0,
      writers = 0;
    for (const anchor of f.anchors.values()) {
      const original = commandsOf(anchor).scopeCommandTransaction!.bind(anchor);
      anchor.scopeCommandTransaction = (rows, run) => {
        writers++;
        return original(rows, run);
      };
    }
    const rows =
      mode === 'unknown table'
        ? { ...f.rows, raw_ticket: true }
        : mode === 'foreign malformed rule'
          ? { ...f.rows, 'archive.people': { groups: [[{ column: 'missing', op: '=', value: 1 }]] } }
          : mode === 'inherited'
            ? Object.create(f.rows)
            : Object.defineProperty({}, 'tickets', {
                enumerable: true,
                get() {
                  getters++;
                  return true;
                },
              });
    await assert.rejects(async () => {
      const authorized = f
        .bind()
        .withScope(rows as RowScope, f.assertActive)
        .authorize('assign', actor);
      await commandsOf(authorized).commandTransaction!(async () => {
        assert.fail('Invalid scope reached callback');
      });
    });
    assert.equal(getters, 0);
    assert.equal(writers, 0);
  });
}

test('target/result hooks refuse copied, ordinary and differently authorized record handles', async (t) => {
  const f = await fixture(t);
  const binding = f.bind().withScope(f.rows, f.assertActive);
  const authorized = binding.authorize('assign', actor);
  const other = binding.authorize('assign', actor);
  await commandsOf(authorized).commandTransaction!(async (records) => {
    for (const check of [
      () => authorized.assertTarget!({ ...records }, { id: 1 }),
      () => authorized.assertResult!({ ...records }, { id: 1 }, {}),
      () => other.assertTarget!(records, { id: 1 }),
      () => other.assertResult!(records, { id: 1 }, {}),
    ])
      await assert.rejects(async () => check(), AppAccessDenied);
    await authorized.assertTarget!(records, { id: 1 });
  });
  await f.anchors.get('operations-db')!.transaction!(async (records) => {
    await assert.rejects(async () => authorized.assertTarget!(records, { id: 1 }), AppAccessDenied);
    await assert.rejects(async () => authorized.assertResult!(records, { id: 1 }, {}), AppAccessDenied);
  });
});

for (const mode of ['target', 'result', 'malformed record'] as const) {
  test(`unawaited ${mode} failure still drains and rolls back accepted records and journal`, async (t) => {
    const f = await fixture(t);
    f.resultReferences.assign = () => [{ table: 'people', key: { id: 2 } }];
    const authorized = f.authorize();
    let rejected = false,
      getters = 0;
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async (records, journal) => {
        await earlierWrites(records, journal);
        const pending =
          mode === 'target'
            ? authorized.assertTarget!(records, { id: 2 })
            : mode === 'result'
              ? authorized.assertResult!(records, { id: 1 }, {})
              : records.update({
                  table: 'tickets',
                  key: { id: 1 },
                  values: Object.defineProperty({}, 'name', {
                    enumerable: true,
                    get() {
                      getters++;
                      return 'No';
                    },
                  }),
                });
        // Observe rejection without joining it to the callback's returned promise.
        void pending.catch(() => {
          rejected = true;
        });
        return 'Handler settled before the accepted check';
      }),
      notApplied,
    );
    assert.equal(rejected, true);
    assert.equal(getters, 0);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}

test('extractors receive an immutable detached result captured at check acceptance', async (t) => {
  const f = await fixture(t);
  let captured: unknown;
  f.resultReferences.assign = (result) => {
    captured = result;
    assert.equal(Object.isFrozen(result), true);
    const dto = result as { person: { id: number } };
    assert.equal(Object.isFrozen(dto.person), true);
    assert.throws(() => {
      dto.person.id = 1;
    }, TypeError);
    return [{ table: 'people', key: { id: dto.person.id } }];
  };
  const authorized = f.authorize();
  const result = { person: { id: 2 } };
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records, journal) => {
      await earlierWrites(records, journal);
      const checking = authorized.assertResult!(records, { id: 1 }, result);
      result.person.id = 1;
      await assert.rejects(checking);
    }),
    notApplied,
  );
  assert.notEqual(captured, result);
  assert.equal((captured as { person: { id: number } }).person.id, 2);
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('async rejection and custom thenables refuse without invoking then getters', async (t) => {
  const f = await fixture(t);
  let getters = 0;
  for (const extractor of [
    async () => {
      throw new Error('Async extractor rejected');
    },
    () =>
      // oxlint-disable-next-line unicorn/no-thenable -- hostile extractor output must not execute a then accessor.
      Object.defineProperty({}, 'then', {
        get() {
          getters++;
          throw new Error('Then accessor');
        },
      }),
  ]) {
    f.resultReferences.assign = extractor as unknown as Extractor;
    const authorized = f.authorize();
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async (records, journal) => {
        await earlierWrites(records, journal);
        await assert.rejects(authorized.assertResult!(records, { id: 1 }, {}));
      }),
      notApplied,
    );
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  }
  assert.equal(getters, 0);
});

test('result extractor declaration records reject getters, inherited entries and hidden metadata', async (t) => {
  const f = await fixture(t);
  let getters = 0;
  for (const declarations of [
    Object.create({ assign: () => [] }),
    Object.defineProperty({}, 'assign', {
      enumerable: true,
      get() {
        getters++;
        return () => [];
      },
    }),
    Object.defineProperty({}, 'assign', { value: () => [], enumerable: false }),
    { assign: () => [], [Symbol('hidden')]: () => [] },
  ]) {
    assert.throws(
      () =>
        bindScopedBusinessCommands({
          app: f.app,
          resources: f.resources,
          registry: f.registry,
          writableConnection: (connection) => f.writable.has(connection),
          resultReferences: declarations,
        }),
      BusinessCommandDefinitionError,
    );
  }
  assert.equal(getters, 0);
});

test('target checks require a current visible row and exact strict primary key', async (t) => {
  const f = await fixture(t);
  const authorized = f.authorize();
  for (const key of [
    {},
    { id: 1, desk: 1 },
    { id: 2 },
    { id: 999 },
    { id: NaN },
    { id: Infinity },
    { id: true },
    Object.create({ id: 1 }),
  ]) {
    let caught = false;
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async (records, journal) => {
        await earlierWrites(records, journal);
        await assert.rejects(authorized.assertTarget!(records, key as Key));
        caught = true;
      }),
      notApplied,
    );
    assert.equal(caught, true);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  }
});

for (const shape of [
  'undefined',
  'object',
  'sparse',
  '65 refs',
  'extra property',
  'array property',
  'symbol',
  'key getter',
  'reference getter',
  'inherited key',
  'boolean key',
  'async',
  'throw',
] as const) {
  test(`caught ${shape} result extractor output poisons records and journal`, async (t) => {
    const f = await fixture(t);
    let getters = 0;
    const ref = { table: 'people', key: { id: 1 } };
    const shapes: Record<string, unknown> = {
      undefined,
      object: ref,
      sparse: Array(1),
      '65 refs': Array.from({ length: 65 }, () => ref),
      'extra property': [{ ...ref, ignored: true }],
      'array property': Object.assign([ref], { ignored: true }),
      symbol: [{ ...ref, [Symbol('hidden')]: true }],
      'key getter': [
        {
          table: 'people',
          key: Object.defineProperty({}, 'id', {
            enumerable: true,
            get() {
              getters++;
              return 1;
            },
          }),
        },
      ],
      'reference getter': [
        Object.defineProperty({ key: { id: 1 } }, 'table', {
          enumerable: true,
          get() {
            getters++;
            return 'people';
          },
        }),
      ],
      'inherited key': [{ table: 'people', key: Object.create({ id: 1 }) }],
      'boolean key': [{ table: 'people', key: { id: true } }],
      async: Promise.resolve([ref]),
    };
    f.resultReferences.assign = (() => {
      if (shape === 'throw') throw new Error('Extractor failure');
      return shapes[shape];
    }) as Extractor;
    const authorized = f.authorize();
    let caught = false;
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async (records, journal) => {
        await earlierWrites(records, journal);
        await assert.rejects(authorized.assertResult!(records, { id: 1 }, {}));
        caught = true;
      }),
      notApplied,
    );
    assert.equal(caught, true);
    assert.equal(getters, 0);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}

test('exactly 64 strict references and an explicit empty constants list are accepted', async (t) => {
  const f = await fixture(t);
  for (const refs of [[], Array.from({ length: 64 }, () => ({ table: 'people', key: { id: 1 } }))]) {
    f.resultReferences.assign = () => refs;
    const authorized = f.authorize();
    await commandsOf(authorized).commandTransaction!((records) => authorized.assertResult!(records, { id: 1 }, { constant: true }));
  }
});

test('extractor output is captured before a microtask mutates a hidden dependency into a visible one', async (t) => {
  const f = await fixture(t);
  const refs = [
    { table: 'people', key: { id: 1 } },
    { table: 'people', key: { id: 2 } },
  ];
  f.resultReferences.assign = () => {
    queueMicrotask(() => {
      refs[1].key.id = 1;
      refs.pop();
    });
    return refs;
  };
  const authorized = f.authorize();
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records, journal) => {
      await earlierWrites(records, journal);
      await assert.rejects(authorized.assertResult!(records, { id: 1 }, {}));
    }),
    notApplied,
  );
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('result dependencies use current transaction rows after an earlier change', async (t) => {
  const f = await fixture(t);
  f.resultReferences.assign = () => [{ table: 'tickets', key: { id: 3 } }];
  const authorized = f.authorize();
  await commandsOf(authorized).commandTransaction!(async (records) => {
    await records.insert({ table: 'tickets', values: { id: 3, name: 'New dependency' } });
    await authorized.assertResult!(records, { id: 1 }, {});
  });
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records, journal) => {
      await earlierWrites(records, journal);
      await records.remove({ table: 'tickets', key: { id: 3 } });
      await assert.rejects(authorized.assertResult!(records, { id: 1 }, {}));
    }),
    notApplied,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM raw_ticket WHERE id = 3').get()!.n, 1);
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('secondary result checks cannot borrow a visible same-PK row from the default source', async (t) => {
  const f = await fixture(t, true);
  f.db.exec('UPDATE raw_person SET desk = 2 WHERE id = 1');
  f.resultReferences.assign = () => [{ table: 'people', key: { id: 1 } }];
  const authorized = f.authorize();
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records) => {
      await authorized.assertTarget!(records, { id: 1 });
      await authorized.assertResult!(records, { id: 1 }, {});
    }),
    notApplied,
  );
  assert.equal(f.databases.get('operations')!.prepare('SELECT desk FROM raw_person WHERE id = 1').get()!.desk, 1);
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('an explicit empty dependency list still checks the target current visibility', async (t) => {
  const f = await fixture(t);
  const authorized = f.authorize();
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records, journal) => {
      await earlierWrites(records, journal);
      await assert.rejects(authorized.assertResult!(records, { id: 2 }, { constant: true }));
    }),
    notApplied,
  );
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

test('a permissive parent row rule cannot promote a parent outside the command footprint', async (t) => {
  const f = await fixture(t);
  f.registry.assign = f.definition(['tickets']);
  f.rows.people = true;
  const authorized = f.authorize();
  await assert.rejects(
    commandsOf(authorized).commandTransaction!(async (records, journal) => {
      await journal.commit(receipt, audit);
      await assert.rejects(records.update({ table: 'tickets', key: { id: 1 }, values: { name: 'Bypass' } }));
    }),
    notApplied,
  );
  assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
});

for (const mode of ['catalog drift', 'missing evidence', 'malformed evidence'] as const) {
  test(`${mode} refuses before the application callback without fallback`, async (t) => {
    const f = await fixture(t);
    const anchor = f.anchors.get('operations-db')!;
    const original = commandsOf(anchor).scopeCommandTransaction!.bind(anchor);
    let callbacks = 0,
      fallbacks = 0;
    const fallback = async (): Promise<never> => {
      fallbacks++;
      throw new Error('Fallback');
    };
    anchor.transaction = fallback;
    anchor.commandTransaction = fallback;
    anchor.scopeTransaction = fallback;
    if (mode !== 'catalog drift')
      anchor.scopeCommandTransaction = (rows, run) =>
        original(rows, (records, journal) => run(records, journal, (mode === 'missing evidence' ? undefined : {}) as DatabaseSchema));
    const authorized = f.authorize();
    if (mode === 'catalog drift') f.db.exec('ALTER TABLE raw_ticket ADD COLUMN private_note TEXT');
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async () => {
        callbacks++;
      }),
      notApplied,
    );
    assert.equal(callbacks, 0);
    assert.equal(fallbacks, 0);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}

for (const rollback of [false, true]) {
  test(`records, journal and check hooks expire after ${rollback ? 'rollback' : 'commit'}`, async (t) => {
    const f = await fixture(t);
    const authorized = f.authorize();
    let records!: WriteTransaction, journal!: CommandJournal;
    const pending = commandsOf(authorized).commandTransaction!(async (tx, runtimeJournal) => {
      records = tx;
      journal = runtimeJournal;
      await earlierWrites(records, journal);
      if (rollback) throw new Error('Rollback');
    });
    if (rollback) await assert.rejects(pending, notApplied);
    else await pending;
    const before = f.state();
    for (const late of [
      () => records.query(query('tickets')),
      () => records.count('tickets'),
      () => records.insert({ table: 'tickets', values: { id: 3 } }),
      () => records.update({ table: 'tickets', key: { id: 1 }, values: { name: 'Late' } }),
      () => records.remove({ table: 'tickets', key: { id: 1 } }),
      () => journal.find(receipt),
      () => journal.commit({ ...receipt, id: 'late', idempotencyKey: 'late' }, audit),
      () => authorized.assertTarget!(records, { id: 1 }),
      () => authorized.assertResult!(records, { id: 1 }, {}),
    ])
      await assert.rejects(async () => late());
    assert.deepEqual(f.state(), before);
  });
}

for (const mode of ['caught lifetime', 'precommit lifetime', 'precommit writable'] as const) {
  test(`${mode} failure rolls back both records and an already accepted journal commit`, async (t) => {
    const f = await fixture(t);
    const authorized = f.authorize();
    await assert.rejects(
      commandsOf(authorized).commandTransaction!(async (records, journal) => {
        await earlierWrites(records, journal);
        if (mode === 'precommit writable') f.writable.delete('operations-db');
        else f.retire();
        if (mode === 'caught lifetime') await assert.rejects(records.count('tickets'), AppAccessDenied);
        return 'Callback attempted to commit';
      }),
      notApplied,
    );
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}

for (const revocation of ['lifetime', 'writable'] as const) {
  test(`${revocation} revocation during acquisition prevents the callback`, async (t) => {
    const f = await fixture(t);
    const anchor: Adapter = f.anchors.get('operations-db')!;
    const original = commandsOf(anchor).scopeCommandTransaction!.bind(anchor);
    const wait = gate();
    anchor.scopeCommandTransaction = async (rows, run) => {
      await wait.promise;
      return original(rows, run);
    };
    const authorized = f.authorize();
    let callbacks = 0;
    const pending = commandsOf(authorized).commandTransaction!(async () => {
      callbacks++;
    });
    if (revocation === 'lifetime') f.retire();
    else f.writable.delete('operations-db');
    wait.release();
    await assert.rejects(pending, notApplied);
    assert.equal(callbacks, 0);
    assert.deepEqual(f.state(), { name: 'Original', receipt: 0, audit: 0 });
  });
}
