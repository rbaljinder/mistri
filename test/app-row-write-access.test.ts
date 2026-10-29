import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  type Adapter,
  type DeleteRequest,
  type Filter,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  accessibleSchema,
  AppAccessDenied,
  authorizeResources,
  authorizeTransaction,
  type ResourceAccess,
} from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

const equal = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const query = (table = 'person', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const fields = (read: string[], write = read) => ({ read: new Set(read), write: new Set(write) });
const denied = (run: () => unknown) => assert.rejects(async () => run(), Refusal);
type Operation = (tx: WriteTransaction) => Promise<unknown>;
const owners = { operations: 'ops-db', inventory: 'stock-db' };
const aliases = {
  person: 'physical_person',
  ticket: 'physical_ticket',
  note: 'physical_note',
  blocked: 'physical_blocked',
  no_key: 'physical_no_key',
  report: 'physical_report',
};

async function fixture(t: TestContext, options: { single?: boolean; readonlyInventory?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-write-access-'));
  const physical = new Map<string, SqliteAdapter>();
  const databases = new Map<string, DatabaseSync>();
  t.after(async () => {
    try {
      await Promise.all([...physical.values()].map((adapter) => adapter.close()));
    } finally {
      for (const db of databases.values()) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of options.single ? (['operations'] as const) : (['operations', 'inventory'] as const)) {
    const tenant = source === 'operations' ? 1 : 2;
    const file = join(directory, `${source}.db`);
    const db = new DatabaseSync(file);
    databases.set(source, db);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE physical_person (id INTEGER PRIMARY KEY, name TEXT,
        tenant INTEGER NOT NULL DEFAULT ${tenant}, secret TEXT DEFAULT 'private');
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, title TEXT,
        tenant INTEGER NOT NULL DEFAULT ${tenant}, owner_id INTEGER DEFAULT ${tenant} REFERENCES physical_person(id),
        secret TEXT DEFAULT 'private ticket');
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT, tenant INTEGER NOT NULL DEFAULT ${tenant});
      CREATE TABLE physical_blocked (id INTEGER PRIMARY KEY, body TEXT, tenant INTEGER NOT NULL DEFAULT ${tenant});
      CREATE TABLE physical_no_key (body TEXT, tenant INTEGER);
      CREATE VIEW physical_report AS SELECT id, body, tenant FROM physical_note;
      INSERT INTO physical_person VALUES (1, '${source} one', 1, 'secret one'), (2, '${source} two', 2, 'secret two');
      INSERT INTO physical_ticket VALUES (1, 'First', 1, 1, 'secret first'), (2, 'Second', 2, 2, 'secret second'),
        (3, 'Hidden parent', ${tenant}, ${tenant === 1 ? 2 : 1}, 'secret third');
      INSERT INTO physical_note VALUES (1, '${source} one', 1), (2, '${source} two', 2);
      INSERT INTO physical_blocked VALUES (1, 'No resource write grant', ${tenant});
    `);
    const adapter = new SqliteAdapter(file, source);
    physical.set(source, adapter);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      resources: aliases,
      writable: source !== 'inventory' || !options.readonlyInventory,
    };
  }
  let resources: RuntimeResources;
  if (options.single) {
    const local = createAppResources(physical.get('operations')!, sources.operations.schema, aliases);
    resources = {
      ...local,
      connections: [owners.operations],
      connectionFor: (resource) => {
        local.toPhysical(resource);
        return owners.operations;
      },
      toLogicalAt: (table, owner) => {
        if (owner !== owners.operations) throw new Refusal('Wrong owner');
        return local.toLogical(table);
      },
      forConnection: (owner) => {
        if (owner !== owners.operations) throw new Refusal('Wrong owner');
        return local.adapter;
      },
    };
  } else {
    const runtime = createAppSourceAdapter(sources, 'operations');
    const sourceFor = (owner: string) => {
      const source = (Object.keys(owners) as Array<keyof typeof owners>).find((source) => owners[source] === owner);
      if (!source) throw new Refusal('Wrong owner');
      return source;
    };
    resources = {
      ...runtime,
      connections: Object.values(owners),
      connectionFor: (name) => owners[runtime.resolve(name).source as keyof typeof owners],
      toPhysical: (name) => runtime.resolve(name).physicalTable,
      toLogical: (name) => runtime.catalogs.get('operations')!.toLogical(name),
      toLogicalAt: (name, owner) => {
        const source = sourceFor(owner);
        return (source === 'operations' ? '' : `${source}.`) + runtime.catalogs.get(source)!.toLogical(name);
      },
      forConnection: (owner) => runtime.forSource(sourceFor(owner)),
    };
  }
  const access: ResourceAccess = {
    readable: new Set(resources.schema.tables.map((table) => table.id)),
    writable: new Set(
      resources.schema.tables.filter((table) => /^(inventory\.)?(person|ticket|note)$/.test(table.id)).map((table) => table.id),
    ),
    rows: Object.fromEntries(
      resources.schema.tables.map((table) => [table.id, equal('tenant', table.id.startsWith('inventory.') ? 2 : 1)]),
    ),
    fields: new Map(
      resources.schema.tables.map((table) => [
        table.id,
        table.id.endsWith('person')
          ? fields(['id', 'name'], ['name'])
          : table.id.endsWith('ticket')
            ? fields(['id', 'title', 'owner_id'], ['title', 'owner_id'])
            : fields(table.columns.map((column) => column.name)),
      ]),
    ),
  };
  return { resources, access, physical, databases };
}

async function stored(adapter: Adapter, table: string) {
  return (await adapter.query(query(table, { orderBy: [{ column: 'id', direction: 'asc' }] }))).rows;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('combined row-authorized direct CRUD routes exact merged IDs to their owner and filters the bound policy', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const bindings: Array<[string, string[]]> = [];
  let fallback = 0;
  const unsafe = () => {
    fallback++;
    throw new Error('Ordinary writer fallback');
  };
  const guarded = authorizeResources(
    {
      ...resources,
      adapter: { ...resources.adapter, insert: unsafe, update: unsafe, remove: unsafe, transaction: undefined },
      forConnection: (owner) => {
        const original = resources.forConnection(owner);
        return {
          ...original,
          insert: unsafe,
          update: unsafe,
          remove: unsafe,
          transaction: unsafe,
          scopeTransaction: (scope, run) => {
            bindings.push([owner, Object.keys(scope).sort()]);
            return original.scopeTransaction!(scope, run);
          },
        };
      },
    },
    access,
  );
  assert.equal(guarded.adapter.transaction, undefined, 'A combined adapter cannot promise atomicity across sources');
  for (const [source, owner] of Object.entries(owners)) {
    const table = source === 'operations' ? 'note' : 'inventory.note';
    const adapter = guarded.adapter;
    const inserted = await adapter.insert!({ table, values: { id: 10, body: `${source} inserted` } });
    assert.deepEqual(inserted.key, { id: 10 });
    assert.equal(inserted.row?.tenant, source === 'operations' ? 1 : 2);
    assert.equal((await adapter.update!({ table, key: { id: 10 }, values: { body: `${source} updated` } })).affected, 1);
    assert.equal((await adapter.query(query(table, { filter: equal('id', 10) }))).rows[0].body, `${source} updated`);
    assert.equal((await adapter.remove!({ table, key: { id: 10 } })).affected, 1);
    assert.equal(await physical.get(source)!.count('physical_note', equal('id', 10)), 0);
    assert.deepEqual(
      bindings.slice(-3),
      Array.from({ length: 3 }, () => [
        owner,
        Object.keys(access.rows!)
          .filter((id) => resources.connectionFor(id) === owner)
          .sort(),
      ]),
    );
  }
  assert.equal(fallback, 0);
  assert.equal(await physical.get('operations')!.count('physical_note'), 2);
  assert.equal(await physical.get('inventory')!.count('physical_note'), 2);
});

for (const single of [false, true]) {
  test(`${single ? 'single-source root' : 'anchored'} row-authorized transactions compose all five methods and read their own writes`, async (t) => {
    const { resources, access, physical } = await fixture(t, { single });
    const guarded = authorizeResources(resources, access);
    const adapter = single ? guarded.adapter : guarded.forConnection(owners.inventory);
    const table = single ? 'note' : 'inventory.note';
    const raw = physical.get(single ? 'operations' : 'inventory')!;
    const result = await adapter.transaction!(async (tx) => {
      assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
      const { insert, query: read, count, update, remove } = tx;
      await insert({ table, values: { id: 10, body: 'New' } });
      assert.equal(await count(table), 2);
      assert.equal(await raw.count('physical_note', equal('id', 10)), 0);
      await update({ table, key: { id: 10 }, values: { body: 'Changed' }, expected: { body: 'New' } });
      assert.deepEqual((await read(query(table, { columns: ['body'], filter: equal('id', 10) }))).rows, [{ body: 'Changed' }]);
      await remove({ table, key: { id: 10 } });
      assert.equal(await count(table, equal('id', 10)), 0);
      await insert({ table, values: { id: 11, body: 'Committed' } });
      return { committed: 11 };
    });
    assert.deepEqual(result, { committed: 11 });
    assert.equal(await raw.count('physical_note', equal('id', 11)), 1);
    const before = await stored(raw, 'physical_note');
    const failure = new Error('Abort callback');
    await assert.rejects(
      adapter.transaction!(async (tx) => {
        await tx.update({ table, key: { id: 11 }, values: { body: 'Rolled back' } });
        await tx.insert({ table, values: { id: 12, body: 'Rolled back' } });
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await stored(raw, 'physical_note'), before);
  });
}

test('insert results are projected and hidden fields and predicates refuse for direct and transactional operations', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const guarded = authorizeResources(resources, access);
  const result = await guarded.adapter.insert!({ table: 'person', values: { name: 'Visible new person' } });
  assert.deepEqual(result.row, { id: result.key.id, name: 'Visible new person' });
  const raw = physical.get('operations')!;
  assert.equal((await raw.query(query('physical_person', { filter: equal('id', result.key.id as number) }))).rows[0].secret, 'private');
  const forbidden: Operation[] = [
    (tx: WriteTransaction) => tx.query(query('person', { columns: ['secret'] })),
    (tx: WriteTransaction) => tx.query(query('person', { orderBy: [{ column: 'tenant', direction: 'asc' }] })),
    (tx: WriteTransaction) => tx.query(query('person', { filter: equal('tenant', 1) })),
    (tx: WriteTransaction) => tx.count('person', equal('secret', 'private')),
    (tx: WriteTransaction) => tx.insert({ table: 'person', values: { name: 'Denied', tenant: 1 } }),
    (tx: WriteTransaction) => tx.update({ table: 'person', key: { id: 1 }, values: { secret: 'Denied' } }),
    (tx: WriteTransaction) =>
      tx.update({ table: 'person', key: { id: 1 }, values: { name: 'Denied' }, expected: { secret: 'secret one' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'person', key: { id: 1 } }),
  ];
  const before = await stored(raw, 'physical_person');
  for (const operation of forbidden) {
    await denied(() => operation(guarded.adapter as WriteTransaction));
    await denied(() => guarded.forConnection(owners.operations).transaction!(operation));
  }
  assert.deepEqual(await stored(raw, 'physical_person'), before);
  await guarded.forConnection(owners.operations).transaction!(async (tx) => {
    const inserted = await tx.insert({ table: 'person', values: { name: 'Transaction projection' } });
    assert.deepEqual(inserted.row, { id: inserted.key.id, name: 'Transaction projection' });
    assert.deepEqual((await tx.query(query('person', { filter: equal('id', inserted.key.id as number) }))).rows, [inserted.row]);
  });
});

test('stored row predicates, hidden FK owners and post-image escapes refuse and roll back prior authorized writes', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const guarded = authorizeResources(resources, access);
  const raw = physical.get('operations')!;
  const operations: Operation[] = [
    (tx: WriteTransaction) => tx.update({ table: 'note', key: { id: 2 }, values: { body: 'Hidden row' } }),
    (tx: WriteTransaction) => tx.remove({ table: 'note', key: { id: 2 } }),
    (tx: WriteTransaction) => tx.insert({ table: 'note', values: { id: 10, body: 'Escaping insert', tenant: 2 } }),
    (tx: WriteTransaction) => tx.update({ table: 'note', key: { id: 1 }, values: { tenant: 2 } }),
    (tx: WriteTransaction) => tx.insert({ table: 'ticket', values: { title: 'Hidden owner', owner_id: 2 } }),
    (tx: WriteTransaction) => tx.update({ table: 'ticket', key: { id: 1 }, values: { owner_id: 2 } }),
  ];
  const beforeNotes = await stored(raw, 'physical_note');
  const beforeTickets = await stored(raw, 'physical_ticket');
  for (const operation of operations) {
    await denied(() => operation(guarded.adapter as WriteTransaction));
    await denied(() =>
      guarded.forConnection(owners.operations).transaction!(async (tx) => {
        await tx.insert({ table: 'note', values: { id: 11, body: 'Must roll back' } });
        await operation(tx);
      }),
    );
    assert.deepEqual(await stored(raw, 'physical_note'), beforeNotes);
    assert.deepEqual(await stored(raw, 'physical_ticket'), beforeTickets);
  }
  for (const rows of [{ ...access.rows, note: false }, Object.fromEntries(Object.entries(access.rows!).filter(([id]) => id !== 'note'))]) {
    const adapter = authorizeResources(resources, { ...access, rows }).adapter;
    await denied(() => adapter.insert!({ table: 'note', values: { body: 'Denied row rule' } }));
    await denied(() => adapter.update!({ table: 'note', key: { id: 1 }, values: { body: 'Denied row rule' } }));
    await denied(() => adapter.remove!({ table: 'note', key: { id: 1 } }));
    assert.equal(await adapter.count('note'), 0);
  }
});

test('physical metadata retains unpublished FK parents and newly added incoming dependencies', async (t) => {
  const { resources, access, databases, physical } = await fixture(t);
  const db = databases.get('operations')!;
  const guarded = authorizeResources(resources, access);
  db.exec(`
    CREATE TABLE private_parent (id INTEGER PRIMARY KEY);
    INSERT INTO private_parent VALUES (1);
    ALTER TABLE physical_ticket ADD COLUMN private_owner INTEGER REFERENCES private_parent(id);
    UPDATE physical_ticket SET private_owner = 1 WHERE id = 1;
    CREATE TABLE private_dependent (id INTEGER PRIMARY KEY, note_id INTEGER REFERENCES physical_note(id) ON DELETE CASCADE);
    INSERT INTO private_dependent VALUES (1, 1);
  `);
  assert.ok(!guarded.schema.tables.some((table) => table.id.includes('private')));
  assert.ok(!guarded.schema.foreignKeys.some((fk) => fk.to.table === 'note'));
  const raw = physical.get('operations')!;
  await denied(() => guarded.adapter.update!({ table: 'ticket', key: { id: 1 }, values: { title: 'Hidden physical parent' } }));
  await denied(() => guarded.adapter.remove!({ table: 'note', key: { id: 1 } }));
  await denied(() =>
    guarded.forConnection(owners.operations).transaction!(async (tx) => {
      await tx.insert({ table: 'note', values: { id: 10, body: 'Must roll back' } });
      await tx.remove({ table: 'note', key: { id: 1 } });
    }),
  );
  assert.equal(await raw.count('physical_note'), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_dependent').get()!.n, 1);
  assert.equal((await raw.query(query('physical_ticket', { filter: equal('id', 1) }))).rows[0].title, 'First');
});

for (const kind of ['hidden resource', 'revoked resource', 'hidden referenced field'] as const) {
  test(`outgoing FK checks refuse a ${kind} parent even with an unrestricted parent row rule`, async (t) => {
    const { resources, access, physical } = await fixture(t);
    const readable = new Set(access.readable);
    if (kind === 'hidden resource') readable.delete('person');
    const policy = {
      ...access,
      readable,
      writable: new Set(['ticket', 'note']),
      rows: { ...access.rows, person: true },
      fields: new Map(access.fields),
    };
    if (kind === 'hidden referenced field') policy.fields.set('person', fields(['name'], []));
    const guarded = authorizeResources(resources, policy);
    if (kind === 'revoked resource') readable.delete('person');
    const raw = physical.get('operations')!;
    const before = await stored(raw, 'physical_ticket');
    // This permission gate is conservative: even a null FK requires readable
    // parent resources/target fields, before physical null-parent lookup rules.
    const operations: Operation[] = [
      (tx) => tx.insert({ table: 'ticket', values: { title: 'Hidden parent', owner_id: 1 } }),
      (tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { owner_id: 1 } }),
      (tx) => tx.insert({ table: 'ticket', values: { title: 'Null parent', owner_id: null } }),
      (tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { owner_id: null } }),
    ];
    for (const operation of operations) {
      await denied(() => operation(guarded.adapter as WriteTransaction));
      await denied(() =>
        guarded.forConnection(owners.operations).transaction!(async (tx) => {
          await tx.insert({ table: 'note', values: { id: 10, body: 'Must roll back' } });
          await denied(() => operation(tx));
        }),
      );
      assert.deepEqual(await stored(raw, 'physical_ticket'), before);
      assert.equal(await raw.count('physical_note'), 2);
    }
  });
}

test('private ownership columns and hidden child FK fields remain usable by physical guards without becoming public', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const policy = { ...access, fields: new Map(access.fields) };
  policy.fields.set('ticket', fields(['id', 'title'], ['title']));
  const guarded = authorizeResources(resources, policy);
  const inserted = await guarded.adapter.insert!({ table: 'ticket', values: { title: 'Default visible owner' } });
  assert.deepEqual(inserted.row, { id: inserted.key.id, title: 'Default visible owner' });
  await guarded.forConnection(owners.operations).transaction!(async (tx) => {
    await tx.update({ table: 'ticket', key: { id: 1 }, values: { title: 'Hidden FK still guarded' } });
    const result = await tx.insert({ table: 'ticket', values: { title: 'Private defaults' } });
    assert.deepEqual(result.row, { id: result.key.id, title: 'Private defaults' });
  });
  const changed = await guarded.adapter.update!({ table: 'ticket', key: { id: 3 }, values: { title: 'Unchanged hidden owner' } });
  assert.equal(changed.affected, 1, 'An unrelated edit leaves its existing reference alone');
  assert.equal(Reflect.get(changed.applied, 'owner_id'), undefined, 'The hidden reference stays private');
  await denied(() => guarded.adapter.update!({ table: 'ticket', key: { id: 1 }, values: { owner_id: 1 } }));
  const raw = physical.get('operations')!;
  const row = (await raw.query(query('physical_ticket', { filter: equal('id', inserted.key.id) }))).rows[0];
  assert.equal(row.owner_id, 1);
  assert.equal(row.tenant, 1);
});

test('direct methods present for one resource still reject another resource without a write grant', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const guarded = authorizeResources(resources, { ...access, writable: new Set(['note']) });
  for (const adapter of [guarded.adapter, guarded.forConnection(owners.operations)]) {
    assert.equal(typeof adapter.insert, 'function');
    assert.equal(typeof adapter.update, 'function');
    assert.equal(typeof adapter.remove, 'function');
    await denied(() => adapter.insert!({ table: 'blocked', values: { body: 'Denied insert' } }));
    await denied(() => adapter.update!({ table: 'blocked', key: { id: 1 }, values: { body: 'Denied update' } }));
    await denied(() => adapter.remove!({ table: 'blocked', key: { id: 1 } }));
  }
  assert.deepEqual(await stored(physical.get('operations')!, 'physical_blocked'), [{ id: 1, body: 'No resource write grant', tenant: 1 }]);
});

for (const inverse of ['update ownership', 'restore deleted hidden row', 'delete hidden row'] as const) {
  test(`inverse ${inverse} is row-authorized and rolls back earlier transaction writes`, async (t) => {
    const { resources, access, physical } = await fixture(t);
    const raw = physical.get('operations')!;
    const hidden = (await raw.query(query('physical_note', { filter: equal('id', 2) }))).rows[0];
    if (inverse === 'restore deleted hidden row') await raw.remove({ table: 'physical_note', key: { id: 2 } });
    const before = await stored(raw, 'physical_note');
    const adapter = authorizeResources(resources, access).forConnection(owners.operations);
    await denied(() =>
      adapter.transaction!(async (tx) => {
        await tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Prior write must roll back' } });
        if (inverse === 'update ownership') {
          await tx.update({ table: 'note', key: { id: 1 }, values: { tenant: 2 }, expected: { tenant: 1 } });
        } else if (inverse === 'restore deleted hidden row') {
          await tx.insert({
            table: 'note',
            values: { id: hidden.id as number, body: hidden.body as string, tenant: hidden.tenant as number },
          });
        } else {
          await tx.remove({ table: 'note', key: { id: 2 } });
        }
      }),
    );
    assert.deepEqual(await stored(raw, 'physical_note'), before);
  });
}

test('scoped catalog drops estimates and projects write and delete affordances from the complete public graph', async (t) => {
  const { resources, access } = await fixture(t);
  for (const table of resources.schema.tables) table.approxRows = 999;
  const before = structuredClone(resources.schema);
  const policy = { ...access, writable: new Set([...access.writable, 'no_key', 'report']), fields: new Map(access.fields) };
  policy.fields.set('person', fields(['id', 'name', 'tenant', 'secret']));
  const guarded = authorizeResources(resources, policy);
  for (const schema of [
    accessibleSchema(resources.schema, policy),
    guarded.schema,
    await guarded.adapter.introspect(),
    await guarded.forConnection(owners.operations).introspect(),
  ]) {
    assert.ok(schema.tables.every((table) => !Object.hasOwn(table, 'approxRows')));
    const table = (id: string) => schema.tables.find((table) => table.id === id)!;
    assert.deepEqual(
      table('ticket').columns.map((column) => [column.name, column.writable]),
      [
        ['id', false],
        ['title', true],
        ['owner_id', true],
      ],
    );
    assert.ok(table('blocked').columns.every((column) => column.writable === false));
    assert.equal(table('note').deletable, true);
    for (const id of ['person', 'ticket', 'blocked', 'no_key', 'report']) assert.equal(table(id).deletable, false, id);
  }
  const hiddenChild = { ...policy, readable: new Set([...policy.readable].filter((id) => id !== 'ticket')) };
  assert.equal(accessibleSchema(resources.schema, hiddenChild).tables.find((table) => table.id === 'person')!.deletable, false);
  const hiddenRead = { ...policy, fields: new Map(policy.fields) };
  hiddenRead.fields.set('note', fields(['id', 'body'], ['id', 'body', 'tenant']));
  assert.equal(accessibleSchema(resources.schema, hiddenRead).tables.find((table) => table.id === 'note')!.deletable, false);
  hiddenRead.fields.set('note', fields(['id', 'body', 'tenant'], ['body']));
  assert.equal(accessibleSchema(resources.schema, hiddenRead).tables.find((table) => table.id === 'note')!.deletable, false);
  assert.deepEqual(resources.schema, before);
});

test('unknown, unreadable and unsupported owner write grants refuse construction without ordinary fallback', async (t) => {
  const { resources, access } = await fixture(t);
  for (const id of ['missing', 'physical_person', 'operations.person']) {
    assert.throws(() => authorizeResources(resources, { ...access, writable: new Set([id]) }), AppAccessDenied);
    assert.throws(
      () => authorizeResources(resources, { ...access, readable: new Set([...access.readable, id]), writable: new Set([id]) }),
      AppAccessDenied,
    );
  }
  assert.throws(
    () =>
      authorizeResources(resources, {
        ...access,
        readable: new Set([...access.readable].filter((id) => id !== 'note')),
        writable: new Set(['note']),
      }),
    AppAccessDenied,
  );
  let fallback = 0;
  const unsafe = () => {
    fallback++;
    throw new Error('Ordinary writer fallback');
  };
  for (const dialect of ['sqlite', 'postgres'] as const) {
    const unsupported: RuntimeResources = {
      ...resources,
      forConnection: (owner) => ({
        ...resources.forConnection(owner),
        dialect,
        scopeTransaction: undefined,
        insert: unsafe,
        update: unsafe,
        remove: unsafe,
        transaction: unsafe,
      }),
    };
    assert.throws(() => authorizeResources(unsupported, access), AppAccessDenied);
  }
  assert.equal(fallback, 0);
});

test('source read-only flags still refuse writes and other owners without local grants expose no writers', async (t) => {
  const { resources, access, physical } = await fixture(t, { readonlyInventory: true });
  await denied(() => authorizeResources(resources, access).adapter.insert!({ table: 'inventory.note', values: { body: 'Denied' } }));
  await denied(() =>
    authorizeResources(resources, access).forConnection(owners.inventory).transaction!((tx) =>
      tx.update({ table: 'inventory.note', key: { id: 2 }, values: { body: 'Denied' } }),
    ),
  );
  assert.equal(await physical.get('inventory')!.count('physical_note'), 2);
  const local = authorizeResources(resources, { ...access, writable: new Set(['note']) });
  assert.equal(typeof local.forConnection(owners.operations).transaction, 'function');
  for (const method of ['insert', 'update', 'remove', 'transaction'] as const) {
    assert.equal(local.forConnection(owners.inventory)[method], undefined);
  }
  assert.equal(await local.forConnection(owners.inventory).count('inventory.note'), 1);
  await denied(() => local.adapter.insert!({ table: 'inventory.note', values: { body: 'No write grant' } }));
});

test('no row write grants expose zero writers, transaction rebinding or command journal capabilities', async (t) => {
  const { resources, access } = await fixture(t);
  for (const writable of [access.writable, new Set<string>()]) {
    const guarded = authorizeResources(resources, { ...access, writable });
    for (const adapter of [guarded.adapter, guarded.forConnection(owners.operations), guarded.forConnection(owners.inventory)]) {
      for (const method of [
        'scopeReads',
        'scopeTransaction',
        'commandTransaction',
        'runSql',
        'explainSql',
        'ddl',
        'profile',
        'estimateCount',
      ] as const) {
        assert.equal(adapter[method], undefined);
      }
      if (!writable.size) {
        for (const method of ['insert', 'update', 'remove', 'transaction'] as const) assert.equal(adapter[method], undefined);
      }
      await adapter.close();
    }
  }
  assert.equal(await resources.adapter.count('note'), 2);
});

const refusals: Array<[string, (tx: WriteTransaction) => Promise<unknown>]> = [
  ['field', (tx) => tx.update({ table: 'person', key: { id: 1 }, values: { secret: 'Denied' } })],
  ['resource', (tx) => tx.insert({ table: 'blocked', values: { body: 'Denied' } })],
  ['mapping', (tx) => tx.insert({ table: 'inventory.note', values: { body: 'Wrong owner' } })],
  ['physical spelling', (tx) => tx.count('physical_note')],
  ['hidden predicate', (tx) => tx.count('person', equal('tenant', 1))],
];
for (const [label, refuse] of refusals) {
  test(`caught ${label} refusal rolls back prior writes and fail-stops queued operations`, async (t) => {
    const { resources, access, physical } = await fixture(t);
    const adapter = authorizeResources(resources, access).forConnection(owners.operations);
    let checkedLater = false;
    await denied(() =>
      adapter.transaction!(async (tx) => {
        await tx.insert({ table: 'note', values: { id: 10, body: 'Earlier write' } });
        await denied(() => refuse(tx));
        const results = await Promise.allSettled([
          tx.insert({ table: 'note', values: { id: 11, body: 'Queued write' } }),
          tx.query(query('note')),
          tx.count('note'),
          tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Queued update' } }),
          tx.remove({ table: 'note', key: { id: 1 } }),
        ]);
        assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof Refusal));
        checkedLater = true;
      }),
    );
    assert.equal(checkedLater, true);
    assert.deepEqual(await stored(physical.get('operations')!, 'physical_note'), [
      { id: 1, body: 'operations one', tenant: 1 },
      { id: 2, body: 'operations two', tenant: 2 },
    ]);
    assert.equal(await physical.get('inventory')!.count('physical_note'), 2);
  });
}

test('unawaited authorization refusal poisons prior writes and drains later queued work before rollback', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const adapter = authorizeResources(resources, access).forConnection(owners.operations);
  let queued = false;
  let later!: Promise<unknown>;
  await denied(() =>
    adapter.transaction!(async (tx) => {
      await tx.insert({ table: 'note', values: { id: 10, body: 'Earlier write' } });
      void tx.query(query('person', { columns: ['secret'] }));
      later = tx.insert({ table: 'note', values: { id: 11, body: 'Later write' } });
      queued = true;
    }),
  );
  assert.equal(queued, true, 'Authorization failures participate in the transaction queue');
  await denied(() => later);
  assert.equal(await physical.get('operations')!.count('physical_note'), 2);
});

test('direct write requests and private row policies are copied before asynchronous capability binding', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const binding = gate();
  t.after(binding.release);
  const seen: RowScope[] = [];
  const adapter = authorizeResources(
    {
      ...resources,
      forConnection: (owner) => {
        const original = resources.forConnection(owner);
        return {
          ...original,
          scopeTransaction: async (scope, run) => {
            seen.push(scope);
            await binding.promise;
            return original.scopeTransaction!(scope, run);
          },
        };
      },
    },
    access,
  ).adapter;
  const insert: InsertRequest = { table: 'note', values: { id: 10, body: 'Captured insert' } };
  const update: UpdateRequest = {
    table: 'note',
    key: { id: 1 },
    values: { body: 'Captured update' },
    expected: { body: 'operations one' },
  };
  const remove: DeleteRequest = { table: 'inventory.note', key: { id: 2 } };
  const pending = [adapter.insert!(insert), adapter.update!(update), adapter.remove!(remove)];
  insert.table = 'inventory.note';
  insert.values.id = 20;
  insert.values.body = 'Mutated';
  update.table = 'inventory.note';
  update.key.id = 2;
  update.values.body = 'Mutated';
  update.expected!.body = 'inventory two';
  remove.table = 'note';
  remove.key.id = 1;
  (access.rows!.note as Filter).groups[0][0].value = 2;
  access.rows = { note: true, 'inventory.note': false };
  binding.release();
  await Promise.all(pending);
  assert.equal(seen.length, 3);
  assert.equal((seen.find((scope) => Object.hasOwn(scope, 'note'))!.note as Filter).groups[0][0].value, 1);
  assert.deepEqual(await stored(physical.get('operations')!, 'physical_note'), [
    { id: 1, body: 'Captured update', tenant: 1 },
    { id: 2, body: 'operations two', tenant: 2 },
    { id: 10, body: 'Captured insert', tenant: 1 },
  ]);
  assert.deepEqual(await stored(physical.get('inventory')!, 'physical_note'), [{ id: 1, body: 'inventory one', tenant: 1 }]);
});

test('all five transaction arguments are copied before queueing and detached methods keep their scope', async (t) => {
  const { resources, access } = await fixture(t);
  const adapter = authorizeResources(resources, access).forConnection(owners.operations);
  await adapter.transaction!(async (tx) => {
    const { insert, update, query: read, count, remove } = tx;
    const create: InsertRequest = { table: 'note', values: { id: 10, body: 'Captured' } };
    const change: UpdateRequest = { table: 'note', key: { id: 10 }, values: { body: 'Updated' }, expected: { body: 'Captured' } };
    const request = query('note', { columns: ['body'], filter: equal('id', 10), orderBy: [{ column: 'id', direction: 'asc' }] });
    const filter = equal('id', 10);
    const deletion: DeleteRequest = { table: 'note', key: { id: 10 } };
    const pending = [insert(create), update(change), read(request), count('note', filter), remove(deletion)];
    create.table = 'inventory.note';
    create.values.id = 20;
    create.values.body = 'Mutated';
    change.table = 'inventory.note';
    change.key.id = 2;
    change.values.body = 'Mutated';
    change.expected!.body = 'Mutated';
    request.table = 'inventory.note';
    request.columns![0] = 'tenant';
    request.filter!.groups[0][0].value = 2;
    request.orderBy![0].column = 'tenant';
    filter.groups[0][0].value = 2;
    deletion.table = 'inventory.note';
    deletion.key.id = 2;
    const results = await Promise.all(pending);
    assert.deepEqual((results[2] as Awaited<ReturnType<WriteTransaction['query']>>).rows, [{ body: 'Updated' }]);
    assert.equal(results[3], 1);
    assert.equal(await tx.count('note', equal('id', 10)), 0);
  });
});

test('escaped transaction methods expire after both commit and rollback', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const guarded = authorizeResources(resources, access);
  const adapter = guarded.forConnection(owners.operations);
  for (const rollback of [false, true]) {
    let escaped!: WriteTransaction;
    const run = adapter.transaction!(async (tx) => {
      escaped = tx;
      if (rollback) throw new Refusal('Abort');
    });
    if (rollback) await denied(() => run);
    else await run;
    const { query: read, count, insert, update, remove } = escaped;
    for (const operation of [
      () => read(query('note')),
      () => count('note'),
      () => insert({ table: 'note', values: { body: 'Expired' } }),
      () => update({ table: 'note', key: { id: 1 }, values: { body: 'Expired' } }),
      () => remove({ table: 'note', key: { id: 1 } }),
    ])
      await denied(operation);
  }
  const { insert, update, remove } = guarded.adapter;
  await insert!({ table: 'note', values: { id: 10, body: 'Detached direct insert' } });
  await update!({ table: 'note', key: { id: 10 }, values: { body: 'Detached direct update' } });
  await remove!({ table: 'note', key: { id: 10 } });
  assert.equal(await physical.get('operations')!.count('physical_note'), 2);
});

test('anchored facades refuse physical aliases, explicit default-source aliases and other owners on every method', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const guarded = authorizeResources(resources, access);
  const adapter = guarded.forConnection(owners.inventory);
  for (const table of ['note', 'physical_note', 'inventory.physical_note', 'operations.note', 'stock-db.note']) {
    const operations: Operation[] = [
      (tx: WriteTransaction) => tx.query(query(table)),
      (tx: WriteTransaction) => tx.count(table),
      (tx: WriteTransaction) => tx.insert({ table, values: { body: 'Wrong owner' } }),
      (tx: WriteTransaction) => tx.update({ table, key: { id: 1 }, values: { body: 'Wrong owner' } }),
      (tx: WriteTransaction) => tx.remove({ table, key: { id: 1 } }),
    ];
    for (const operation of operations) {
      await denied(() => operation(adapter as WriteTransaction));
      await denied(() => adapter.transaction!(operation));
    }
  }
  assert.equal(await physical.get('operations')!.count('physical_note'), 2);
  assert.equal(await physical.get('inventory')!.count('physical_note'), 2);
});

test('direct authorizeTransaction still refuses an arbitrary writer even when it is a real scoped transaction', async (t) => {
  const { resources, access, physical } = await fixture(t);
  const raw = physical.get('operations')!;
  const exercise = (writer: WriteTransaction) => {
    for (const rows of [access.rows, {}, { note: true }]) {
      assert.throws(() => authorizeTransaction(resources.schema, { ...access, rows }, writer), AppAccessDenied);
      assert.throws(() => authorizeTransaction(resources.schema, { ...access, rows, writable: new Set() }, writer), AppAccessDenied);
    }
  };
  exercise({} as WriteTransaction);
  await raw.transaction(async (tx) => exercise(tx));
  await raw.scopeTransaction({ physical_note: true }, async (tx) => exercise(tx));
  assert.equal(await raw.count('physical_note'), 2);
});
