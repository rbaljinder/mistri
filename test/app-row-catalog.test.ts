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
  type InsertRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeResources, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';

const owner = 'catalog-test-db';
const aliases = { note: 'physical_note', parent: 'physical_parent', child: 'physical_child' };
const fieldGrant = (read: string[], write = read) => ({ read: new Set(read), write: new Set(write) });
const denied = (run: () => unknown) => assert.rejects(async () => run(), Refusal);
type Operation = (tx: WriteTransaction) => Promise<unknown>;
type Mode = 'direct' | 'transaction';
const modes: Mode[] = ['direct', 'transaction'];
const invoke = (adapter: Adapter, mode: Mode, run: Operation) =>
  mode === 'transaction' ? adapter.transaction!(run) : run(adapter as WriteTransaction);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-row-catalog-'));
  const file = join(directory, 'catalog.db');
  const db = new DatabaseSync(file);
  const physical = new SqliteAdapter(file, 'catalog');
  t.after(async () => {
    try {
      await physical.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT,
      tenant INTEGER NOT NULL DEFAULT 1, secret TEXT DEFAULT 'private');
    CREATE TABLE physical_parent (id INTEGER PRIMARY KEY, name TEXT,
      tenant INTEGER NOT NULL DEFAULT 1, private_code TEXT UNIQUE);
    CREATE TABLE physical_child (id INTEGER PRIMARY KEY, title TEXT,
      tenant INTEGER NOT NULL DEFAULT 1, owner_id INTEGER REFERENCES physical_parent(id));
    INSERT INTO physical_note VALUES (1, 'Original', 1, 'private'), (2, 'Other tenant', 2, 'hidden');
    INSERT INTO physical_parent VALUES (1, 'Parent', 1, 'private-key');
    INSERT INTO physical_child VALUES (1, 'Original child', 1, NULL);
  `);
  const refresh = async (): Promise<RuntimeResources> => {
    const local = createAppResources(physical, await physical.introspect(), aliases);
    return {
      ...local,
      connections: [owner],
      connectionFor: (resource) => {
        local.toPhysical(resource);
        return owner;
      },
      toLogicalAt: (table, connection) => {
        if (connection !== owner) throw new Refusal('Wrong owner');
        return local.toLogical(table);
      },
      forConnection: (connection) => {
        if (connection !== owner) throw new Refusal('Wrong owner');
        return local.adapter;
      },
    };
  };
  const resources = await refresh();
  const access = {
    readable: new Set(['note', 'parent', 'child']),
    writable: new Set(['note', 'child']),
    rows: Object.fromEntries(
      resources.schema.tables.map((table) => [table.id, { groups: [[{ column: 'tenant', op: '=' as const, value: 1 }]] }]),
    ),
    fields: new Map(
      resources.schema.tables.map((table) => [
        table.id,
        table.id === 'parent' ? fieldGrant(['id', 'name', 'tenant'], []) : fieldGrant(table.columns.map((column) => column.name)),
      ]),
    ),
  } satisfies ResourceAccess;
  const notes = () => db.prepare('SELECT * FROM physical_note ORDER BY id').all();
  const child = () => db.prepare('SELECT * FROM physical_child WHERE id = 1').get()!;
  return { db, physical, resources, access, refresh, notes, child };
}

// Pause the capability before writer acquisition, while retaining the real
// SQLite transaction and logical-resource mapping on the other side of it.
function delayed(resources: RuntimeResources) {
  const waiting = gate();
  const entered = gate();
  const wrap = (adapter: Adapter): Adapter => ({
    ...adapter,
    scopeTransaction: async (scope, run) => {
      entered.release();
      await waiting.promise;
      return adapter.scopeTransaction!(scope, run);
    },
  });
  return {
    waiting,
    entered,
    resources: {
      ...resources,
      adapter: wrap(resources.adapter),
      forConnection: (connection: string) => wrap(resources.forConnection(connection)),
    },
  };
}

for (const mode of modes) {
  test(`${mode}: a late column prevents deletion under the old complete field grant`, async (t) => {
    const { db, resources, access, notes } = await fixture(t);
    const guarded = authorizeResources(resources, access).adapter;
    db.exec('ALTER TABLE physical_note ADD COLUMN newly_private TEXT');
    const before = notes();
    let callback = false;
    await denied(() =>
      invoke(guarded, mode, (tx) => {
        callback = true;
        return tx.remove({ table: 'note', key: { id: 1 } });
      }),
    );
    if (mode === 'transaction') assert.equal(callback, false, 'Catalog refusal precedes application code');
    assert.deepEqual(notes(), before);
  });

  test(`${mode}: a new nullable FK to a hidden parent field prevents an unrelated child update`, async (t) => {
    const { db, resources, access, child } = await fixture(t);
    const guarded = authorizeResources(resources, access).adapter;
    db.exec('ALTER TABLE physical_child ADD COLUMN private_link TEXT REFERENCES physical_parent(private_code)');
    assert.equal(child().private_link, null, 'Physical null-parent checks alone would permit this update');
    assert.ok(!resources.schema.foreignKeys.some((fk) => fk.to.columns.includes('private_code')));
    let callback = false;
    await denied(() =>
      invoke(guarded, mode, (tx) => {
        callback = true;
        return tx.update({ table: 'child', key: { id: 1 }, values: { title: 'Must not apply' } });
      }),
    );
    if (mode === 'transaction') assert.equal(callback, false);
    assert.equal(child().title, 'Original child');
  });
}

test('DDL queued before scoped writer acquisition is attested before the application callback', async (t) => {
  const { physical, resources, access, db, notes } = await fixture(t);
  const guarded = authorizeResources(resources, access).adapter;
  const held = gate();
  const entered = gate();
  const holder = physical.transaction(async () => {
    entered.release();
    await held.promise;
    // Test-only DDL on the earlier lease makes the queue ordering deterministic
    // without opening an external writer that would block this process.
    const writer = Reflect.get(physical, 'writeDb') as DatabaseSync;
    writer.exec('ALTER TABLE physical_note ADD COLUMN queued_private TEXT');
  });
  await entered.promise;
  let callback = false;
  try {
    const refused = denied(() =>
      guarded.transaction!(async (tx) => {
        callback = true;
        await tx.remove({ table: 'note', key: { id: 1 } });
      }),
    );
    held.release();
    const results = await Promise.allSettled([holder, refused]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    held.release();
    await holder;
  }
  assert.ok(
    db
      .prepare('PRAGMA table_info(physical_note)')
      .all()
      .some((column) => column.name === 'queued_private'),
  );
  assert.equal(callback, false);
  assert.equal(notes().length, 2);
});

for (const mode of modes) {
  test(`${mode}: missing scoped catalog evidence denies before callback or mutation without ordinary fallback`, async (t) => {
    const { resources, access, notes } = await fixture(t);
    let fallback = 0;
    let capability = 0;
    const unsafe = () => {
      fallback++;
      throw new Error('Ordinary fallback');
    };
    const wrap = (adapter: Adapter): Adapter => ({
      ...adapter,
      transaction: unsafe,
      insert: unsafe,
      update: unsafe,
      remove: unsafe,
      scopeTransaction: (scope, run) => {
        capability++;
        return adapter.scopeTransaction!(scope, (tx) => (run as unknown as (records: WriteTransaction) => ReturnType<typeof run>)(tx));
      },
    });
    const guarded = authorizeResources(
      { ...resources, adapter: wrap(resources.adapter), forConnection: (connection) => wrap(resources.forConnection(connection)) },
      access,
    ).adapter;
    const before = notes();
    let callback = false;
    await denied(() =>
      invoke(guarded, mode, (tx) => {
        callback = true;
        return tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Must not apply' } });
      }),
    );
    if (mode === 'transaction') assert.equal(callback, false);
    assert.equal(capability, 1);
    assert.equal(fallback, 0);
    assert.deepEqual(notes(), before);
  });

  for (const change of ['field read set', 'field write set', 'field map', 'parent resource'] as const) {
    test(`${mode}: widening ${change} during acquisition cannot widen invocation-owned grants`, async (t) => {
      const { resources, access, notes, child } = await fixture(t);
      if (change === 'parent resource') access.readable.delete('parent');
      else {
        access.fields.set('note', fieldGrant(['id', 'body', 'tenant'], ['body']));
        if (change === 'field read set') access.fields.get('note')!.write.add('secret');
        if (change === 'field write set') access.fields.get('note')!.read.add('secret');
      }
      const paused = delayed(resources);
      const guarded = authorizeResources(paused.resources, access).adapter;
      const before = notes();
      const refused = denied(() =>
        invoke(guarded, mode, (tx) =>
          change === 'parent resource'
            ? tx.update({ table: 'child', key: { id: 1 }, values: { owner_id: 1 } })
            : tx.update({ table: 'note', key: { id: 1 }, values: { secret: 'Must not apply' } }),
        ),
      );
      try {
        await paused.entered.promise;
        if (change === 'parent resource') access.readable.add('parent');
        else if (change === 'field map') access.fields.delete('note');
        else {
          access.fields.get('note')!.read.add('secret');
          access.fields.get('note')!.write.add('secret');
        }
      } finally {
        paused.waiting.release();
      }
      await refused;
      assert.deepEqual(notes(), before);
      assert.equal(child().title, 'Original child');
    });
  }
}

test('a transaction owns its writable resource set before waiting', async (t) => {
  const { resources, access, child } = await fixture(t);
  access.writable.delete('child');
  const paused = delayed(resources);
  const guarded = authorizeResources(paused.resources, access).adapter;
  const refused = denied(() =>
    guarded.transaction!((tx) => tx.update({ table: 'child', key: { id: 1 }, values: { title: 'Must not apply' } })),
  );
  try {
    await paused.entered.promise;
    access.writable.add('child');
  } finally {
    paused.waiting.release();
  }
  await refused;
  assert.equal(child().title, 'Original child');
});

for (const mode of modes) {
  for (const change of ['readable resource', 'writable resource', 'field set', 'field map'] as const) {
    test(`${mode}: ${change} revocation before a later invocation is honored`, async (t) => {
      const { resources, access, notes } = await fixture(t);
      const guarded = authorizeResources(resources, access).adapter;
      await invoke(guarded, mode, (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'First allowed' } }));
      if (change === 'readable resource') access.readable.delete('note');
      else if (change === 'writable resource') access.writable.delete('note');
      else if (change === 'field set') access.fields.get('note')!.write.delete('body');
      else access.fields.set('note', fieldGrant(['id', 'body', 'tenant', 'secret'], []));
      const before = notes();
      await denied(() => invoke(guarded, mode, (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Revoked' } })));
      assert.deepEqual(notes(), before);
    });
  }
}

test('mutating the original catalog while awaiting evidence cannot rewrite the facade baseline', async (t) => {
  const { db, resources, access, refresh, notes } = await fixture(t);
  const paused = delayed(resources);
  const guarded = authorizeResources(paused.resources, access).adapter;
  let callback = false;
  const refused = denied(() =>
    guarded.transaction!(async (tx) => {
      callback = true;
      await tx.remove({ table: 'note', key: { id: 1 } });
    }),
  );
  try {
    await paused.entered.promise;
    db.exec('ALTER TABLE physical_note ADD COLUMN newly_private TEXT');
    const fresh = await refresh();
    // Preserve the caller's original table object and mutate its nested array.
    resources.schema.tables
      .find((table) => table.id === 'note')!
      .columns.splice(0, Infinity, ...fresh.schema.tables.find((table) => table.id === 'note')!.columns);
  } finally {
    paused.waiting.release();
  }
  await refused;
  assert.equal(callback, false);
  assert.equal(notes().length, 2);
});

for (const mode of modes) {
  test(`${mode}: an initially read-only facade cannot adopt a mutated catalog when a later grant enables an anchored writer`, async (t) => {
    const { db, resources, access, refresh, notes } = await fixture(t);
    access.writable.clear();
    const paused = delayed(resources);
    const guarded = authorizeResources(paused.resources, access);
    assert.equal(guarded.adapter.update, undefined);
    assert.equal(guarded.forConnection(owner).update, undefined);
    access.writable.add('note');
    const anchored = guarded.forConnection(owner);
    assert.equal(typeof anchored.update, 'function');
    db.exec('ALTER TABLE physical_note ADD COLUMN newly_private TEXT');
    const fresh = await refresh();
    // Change the caller catalog before invocation too: otherwise even an
    // incorrectly invocation-captured baseline would detect the intervening DDL.
    resources.schema.tables
      .find((table) => table.id === 'note')!
      .columns.splice(0, Infinity, ...fresh.schema.tables.find((table) => table.id === 'note')!.columns);
    const before = notes();
    let callback = false;
    const refused = denied(() =>
      invoke(anchored, mode, (tx) => {
        callback = true;
        return tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Must not apply' } });
      }),
    );
    try {
      await paused.entered.promise;
    } finally {
      paused.waiting.release();
    }
    await refused;
    if (mode === 'transaction') assert.equal(callback, false);
    assert.deepEqual(notes(), before);
  });

  test(`${mode}: a later anchored writer cannot delete a hidden field removed from the caller catalog during acquisition`, async (t) => {
    const { resources, access, notes } = await fixture(t);
    access.writable.clear();
    access.fields.set('note', fieldGrant(['id', 'body', 'tenant']));
    const paused = delayed(resources);
    const guarded = authorizeResources(paused.resources, access);
    access.writable.add('note');
    const anchored = guarded.forConnection(owner);
    const before = notes();
    const refused = denied(() => invoke(anchored, mode, (tx) => tx.remove({ table: 'note', key: { id: 1 } })));
    try {
      await paused.entered.promise;
      const columns = resources.schema.tables.find((table) => table.id === 'note')!.columns;
      columns.splice(
        columns.findIndex((column) => column.name === 'secret'),
        1,
      );
    } finally {
      paused.waiting.release();
    }
    await refused;
    assert.deepEqual(notes(), before);
  });

  test(`${mode}: an unchanged catalog permits a later anchored write grant and honors subsequent revocation`, async (t) => {
    const { resources, access, notes } = await fixture(t);
    access.writable.clear();
    const guarded = authorizeResources(resources, access);
    assert.equal(guarded.adapter.update, undefined);
    assert.equal(guarded.forConnection(owner).update, undefined);
    access.writable.add('note');
    const anchored = guarded.forConnection(owner);
    await invoke(anchored, mode, (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Later grant' } }));
    assert.equal(notes().find((row) => row.id === 1)!.body, 'Later grant');
    access.writable.delete('note');
    const before = notes();
    await denied(() => invoke(anchored, mode, (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Revoked' } })));
    assert.deepEqual(notes(), before);
    assert.equal(guarded.forConnection(owner).update, undefined);
  });
}

test('refreshing catalog and grants and constructing a new facade restores valid scoped writes', async (t) => {
  const { db, resources, access, refresh, notes, child } = await fixture(t);
  const old = authorizeResources(resources, access).adapter;
  db.exec(`ALTER TABLE physical_note ADD COLUMN newly_private TEXT;
    ALTER TABLE physical_child ADD COLUMN private_link TEXT REFERENCES physical_parent(private_code);`);
  const fresh = await refresh();
  const staleGrants = authorizeResources(fresh, access).adapter;
  await denied(() => staleGrants.remove!({ table: 'note', key: { id: 1 } }));
  await denied(() => staleGrants.update!({ table: 'child', key: { id: 1 }, values: { private_link: 'private-key' } }));
  const refreshedAccess = {
    ...access,
    fields: new Map(fresh.schema.tables.map((table) => [table.id, fieldGrant(table.columns.map((column) => column.name))])),
  };
  const current = authorizeResources(fresh, refreshedAccess).adapter;
  await current.transaction!(async (tx) => {
    await tx.update({ table: 'child', key: { id: 1 }, values: { title: 'Refreshed' } });
    await tx.remove({ table: 'note', key: { id: 1 } });
  });
  assert.equal(child().title, 'Refreshed');
  assert.deepEqual(
    notes().map((row) => row.id),
    [2],
  );
  await denied(() =>
    old.transaction!(async () => {
      assert.fail('Old facade must remain stale');
    }),
  );
});

for (const method of ['insert', 'update', 'remove'] as const) {
  test(`direct ${method} snapshots its request before awaiting catalog evidence`, async (t) => {
    const { resources, access, notes, child } = await fixture(t);
    const paused = delayed(resources);
    const guarded = authorizeResources(paused.resources, access).adapter;
    const insert: InsertRequest = { table: 'note', values: { id: 10, body: 'Captured insert' } };
    const update: UpdateRequest = { table: 'note', key: { id: 1 }, values: { body: 'Captured update' }, expected: { body: 'Original' } };
    const remove: DeleteRequest = { table: 'note', key: { id: 1 } };
    const pending = method === 'insert' ? guarded.insert!(insert) : method === 'update' ? guarded.update!(update) : guarded.remove!(remove);
    try {
      await paused.entered.promise;
      insert.table = 'child';
      insert.values.id = 20;
      insert.values.body = 'Changed';
      update.table = 'child';
      update.key.id = 2;
      update.values.body = 'Changed';
      update.expected!.body = 'Other tenant';
      remove.table = 'child';
      remove.key.id = 2;
    } finally {
      paused.waiting.release();
    }
    await pending;
    const rows = notes();
    if (method === 'insert') assert.equal(rows.find((row) => row.id === 10)!.body, 'Captured insert');
    if (method === 'update') assert.equal(rows.find((row) => row.id === 1)!.body, 'Captured update');
    if (method === 'remove')
      assert.deepEqual(
        rows.map((row) => row.id),
        [2],
      );
    assert.equal(rows.find((row) => row.id === 2)!.body, 'Other tenant');
    assert.equal(child().title, 'Original child');
  });
}

for (const method of ['insert', 'remove'] as const) {
  test(`direct ${method} owns field grants before waiting and honors revocation before invocation`, async (t) => {
    const { resources, access, notes } = await fixture(t);
    const paused = delayed(resources);
    const guarded = authorizeResources(paused.resources, access).adapter;
    const operation = () =>
      method === 'insert'
        ? guarded.insert!({ table: 'note', values: { id: 10, body: 'Denied' } })
        : guarded.remove!({ table: 'note', key: { id: 1 } });
    access.fields.get('note')!.write.delete('body');
    const before = notes();
    const refused = denied(operation);
    try {
      await paused.entered.promise;
      access.fields.get('note')!.write.add('body');
    } finally {
      paused.waiting.release();
    }
    await refused;
    assert.deepEqual(notes(), before);
    access.fields.get('note')!.write.delete('body');
    await denied(operation);
    assert.deepEqual(notes(), before);
  });
}
