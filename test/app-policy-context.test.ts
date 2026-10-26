import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  TransactionOutcomeUnknown,
  type Adapter,
  type Filter,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppPolicyContext, type AppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { PathError, type ViewDef } from '../packages/engine/src/shared/view.js';

interface Request {
  cookie?: string;
  body?: unknown;
}
type Options = Parameters<typeof createAppPolicyContext<Request>>[0];
const owners = { operations: 'policy-ops-registry', inventory: 'policy-stock-registry' };
type Source = keyof typeof owners;
const aliases = { note: 'physical_note', person: 'physical_person', ticket: 'physical_ticket', blocked: 'physical_blocked' };
const equal = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const query = (table = 'note', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const view = (base = 'note'): ViewDef => ({ id: 'policy', name: 'Policy', base, columns: [{ path: 'body' }] });
const breakdown = (base = 'note'): BreakdownDef => ({ base, by: [{ path: 'tenant' }], measures: [{ fn: 'count' }] });
const denied = (run: () => unknown) => assert.rejects(async () => run(), Refusal);
const signedIn: Request = { cookie: 'editor-session' };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function deeplyFrozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) deeplyFrozen(child);
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-context-'));
  const physical = new Map<Source, SqliteAdapter>();
  const databases = new Map<Source, DatabaseSync>();
  t.after(async () => {
    try {
      await Promise.all([...physical.values()].map((adapter) => adapter.close()));
    } finally {
      for (const db of databases.values()) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of Object.keys(owners) as Source[]) {
    const tenant = source === 'operations' ? 1 : 2;
    const file = join(directory, `${source}.db`);
    const db = new DatabaseSync(file);
    databases.set(source, db);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE physical_person (id INTEGER PRIMARY KEY, name TEXT,
        tenant INTEGER NOT NULL DEFAULT ${tenant}, secret TEXT DEFAULT 'private');
      CREATE INDEX private_index ON physical_person(secret);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, title TEXT,
        tenant INTEGER NOT NULL DEFAULT ${tenant}, owner_id INTEGER DEFAULT ${tenant} REFERENCES physical_person(id),
        secret TEXT DEFAULT 'private ticket');
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT, tenant INTEGER NOT NULL DEFAULT ${tenant});
      CREATE TABLE physical_blocked (id INTEGER PRIMARY KEY, body TEXT, tenant INTEGER NOT NULL DEFAULT ${tenant});
      INSERT INTO physical_person VALUES (1, '${source} one', 1, 'secret one'), (2, '${source} two', 2, 'secret two');
      INSERT INTO physical_ticket VALUES (1, 'First', 1, 1, 'secret first'), (2, 'Second', 2, 2, 'secret second'),
        (3, 'Hidden parent', ${tenant}, ${tenant === 1 ? 2 : 1}, 'secret third');
      INSERT INTO physical_note VALUES (1, '${source} one', 1), (2, '${source} two', 2);
      INSERT INTO physical_blocked VALUES (1, 'Resource denied', ${tenant});
    `);
    const adapter = new SqliteAdapter(file, source);
    physical.set(source, adapter);
    sources[source] = { adapter, schema: await adapter.introspect(), resources: { ...aliases }, writable: true };
  }
  const runtime = createAppSourceAdapter(sources, 'operations');
  const sourceFor = (owner: string): Source => {
    const source = (Object.keys(owners) as Source[]).find((source) => owners[source] === owner);
    if (!source) throw new Refusal('Wrong owner');
    return source;
  };
  // Stable public adapter objects let the capture tests replace their methods
  // after issuer creation without replacing any real SQLite implementation.
  const anchored = new Map(Object.keys(owners).map((source) => [owners[source as Source], runtime.forSource(source)]));
  const resources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: Object.values(owners),
    connectionFor: (name) => owners[runtime.resolve(name).source as Source],
    toPhysical: (name) => runtime.resolve(name).physicalTable,
    toLogical: (name) => runtime.catalogs.get('operations')!.toLogical(name),
    toLogicalAt: (name, owner) => {
      const source = sourceFor(owner);
      return (source === 'operations' ? '' : `${source}.`) + runtime.catalogs.get(source)!.toLogical(name);
    },
    forConnection: (owner) => {
      sourceFor(owner);
      return anchored.get(owner)!;
    },
  };
  const readable = resources.schema.tables.map((table) => table.id).filter((id) => !id.endsWith('blocked'));
  const writable = readable.filter((id) => !id.endsWith('person'));
  // One block per catalog table, in catalog order, except the blocked one: a
  // resource reads by default, so a table no one may reach is a table the App
  // does not declare.
  const blocks = Object.fromEntries(
    resources.schema.tables
      .filter(({ id }) => readable.includes(id))
      .map(({ id }) => [
        id,
        {
          physical: aliases[id.slice(id.indexOf('.') + 1) as keyof typeof aliases],
          ...(writable.includes(id) ? { access: 'write' } : {}),
          ...(readable.includes(id) && !id.endsWith('note')
            ? {
                fields: id.endsWith('person')
                  ? { read: ['id', 'name'] }
                  : { read: ['id', 'title', 'owner_id'], write: ['title', 'owner_id'] },
              }
            : {}),
        },
      ]),
  );
  const app = parseAppConfig(
    {
      id: 'policy-app',
      name: 'Policy fixture',
      sources: Object.fromEntries(
        Object.entries(owners).map(([source, owner]) => [
          source,
          { connection: owner, ...(source === 'operations' ? { default: true } : {}) },
        ]),
      ),
      resources: blocks,
      auth: {
        roles: {
          editor: { read: true, write: true },
          reader: { read: true },
          orphan: { read: ['note', 'ticket'], write: ['note', 'ticket'] },
          none: {},
        },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'policy-context fixture',
  );
  const rows: Record<string, RowScope[string]> = Object.fromEntries(
    resources.schema.tables.map((table) => [table.id, equal('tenant', table.id.startsWith('inventory.') ? 2 : 1)]),
  );
  const identities = new Map<string, Identity>([
    ['editor-session', { id: 'editor-id', who: 'editor@example.test', role: 'editor' }],
    ['reader-session', { id: 'reader-id', who: 'reader@example.test', role: 'reader' }],
    ['orphan-session', { id: 'orphan-id', who: 'orphan@example.test', role: 'orphan' }],
    ['unknown-session', { id: 'unknown-id', who: 'unknown@example.test', role: 'admin' }],
  ]);
  const sourceConnections = new Map(Object.entries(owners));
  const options: Options = {
    app,
    resources,
    sourceConnections,
    verifySession: async (request) => identities.get(request.cookie ?? '') ?? null,
    resolveRows: () => rows,
  };
  const issue = (extra: Partial<Options> = {}) => createAppPolicyContext<Request>({ ...options, ...extra });
  const notes = (source: Source = 'operations') => databases.get(source)!.prepare('SELECT * FROM physical_note ORDER BY id').all();
  const tickets = () => databases.get('operations')!.prepare('SELECT * FROM physical_ticket ORDER BY id').all();
  return { app, resources, rows, physical, databases, anchored, identities, sourceConnections, options, issue, notes, tickets };
}

test('verified context exposes only frozen logical metadata and scoped capabilities', async (t) => {
  const { issue } = await fixture(t);
  const issuer = issue();
  assert.ok(Object.isFrozen(issuer));
  assert.deepEqual(Reflect.ownKeys(issuer).sort(), ['retire', 'withAccount', 'withContext', 'withPublicContext', 'withService']);
  await issuer.withContext(signedIn, async (context) => {
    assert.deepEqual(Reflect.ownKeys(context).sort(), [
      'data',
      'principal',
      'readsAt',
      'schema',
      'sources',
      'transaction',
      'trial',
      'writeFields',
    ]);
    deeplyFrozen(context);
    assert.deepEqual(context.principal, { id: 'editor-id', appId: 'policy-app', roles: ['editor'], email: 'editor@example.test' });
    assert.deepEqual([...context.sources].sort(), ['inventory', 'operations']);
    assert.deepEqual(Reflect.ownKeys(context.data).sort(), [
      'count',
      'countBreakdown',
      'countView',
      'insert',
      'query',
      'remove',
      'runBreakdown',
      'runView',
      'update',
    ]);
    assert.ok(!context.schema.tables.some((table) => table.id.endsWith('blocked')));
    const person = context.schema.tables.find((table) => table.id === 'person')!;
    assert.deepEqual(
      person.columns.map((column) => column.name),
      ['id', 'name'],
    );
    assert.ok(!person.indexed?.includes('secret'));
    assert.ok(context.schema.tables.every((table) => !Object.hasOwn(table, 'approxRows')));
    /* The principal says who acted in the verified session's words (a command's
       `actor.email`); the catalog and the sources never carry the account. */
    const metadata = JSON.stringify({ sources: context.sources, schema: context.schema });
    for (const privateName of [...Object.values(owners), 'editor@example.test']) {
      assert.ok(!metadata.includes(privateName), `Metadata must not disclose ${privateName}`);
    }
    const principal = JSON.stringify(context.principal);
    for (const physical of Object.values(owners)) assert.ok(!principal.includes(physical), `Principal must not disclose ${physical}`);
    // FK names are deployed metadata; resource addresses must remain logical.
    const resourceIds = new Set(context.schema.tables.map((table) => table.id));
    assert.ok(context.schema.tables.every((table) => table.name === table.id && !table.id.includes('physical_')));
    assert.ok(context.schema.foreignKeys.every((fk) => resourceIds.has(fk.from.table) && resourceIds.has(fk.to.table)));
    await context.transaction('operations', async (tx) => {
      assert.deepEqual(Reflect.ownKeys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
      assert.ok(Object.isFrozen(tx));
      assert.equal(await tx.count('note'), 1);
    });
  });
});

test('complete valid path reads both aliases and commits source-local CRUD with read-your-writes', async (t) => {
  const { issue, notes } = await fixture(t);
  const result = await issue().withContext(signedIn, async (context) => {
    const { query: read, count, runView, countView, runBreakdown, countBreakdown, insert, update, remove } = context.data;
    assert.deepEqual((await read(query())).rows, [{ id: 1, body: 'operations one', tenant: 1 }]);
    assert.deepEqual((await read(query('inventory.note'))).rows, [{ id: 2, body: 'inventory two', tenant: 2 }]);
    assert.equal(await count('note'), 1);
    assert.equal((await runView(view())).rows.length, 1);
    assert.equal(await countView(view()), 1);
    assert.equal((await runBreakdown(breakdown())).rows.length, 1);
    assert.equal(await countBreakdown(breakdown()), 1);
    await insert!({ table: 'note', values: { id: 10, body: 'Created' } });
    await update!({ table: 'note', key: { id: 10 }, values: { body: 'Updated' }, expected: { body: 'Created' } });
    await remove!({ table: 'note', key: { id: 10 } });
    const { transaction } = context;
    return transaction('inventory', async (tx) => {
      const { insert, query: read, count, update, remove } = tx;
      await insert({ table: 'inventory.note', values: { id: 11, body: 'New' } });
      assert.equal(await count('inventory.note'), 2);
      assert.equal(notes('inventory').length, 2, 'A separate connection cannot see uncommitted writes');
      await update({ table: 'inventory.note', key: { id: 11 }, values: { body: 'Changed' } });
      assert.deepEqual((await read(query('inventory.note', { columns: ['body'], filter: equal('id', 11) }))).rows, [{ body: 'Changed' }]);
      await remove({ table: 'inventory.note', key: { id: 11 } });
      await insert({ table: 'inventory.note', values: { id: 12, body: 'Committed' } });
      return 'callback result';
    });
  });
  assert.equal(result, 'callback result');
  assert.equal(notes().length, 2);
  assert.equal(notes('inventory').find((row) => row.id === 12)?.body, 'Committed');
});

/* An App API read of a several-source App reads one connection (apiSourceLanes.ts):
   the lane is that connection's anchored facade, under the principal's rows there. */
test('readsAt reads one source’s connection alone, under its rows there, and binds no other', async (t) => {
  const { issue, physical } = await fixture(t);
  const binds: Record<Source, number> = { operations: 0, inventory: 0 };
  for (const [source, adapter] of physical) {
    const scopeReads = adapter.scopeReads.bind(adapter);
    adapter.scopeReads = (async (rows) => {
      binds[source]++;
      return scopeReads(rows);
    }) as typeof adapter.scopeReads;
  }
  const issuer = issue();
  const bodies = (rows: readonly Record<string, unknown>[]) => rows.map((row) => row.body);
  await issuer.withContext(signedIn, async (context) => {
    const inventory = context.readsAt('inventory');
    assert.ok(Object.isFrozen(inventory));
    // The second source narrowed by its own rule (tenant 2), as the composite reader narrows it.
    assert.deepEqual(bodies((await inventory.runView(view('inventory.note'))).rows), ['inventory two']);
    assert.equal(await inventory.countView(view('inventory.note')), 1);
    assert.deepEqual(bodies((await context.data.runView(view('inventory.note'))).rows), ['inventory two']);
    assert.deepEqual(bodies((await context.readsAt('operations').runView(view())).rows), ['operations one']);
    assert.throws(() => context.readsAt('elsewhere'), Refusal);
  });
  // The lane bound its own connection's reader and no other; the composite reader binds both.
  assert.deepEqual(binds, { operations: 2, inventory: 2 });
  binds.operations = binds.inventory = 0;
  await issuer.withContext(signedIn, async (context) => {
    await context.readsAt('inventory').runView(view('inventory.note'));
  });
  assert.deepEqual(binds, { operations: 0, inventory: 1 });
  // A resource on another connection is refused on the lane, never read there; the refusal fails the invocation.
  await assert.rejects(
    issuer.withContext(signedIn, (context) => context.readsAt('operations').runView(view('inventory.note'))),
    /on another connection/,
  );
  assert.equal(binds.inventory, 1);
});

test('forged request identity, App, roles and scopes cannot override the cookie verifier', async (t) => {
  const { issue } = await fixture(t);
  const issuer = issue();
  const body = {
    id: 'editor-id',
    appId: 'other-app',
    roles: ['editor'],
    role: 'editor',
    email: 'editor@example.test',
    name: 'Forged Name',
    who: 'editor@example.test',
    rows: { note: true },
    scope: { note: true },
    source: owners.inventory,
    context: { principal: { roles: ['editor'] } },
  };
  await assert.rejects(() => issuer.withContext({ body }, async () => assert.fail('Unsigned callback')));
  await denied(() =>
    issuer.withContext({ cookie: 'reader-session', body }, async (context) => {
      assert.deepEqual(context.principal, { id: 'reader-id', appId: 'policy-app', roles: ['reader'], email: 'reader@example.test' });
      assert.equal(await context.data.count('note'), 1);
      assert.equal(context.data.insert, undefined);
      assert.equal(context.data.update, undefined);
      assert.equal(context.data.remove, undefined);
      await denied(() => context.transaction('operations', (tx) => tx.count('note')));
    }),
  );
  await denied(() =>
    issuer.withContext({ cookie: 'unknown-session', body }, async (context) => {
      assert.deepEqual(context.schema.tables, []);
      await denied(() => context.data.query(query()));
    }),
  );
});

test('each invocation verifies the current session and resolves independent row grants', async (t) => {
  const { issue, identities, rows } = await fixture(t);
  let verifications = 0;
  const issuer = issue({
    verifySession: async (request) => {
      verifications++;
      return identities.get(request.cookie ?? '') ?? null;
    },
    resolveRows: (principal) => ({ ...rows, note: equal('tenant', principal.id === 'editor-id' ? 1 : 2) }),
  });
  await Promise.all([
    issuer.withContext(signedIn, async (context) => {
      assert.deepEqual(
        (await context.data.query(query())).rows.map((row) => row.id),
        [1],
      );
    }),
    issuer.withContext({ cookie: 'reader-session' }, async (context) => {
      assert.deepEqual(
        (await context.data.query(query())).rows.map((row) => row.id),
        [2],
      );
      assert.equal(context.data.update, undefined);
    }),
  ]);
  identities.delete('editor-session');
  await assert.rejects(() => issuer.withContext(signedIn, async () => assert.fail('Deleted session')));
  assert.equal(verifications, 3);
});

for (const mode of ['direct', 'transaction'] as const) {
  const invoke = (context: AppPolicyContext, run: (tx: WriteTransaction) => Promise<unknown>) =>
    mode === 'direct' ? run(context.data as WriteTransaction) : context.transaction('operations', run);
  for (const [name, run] of [
    ['resource', (tx: WriteTransaction) => tx.insert({ table: 'blocked', values: { id: 9, body: 'Denied' } })],
    ['read-only resource', (tx: WriteTransaction) => tx.update({ table: 'person', key: { id: 1 }, values: { name: 'Denied' } })],
    ['hidden field', (tx: WriteTransaction) => tx.update({ table: 'ticket', key: { id: 1 }, values: { secret: 'Denied' } })],
    [
      'hidden expected field',
      (tx: WriteTransaction) =>
        tx.update({ table: 'ticket', key: { id: 1 }, values: { title: 'Denied' }, expected: { secret: 'secret first' } }),
    ],
    ['hidden row update', (tx: WriteTransaction) => tx.update({ table: 'note', key: { id: 2 }, values: { body: 'Denied' } })],
    ['hidden row delete', (tx: WriteTransaction) => tx.remove({ table: 'note', key: { id: 2 } })],
    ['out-of-scope insert', (tx: WriteTransaction) => tx.insert({ table: 'note', values: { id: 9, body: 'Denied', tenant: 2 } })],
    ['out-of-scope stored update', (tx: WriteTransaction) => tx.update({ table: 'note', key: { id: 1 }, values: { tenant: 2 } })],
    ['hidden parent reassignment', (tx: WriteTransaction) => tx.update({ table: 'ticket', key: { id: 1 }, values: { owner_id: 2 } })],
    ['incomplete delete fields', (tx: WriteTransaction) => tx.remove({ table: 'ticket', key: { id: 1 } })],
  ] as const) {
    test(`${mode}: verified context enforces ${name} denial on real SQLite`, async (t) => {
      const { issue, notes, tickets } = await fixture(t);
      const before = { notes: notes(), tickets: tickets() };
      await denied(() =>
        issue().withContext(signedIn, async (context) => {
          await denied(() => invoke(context, run));
        }),
      );
      assert.deepEqual({ notes: notes(), tickets: tickets() }, before);
    });
  }
}

test('an unrelated edit keeps its existing hidden-parent link', async (t) => {
  const { issue, tickets } = await fixture(t);
  await issue().withContext(signedIn, async (context) => {
    await context.data.update!({ table: 'ticket', key: { id: 3 }, values: { title: 'Updated title' } });
  });
  assert.equal(tickets().find((row) => row.id === 3)?.title, 'Updated title');
});

test('resource-denied parents stay denied even with explicitly unrestricted parent rows', async (t) => {
  const { issue, rows, tickets } = await fixture(t);
  const before = tickets();
  await denied(() =>
    issue({ resolveRows: () => ({ ...rows, person: true }) }).withContext({ cookie: 'orphan-session' }, async (context) => {
      assert.ok(!context.schema.tables.some((table) => table.id === 'person'));
      assert.ok(!context.schema.foreignKeys.some((fk) => fk.to.table === 'person'));
      await denied(() => context.data.update!({ table: 'ticket', key: { id: 1 }, values: { owner_id: 1 } }));
      await denied(() => context.transaction('operations', (tx) => tx.insert({ table: 'ticket', values: { title: 'Denied' } })));
    }),
  );
  assert.deepEqual(tickets(), before);
});

test('read projections, filters, views and aggregates cannot address hidden fields or resources', async (t) => {
  const { issue } = await fixture(t);
  await denied(() =>
    issue().withContext(signedIn, async (context) => {
      assert.deepEqual((await context.data.query(query('person'))).rows, [{ id: 1, name: 'operations one' }]);
      for (const read of [
        () => context.data.query(query('blocked')),
        () => context.data.query(query('person', { columns: ['secret'] })),
        () => context.data.count('person', equal('secret', 'secret one')),
        () => context.data.runView({ ...view('person'), columns: [{ path: 'secret' }] }),
        () =>
          context.data.countView({
            ...view('person'),
            columns: [{ path: 'id' }],
            filter: { groups: [[{ path: 'secret', op: '=', value: 'secret one' }]] },
          }),
        () => context.data.runBreakdown({ ...breakdown('person'), by: [{ path: 'secret' }] }),
        () => context.data.countBreakdown({ ...breakdown('person'), by: [{ path: 'secret' }] }),
      ])
        await assert.rejects(
          async () => read(),
          (error) => error instanceof Refusal || error instanceof PathError,
        );
    }),
  );
});

for (const source of [owners.operations, owners.inventory, '', 'other-app', 'operations.note', 'constructor']) {
  test(`transaction rejects forged source ${JSON.stringify(source)} before callback`, async (t) => {
    const { issue } = await fixture(t);
    await denied(() =>
      issue().withContext(signedIn, async (context) => {
        await denied(() => context.transaction(source, async () => assert.fail('Forged source callback')));
      }),
    );
  });
}

test('an inventory transaction remains anchored across bare names, physical aliases and caught source refusals', async (t) => {
  const { issue, notes } = await fixture(t);
  const before = notes('inventory');
  await denied(() =>
    issue().withContext(signedIn, async (context) => {
      for (const table of ['note', 'operations.note', 'physical_note', `${owners.inventory}.note`]) {
        await denied(() =>
          context.transaction('inventory', async (tx) => {
            await tx.update({ table: 'inventory.note', key: { id: 2 }, values: { body: 'Rolled back' } });
            await denied(() => tx.query(query(table)));
          }),
        );
        assert.deepEqual(notes('inventory'), before);
      }
      for (const table of ['physical_note', 'operations.note', `${owners.operations}.note`]) {
        await denied(() => context.data.query(query(table)));
      }
    }),
  );
});

for (const [name, rows] of [
  ['undefined', undefined],
  ['null', null],
  ['array', []],
  ['boolean', true],
  ['undefined rule', { note: undefined }],
  ['empty filter', { note: { groups: [] } }],
  ['unknown resource', { note: true, absent: true }],
  ['physical resource', { physical_note: true }],
  ['unknown field', { note: equal('absent', 1) }],
  ['inherited rules', Object.create({ note: true })],
] as const) {
  test(`invalid resolver result (${name}) denies without invoking application code`, async (t) => {
    const { issue } = await fixture(t);
    const issuer = issue({ resolveRows: () => rows as RowScope });
    await denied(() => issuer.withContext(signedIn, async () => assert.fail('Malformed scope callback')));
  });
}

test('omitted row keys deny reads and writes while an explicit true rule allows all rows', async (t) => {
  const { issue, notes } = await fixture(t);
  const before = notes();
  await denied(() =>
    issue({ resolveRows: () => ({ 'inventory.note': true }) }).withContext(signedIn, async (context) => {
      assert.equal(await context.data.count('note'), 0);
      assert.equal(await context.data.count('inventory.note'), 2);
      await denied(() => context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Denied' } }));
    }),
  );
  assert.deepEqual(notes(), before);
});

test('resolver errors propagate without an unscoped callback fallback', async (t) => {
  const { issue } = await fixture(t);
  const failure = new Error('Policy service unavailable');
  await assert.rejects(
    () =>
      issue({
        resolveRows: async () => {
          throw failure;
        },
      }).withContext(signedIn, async () => assert.fail('Resolver failed')),
    (error) => error === failure,
  );
});

test('asynchronously missing row policy denies rather than selecting the unscoped fallback', async (t) => {
  const { issue } = await fixture(t);
  const issuer = issue({ resolveRows: async () => undefined as unknown as RowScope });
  await denied(() => issuer.withContext(signedIn, async () => assert.fail('Missing async scope callback')));
});

for (const mutation of ['replace rule', 'widen nested values', 'add missing rule'] as const) {
  for (const operation of ['read', 'write'] as const) {
    test(`synchronous resolver snapshots before a microtask can ${mutation}: ${operation}`, async (t) => {
      const { issue, rows, notes } = await fixture(t);
      const widened = gate();
      const allowedTenants = [1];
      if (mutation === 'widen nested values') {
        rows.note = { groups: [[{ column: 'tenant', op: 'in', value: allowedTenants }]] };
      } else if (mutation === 'add missing rule') delete rows.note;
      const before = notes();
      const issuer = issue({
        resolveRows: () => {
          queueMicrotask(() => {
            if (mutation === 'widen nested values') allowedTenants.push(2);
            else rows.note = true;
            widened.release();
          });
          return rows;
        },
      });
      if (operation === 'read') {
        const ids = await issuer.withContext(signedIn, async (context) => {
          await widened.promise;
          return (await context.data.query(query())).rows.map((row) => row.id);
        });
        assert.deepEqual(
          ids,
          mutation === 'add missing rule' ? [] : [1],
          'The scope belongs to the synchronous return, before its queued mutation',
        );
      } else {
        await denied(() =>
          issuer.withContext(signedIn, async (context) => {
            await widened.promise;
            await context.data.update!({
              table: 'note',
              key: { id: mutation === 'add missing rule' ? 1 : 2 },
              values: { body: 'Microtask must not grant this write' },
            });
          }),
        );
        assert.deepEqual(notes(), before);
      }
    });
  }
}

test('identity is snapshotted before awaiting row resolution', async (t) => {
  const { issue, identities, rows } = await fixture(t);
  const entered = gate();
  const held = gate();
  const issuer = issue({
    resolveRows: async (principal) => {
      deeplyFrozen(principal);
      entered.release();
      await held.promise;
      assert.deepEqual(principal, { id: 'reader-id', appId: 'policy-app', roles: ['reader'], email: 'reader@example.test' });
      return rows;
    },
  });
  const pending = issuer.withContext({ cookie: 'reader-session' }, async (context) => {
    assert.deepEqual(context.principal, { id: 'reader-id', appId: 'policy-app', roles: ['reader'], email: 'reader@example.test' });
    assert.equal(context.data.update, undefined);
    assert.equal(await context.data.count('note'), 1);
  });
  try {
    await entered.promise;
    Object.assign(identities.get('reader-session')!, { id: 'editor-id', who: 'editor@example.test', name: 'Editor', role: 'editor' });
  } finally {
    held.release();
  }
  await pending;
});

test('deployed App, source owners and trusted callbacks are captured at issuer creation', async (t) => {
  const { options, app, resources, sourceConnections, notes } = await fixture(t);
  const originalId = app.id;
  const issuer = createAppPolicyContext<Request>(options);
  app.id = 'replacement-app';
  app.sources!.operations.default = false;
  app.sources!.operations.connection = owners.inventory;
  app.resources = { ...app.resources, note: { ...app.resources!.note, physical: 'physical_blocked' } };
  app.auth!.roles!.editor.write = false;
  app.resources!.person.fields!.read.push('secret');
  resources.connections.reverse();
  sourceConnections.set('operations', owners.inventory);
  sourceConnections.set('forged', owners.operations);
  resources.connectionFor = () => owners.inventory;
  resources.forConnection = () => {
    throw new Error('Replacement source binder');
  };
  options.verifySession = async () => null;
  options.resolveRows = () => ({ note: true });
  await issuer.withContext(signedIn, async (context) => {
    assert.equal(context.principal.appId, originalId);
    assert.deepEqual([...context.sources].sort(), ['inventory', 'operations']);
    assert.deepEqual(
      context.schema.tables.find((table) => table.id === 'person')!.columns.map((column) => column.name),
      ['id', 'name'],
    );
    assert.equal(await context.data.count('note'), 1);
    await context.transaction('operations', (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Captured owner' } }));
  });
  assert.equal(notes().find((row) => row.id === 1)?.body, 'Captured owner');
  assert.equal(notes('inventory').find((row) => row.id === 1)?.body, 'inventory one');
});

test('mutating the input catalog after issuer creation cannot change later scoped reads or writes', async (t) => {
  const { issue, resources, notes } = await fixture(t);
  const issuer = issue();
  resources.schema.tables.find((table) => table.id === 'person')!.columns.length = 0;
  await issuer.withContext(signedIn, async (context) => {
    assert.deepEqual(
      context.schema.tables.find((table) => table.id === 'person')!.columns.map((column) => column.name),
      ['id', 'name'],
    );
    assert.deepEqual((await context.data.query(query('person'))).rows, [{ id: 1, name: 'operations one' }]);
    await context.transaction('operations', (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Captured catalog' } }));
  });
  assert.equal(notes().find((row) => row.id === 1)?.body, 'Captured catalog');
});

test('adapter capability methods are captured before later request resolution', async (t) => {
  const { issue, resources, anchored, notes } = await fixture(t);
  const issuer = issue();
  let replacement = 0;
  const replaced = () => {
    replacement++;
    throw new Error('Replacement capability');
  };
  for (const adapter of [resources.adapter, ...anchored.values()]) {
    adapter.scopeReads = replaced;
    adapter.scopeTransaction = replaced;
    adapter.query = replaced;
    adapter.update = replaced;
    adapter.transaction = replaced;
  }
  await issuer.withContext(signedIn, async (context) => {
    assert.equal(await context.data.count('note'), 1);
    await context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Captured direct writer' } });
    await context.transaction('inventory', (tx) =>
      tx.update({ table: 'inventory.note', key: { id: 2 }, values: { body: 'Captured transaction' } }),
    );
  });
  assert.equal(replacement, 0);
  assert.equal(notes().find((row) => row.id === 1)?.body, 'Captured direct writer');
});

test('resolved row grants and operation arguments cannot widen while writer acquisition waits', async (t) => {
  const { issue, resources, rows, notes } = await fixture(t);
  const entered = gate();
  const held = gate();
  const anchor = resources.forConnection(owners.operations);
  const original = anchor.scopeTransaction!.bind(anchor);
  anchor.scopeTransaction = async (scope, run) => {
    entered.release();
    await held.promise;
    return original(scope, run);
  };
  const issuer = issue();
  const request: UpdateRequest = { table: 'note', key: { id: 1 }, values: { body: 'Captured request' } };
  const pending = issuer.withContext(signedIn, async (context) => {
    const write = context.data.update!(request);
    await entered.promise;
    request.table = 'inventory.note';
    request.key.id = 2;
    request.values.body = 'Mutated request';
    (rows.note as Filter).groups[0][0].value = 2;
    rows['inventory.note'] = true;
    held.release();
    await write;
    assert.deepEqual(
      (await context.data.query(query())).rows.map((row) => row.id),
      [1],
    );
    assert.equal(await context.data.count('inventory.note'), 1);
  });
  try {
    await pending;
  } finally {
    held.release();
  }
  assert.equal(notes().find((row) => row.id === 1)?.body, 'Captured request');
  assert.equal(notes('inventory').find((row) => row.id === 2)?.body, 'inventory two');
});

for (const stage of ['session', 'rows'] as const) {
  test(`retirement during ${stage} resolution refuses before application callback`, async (t) => {
    const { issue, identities, rows } = await fixture(t);
    const entered = gate();
    const held = gate();
    let resolutions = 0;
    const issuer = issue({
      verifySession: async () => {
        if (stage === 'session') {
          entered.release();
          await held.promise;
        }
        return identities.get('editor-session')!;
      },
      resolveRows: async () => {
        resolutions++;
        if (stage === 'rows') {
          entered.release();
          await held.promise;
        }
        return rows;
      },
    });
    const pending = denied(() => issuer.withContext(signedIn, async () => assert.fail('Retired callback')));
    try {
      await entered.promise;
      issuer.retire();
      issuer.retire();
    } finally {
      held.release();
    }
    await pending;
    if (stage === 'session') assert.equal(resolutions, 0);
    await denied(() => issuer.withContext(signedIn, async () => assert.fail('Retired issuer reused')));
  });
}

for (const mode of ['direct', 'transaction'] as const) {
  test(`retirement during real SQLite queue acquisition refuses ${mode} writes`, async (t) => {
    const { issue, physical, resources, notes } = await fixture(t);
    const entered = gate();
    const held = gate();
    const queued = gate();
    const anchor = resources.forConnection(owners.operations);
    const original = anchor.scopeTransaction!.bind(anchor);
    anchor.scopeTransaction = (scope, run) => {
      queued.release();
      return original(scope, run);
    };
    const issuer = issue();
    const holder = physical.get('operations')!.transaction(async () => {
      entered.release();
      await held.promise;
    });
    await entered.promise;
    let callback = false;
    const pending = denied(() =>
      issuer.withContext(signedIn, (context) =>
        mode === 'direct'
          ? context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Denied' } })
          : context.transaction('operations', async (tx) => {
              callback = true;
              return tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Denied' } });
            }),
      ),
    );
    try {
      await queued.promise;
      issuer.retire();
    } finally {
      held.release();
    }
    await Promise.all([holder, pending]);
    assert.equal(callback, false);
    assert.equal(notes().find((row) => row.id === 1)?.body, 'operations one');
  });
}

test('caught retirement refusal inside a context transaction rolls back earlier writes', async (t) => {
  const { issue, notes } = await fixture(t);
  const issuer = issue();
  await denied(() =>
    issuer.withContext(signedIn, (context) =>
      context.transaction('operations', async (tx) => {
        await tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Rolled back' } });
        issuer.retire();
        await denied(() => tx.count('note'));
      }),
    ),
  );
  assert.equal(notes().find((row) => row.id === 1)?.body, 'operations one');
});

for (const failure of [false, true]) {
  test(`retained context and transaction methods expire after callback ${failure ? 'rejection' : 'resolution'}`, async (t) => {
    const { issue, notes } = await fixture(t);
    const issuer = issue();
    let retained!: AppPolicyContext;
    let writer!: WriteTransaction;
    const error = new Error('Callback failed');
    const pending = issuer.withContext(signedIn, async (context) => {
      retained = context;
      await context.transaction('operations', async (tx) => {
        writer = tx;
      });
      if (failure) throw error;
    });
    if (failure)
      await assert.rejects(
        () => pending,
        (cause) => cause === error,
      );
    else await pending;
    const { query: read, count, runView, countView, runBreakdown, countBreakdown, insert, update, remove } = retained.data;
    for (const operation of [
      () => read(query()),
      () => count('note'),
      () => runView(view()),
      () => countView(view()),
      () => runBreakdown(breakdown()),
      () => countBreakdown(breakdown()),
      () => insert!({ table: 'note', values: { body: 'Expired' } }),
      () => update!({ table: 'note', key: { id: 1 }, values: { body: 'Expired' } }),
      () => remove!({ table: 'note', key: { id: 1 } }),
      () => retained.transaction('operations', async () => assert.fail('Expired context transaction')),
      () => writer.count('note'),
      () => writer.update({ table: 'note', key: { id: 1 }, values: { body: 'Expired' } }),
    ])
      await denied(operation);
    assert.equal(notes().find((row) => row.id === 1)?.body, 'operations one');
    await issuer.withContext(signedIn, async (context) => {
      assert.equal(await context.data.count('note'), 1);
    });
  });
}

test('reads recheck retirement after a real database result becomes available', async (t) => {
  const { issue, resources } = await fixture(t);
  const entered = gate();
  const held = gate();
  const original = resources.adapter.scopeReads!.bind(resources.adapter);
  resources.adapter.scopeReads = async (scope) => {
    const reads = await original(scope);
    return {
      ...reads,
      query: async (request) => {
        const result = await reads.query(request);
        entered.release();
        await held.promise;
        return result;
      },
    };
  };
  const issuer = issue();
  const pending = denied(() => issuer.withContext(signedIn, (context) => context.data.query(query())));
  try {
    await entered.promise;
    issuer.retire();
  } finally {
    held.release();
  }
  await pending;
});

test('callback settlement expires handles immediately while an accepted read is still draining', async (t) => {
  const { issue, resources } = await fixture(t);
  const entered = gate();
  const held = gate();
  const original = resources.adapter.scopeReads!.bind(resources.adapter);
  resources.adapter.scopeReads = async (scope) => {
    const reads = await original(scope);
    return {
      ...reads,
      query: async (request) => {
        const result = await reads.query(request);
        entered.release();
        await held.promise;
        return result;
      },
    };
  };
  let retained!: AppPolicyContext;
  let read!: ReturnType<WriteTransaction['query']>;
  let settled = false;
  const pending = issue().withContext(signedIn, async (context) => {
    retained = context;
    read = context.data.query(query());
    await entered.promise;
    return 'Read has not returned';
  });
  const refused = denied(() => pending);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    await denied(() => retained.data.count('note'));
    await denied(() => retained.transaction('operations', async () => assert.fail('Expired transaction callback')));
  } finally {
    held.release();
  }
  await denied(() => read);
  await refused;
});

for (const retire of [false, true]) {
  test(`accepted writes drain after callback settlement without a postcommit refusal${retire ? ' on retirement' : ''}`, async (t) => {
    const { issue, resources, notes } = await fixture(t);
    const committed = gate();
    const held = gate();
    const anchor = resources.forConnection(owners.operations);
    const original = anchor.scopeTransaction!.bind(anchor);
    anchor.scopeTransaction = async (scope, run) => {
      const result = await original(scope, run);
      committed.release();
      await held.promise;
      return result;
    };
    const issuer = issue();
    let write!: ReturnType<WriteTransaction['update']>;
    let settled = false;
    const pending = issuer.withContext(signedIn, async (context) => {
      write = context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Committed' } });
      // Let the accepted operation reach its commit before settling this callback.
      await committed.promise;
      return 'finished';
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await committed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(notes().find((row) => row.id === 1)?.body, 'Committed');
      assert.equal(settled, false, 'withContext must drain the accepted write');
      if (retire) issuer.retire();
    } finally {
      held.release();
    }
    await write;
    assert.equal(await pending, 'finished');
  });
}

for (const mode of ['direct', 'transaction'] as const) {
  for (const after of ['caught success', 'callback refusal', 'retirement refusal'] as const) {
    test(`${mode}: postcommit unknown survives ${after}`, async (t) => {
      const { issue, resources, notes } = await fixture(t);
      const anchor = resources.forConnection(owners.operations);
      const original = anchor.scopeTransaction!.bind(anchor);
      const unknown = new TransactionOutcomeUnknown(new Error('Commit acknowledgement lost'));
      let committed = false;
      anchor.scopeTransaction = async (scope, run) => {
        await original(scope, run);
        assert.equal(notes().find((row) => row.id === 1)?.body, 'Committed with unknown acknowledgement');
        committed = true;
        throw unknown;
      };
      const issuer = issue();
      await assert.rejects(
        () =>
          issuer.withContext(signedIn, async (context) => {
            const request: UpdateRequest = { table: 'note', key: { id: 1 }, values: { body: 'Committed with unknown acknowledgement' } };
            await assert.rejects(
              () => (mode === 'direct' ? context.data.update!(request) : context.transaction('operations', (tx) => tx.update(request))),
              (error) => error === unknown,
            );
            assert.equal(committed, true);
            if (after === 'callback refusal') throw new Refusal('Callback masks the acknowledgement failure');
            if (after === 'retirement refusal') {
              issuer.retire();
              await denied(() => context.data.count('note'));
              throw new Refusal('Retired callback');
            }
            return 'Caught failure must not report success';
          }),
        (error) => error === unknown,
      );
      assert.equal(notes().find((row) => row.id === 1)?.body, 'Committed with unknown acknowledgement');
    });
  }
}

test('a later postcommit unknown takes priority over an earlier caught top-level refusal', async (t) => {
  const { issue, resources, notes } = await fixture(t);
  const anchor = resources.forConnection(owners.operations);
  const original = anchor.scopeTransaction!.bind(anchor);
  const unknown = new TransactionOutcomeUnknown(new Error('Commit acknowledgement lost'));
  anchor.scopeTransaction = async (scope, run) => {
    await original(scope, run);
    throw unknown;
  };
  await assert.rejects(
    () =>
      issue().withContext(signedIn, async (context) => {
        await denied(() => context.data.query(query('blocked')));
        await assert.rejects(
          () =>
            context.transaction('operations', (tx) =>
              tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Committed after earlier refusal' } }),
            ),
          (error) => error === unknown,
        );
        throw new Refusal('Callback masks both failures');
      }),
    (error) => error === unknown,
  );
  assert.equal(notes().find((row) => row.id === 1)?.body, 'Committed after earlier refusal');
});

test('withContext does not imply atomicity across separately committed direct writes', async (t) => {
  const { issue, notes } = await fixture(t);
  await denied(() =>
    issue().withContext(signedIn, async (context) => {
      await context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'First committed' } });
      await context.data.update!({ table: 'note', key: { id: 2 }, values: { body: 'Denied' } });
    }),
  );
  assert.equal(notes().find((row) => row.id === 1)?.body, 'First committed');
  assert.equal(notes().find((row) => row.id === 2)?.body, 'operations two');
});

test('an unawaited top-level write failure rejects the invocation and preserves earlier confirmed commits', async (t) => {
  const { issue, notes } = await fixture(t);
  await denied(() =>
    issue().withContext(signedIn, async (context) => {
      await context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'First committed' } });
      void context.data.update!({ table: 'note', key: { id: 2 }, values: { body: 'Denied' } });
      return 'Cannot report success';
    }),
  );
  assert.equal(notes().find((row) => row.id === 1)?.body, 'First committed');
  assert.equal(notes().find((row) => row.id === 2)?.body, 'operations two');
});

for (const missing of ['reader', 'writer'] as const) {
  test(`missing scoped ${missing} support never falls back to ordinary operations`, async (t) => {
    const { options, resources } = await fixture(t);
    let fallback = 0;
    const ordinary = () => {
      fallback++;
      throw new Error('Unscoped fallback');
    };
    const unsupported: Adapter = {
      ...resources.adapter,
      ...(missing === 'reader' ? { scopeReads: undefined } : {}),
      scopeTransaction: undefined,
      query: ordinary,
      count: ordinary,
      insert: ordinary,
      update: ordinary,
      remove: ordinary,
      transaction: ordinary,
    };
    await assert.rejects(async () => {
      const issuer = createAppPolicyContext<Request>({
        ...options,
        resources: { ...resources, adapter: unsupported, forConnection: () => unsupported },
      });
      await issuer.withContext(signedIn, async (context) => {
        if (missing === 'reader') await context.data.query(query());
        else await context.transaction('operations', (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Denied' } }));
      });
    });
    assert.equal(fallback, 0);
  });
}

test('issuer requires a default source', async (t) => {
  const { options, app } = await fixture(t);
  const sources = Object.fromEntries(Object.entries(app.sources!).map(([name, source]) => [name, { ...source, default: false }]));
  assert.throws(() => createAppPolicyContext<Request>({ ...options, app: { ...app, sources } }));
});

for (const property of ['auth', 'sources'] as const) {
  test(`issuer requires an explicit deployed ${property}`, async (t) => {
    const { options, app } = await fixture(t);
    const malformed = { ...app };
    delete malformed[property];
    assert.throws(() => createAppPolicyContext<Request>({ ...options, app: malformed }));
  });
}

test('issuer rejects missing, foreign and duplicate registry-owner bindings', async (t) => {
  const { options } = await fixture(t);
  for (const sourceConnections of [
    new Map([['operations', owners.operations]]),
    new Map([
      ['operations', owners.operations],
      ['inventory', 'foreign-registry'],
    ]),
    new Map([
      ['operations', owners.operations],
      ['inventory', owners.operations],
    ]),
    new Map([...Object.entries(owners), ['forged', owners.operations]]),
  ])
    assert.throws(() => createAppPolicyContext<Request>({ ...options, sourceConnections }));
});

/* A signed-out visitor at a row-policy App that opens resources to one.
 *
 * The two grants answer different readers and do not meet: a visitor is
 * scoped by `auth.public`, which names its resources, and an account is
 * scoped by the policy. This is the shape a marketplace has — a catalogue
 * anyone may browse and rows that are one account's — and until now it could
 * not be expressed at all: the parser refused the pair, and the deployment
 * denied a request with no session before it could ask anything.
 */
async function publicFixture(t: TestContext) {
  const base = await fixture(t);
  const app = parseAppConfig(
    {
      id: 'policy-app',
      name: 'Policy fixture',
      sources: Object.fromEntries(
        Object.entries(owners).map(([source, owner]) => [
          source,
          { connection: owner, ...(source === 'operations' ? { default: true } : {}) },
        ]),
      ),
      // The same blocks the fixture builds, rebuilt rather than copied: a parsed
      // App's resources carry facts the parser filled in, which it will not take back.
      resources: Object.fromEntries(
        base.resources.schema.tables
          .filter(({ id }) => !id.endsWith('blocked'))
          .map(({ id }) => {
            const readable = true;
            const writable = !id.endsWith('person');
            return [
              id,
              {
                physical: aliases[id.slice(id.indexOf('.') + 1) as keyof typeof aliases],
                ...(writable ? { access: 'write' } : {}),
                ...(readable && !id.endsWith('note')
                  ? {
                      fields: id.endsWith('person')
                        ? { read: ['id', 'name'] }
                        : { read: ['id', 'title', 'owner_id'], write: ['title', 'owner_id'] },
                    }
                  : {}),
              },
            ];
          }),
      ),
      auth: {
        rows: 'policy',
        roles: { editor: { read: true, write: true }, reader: { read: true } },
        // The catalogue: one resource, named, and nothing else.
        public: { read: ['note'] },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'policy-context public fixture',
  );
  return { ...base, app, issue: (extra: Partial<Options> = {}) => createAppPolicyContext<Request>({ ...base.options, app, ...extra }) };
}

test('a signed-out visitor reads what auth.public names, whole, and nothing else', async (t) => {
  const f = await publicFixture(t);
  const deployment = await f.issue();
  t.after(() => deployment.retire());

  await deployment.withContext({}, async (context) => {
    // Nobody: no id to scope by, no role to grant by, and the policy was not asked.
    assert.equal(context.principal.kind, 'public');
    assert.equal(context.principal.id, '');
    assert.deepEqual([...context.principal.roles], []);

    /* Every note, not the policy's tenant slice: a public resource is public,
       and the row scope that applies to an account has nobody to apply to
       here. Both tenants' rows come back. */
    const rows = await context.data.query(query('note'));
    assert.deepEqual(rows.rows.map((row) => row.body).sort(), ['operations one', 'operations two']);

    /* A resource the grant does not name is not in this reader's catalog at
       all — not a table they may not read, a table they cannot see. */
    assert.ok(
      !context.schema.tables.some((table) => table.id === 'ticket' || table.id === 'person'),
      "a resource outside auth.public was in the visitor's catalog",
    );
    // And nothing may be written, whatever the resource's ceiling says.
    assert.equal(context.data.insert, undefined);
    assert.equal(context.data.update, undefined);
    assert.equal(context.data.remove, undefined);
    assert.deepEqual(context.writeFields, {});
    assert.equal(context.commands, undefined);
  });

  /* Each denial in an invocation of its own: a failed operation fails the
     whole invocation by design, even when the caller catches it, so probing
     two refusals in one context would prove only the first. */
  for (const table of ['ticket', 'person', 'blocked'] as const) {
    await assert.rejects(
      async () =>
        deployment.withContext({}, async (context) => {
          await context.data.query(query(table)).catch(() => undefined);
        }),
      `a visitor read ${table}, which auth.public does not name`,
    );
  }
});

test('public row narrowing cannot widen grants or replace the private account policy', async (t) => {
  const f = await publicFixture(t);
  let calls = 0;
  const issuer = f.issue({
    resolvePublicRows: () => {
      calls++;
      return { note: equal('tenant', 2), person: true, ticket: true, blocked: true };
    },
  });
  t.after(() => issuer.retire());
  await issuer.withContext({}, async (context) => {
    assert.deepEqual(
      (await context.data.query(query())).rows.map((row) => row.body),
      ['operations two'],
    );
    assert.deepEqual(
      context.schema.tables.map((table) => table.id),
      ['note'],
    );
    assert.equal(context.data.insert, undefined);
    assert.equal(context.commands, undefined);
  });
  await issuer.withContext(signedIn, async (context) => {
    assert.deepEqual(
      (await context.data.query(query())).rows.map((row) => row.body),
      ['operations one'],
    );
  });
  assert.equal(calls, 1);
});

test('public row narrowing has no all-rows fallback for missing scopes or late resolution after retirement', async (t) => {
  const f = await publicFixture(t);
  const empty = f.issue({ resolvePublicRows: () => ({}) });
  await empty.withContext({}, async (context) => {
    assert.equal((await context.data.query(query())).rows.length, 0);
  });
  empty.retire();
  const entered = gate(),
    held = gate();
  const issuer = f.issue({
    resolvePublicRows: async () => {
      entered.release();
      await held.promise;
      return { note: true };
    },
  });
  let published = false;
  const request = issuer.withContext({}, async () => {
    published = true;
  });
  const rejected = denied(() => request);
  await entered.promise;
  issuer.retire();
  held.release();
  await rejected;
  assert.equal(published, false);
});

test('an explicit public reader ignores staff credentials and refuses publication after retirement', async (t) => {
  const f = await publicFixture(t);
  const issuer = f.issue({
    verifySession: async () => assert.fail('public reader consulted staff credentials'),
    resolveRows: () => assert.fail('public reader borrowed private rows'),
    resolvePublicRows: () => ({ note: equal('tenant', 2) }),
  });
  const entered = gate(),
    held = gate();
  const pending = issuer.withPublicContext(signedIn, async (context) => {
    assert.equal(context.principal.id, '');
    assert.equal(context.principal.kind, 'public');
    assert.deepEqual([...context.principal.roles], []);
    const result = await context.data.query(query());
    assert.deepEqual(
      result.rows.map((row) => row.body),
      ['operations two'],
    );
    entered.release();
    await held.promise;
    return result;
  });
  const rejected = denied(() => pending);
  await entered.promise;
  issuer.retire();
  held.release();
  await rejected;
  await denied(() => issuer.withPublicContext(signedIn, async () => assert.fail('retired reader admitted')));
});

test("a signed-in account at the same App is still the policy's to scope", async (t) => {
  const f = await publicFixture(t);
  const asked: string[] = [];
  const deployment = await f.issue({
    resolveRows: (principal) => {
      asked.push(principal.id);
      return f.rows;
    },
  });
  t.after(() => deployment.retire());

  // The visitor never reaches the policy...
  await deployment.withContext({}, async (context) => {
    assert.equal(context.principal.kind, 'public');
    assert.equal((await context.data.query(query('note'))).rows.length, 2);
  });
  assert.deepEqual(asked, [], 'the policy was asked about a visitor');

  // ...and an account still is, with its scope applied.
  await deployment.withContext(signedIn, async (context) => {
    assert.equal(context.principal.kind, undefined);
    assert.equal(context.principal.id, 'editor-id');
    const rows = await context.data.query(query('note'));
    assert.deepEqual(
      rows.rows.map((row) => row.body),
      ['operations one'],
    );
  });
  assert.deepEqual(asked, ['editor-id']);
});
