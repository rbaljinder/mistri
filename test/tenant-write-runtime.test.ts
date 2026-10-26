import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations, TransactionOutcomeUnknown, type QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import { CommandTransactionFailure } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource, TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import {
  createTenantWriteRuntime,
  tenantInverseImages,
  type TenantRequestTransaction,
  type TenantWriteContext,
  type TenantWriteRuntimeOptions,
} from '../packages/mistri/src/server/tenant/tenantWriteRuntime.js';
import type { TenantInverseImages } from '../packages/mistri/src/server/tenant/tenantInverseImages.js';
import { createTenantRequestRuntime, type TenantRequestScope } from '../packages/mistri/src/server/tenant/tenantRequestRuntime.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

type Request = { cookie: string };
type Options = TenantWriteRuntimeOptions<Request>;
type Runtime = ReturnType<typeof createTenantWriteRuntime<Request>>;
const request = { cookie: 'alice' };
const binding = { appId: 'write-app', source: { id: 'business', connection: 'business-db' }, storeId: 'fixture' };
const resources = { item: 'db_item', private: 'db_private', country: 'db_country', local: 'db_local' };
const query = (extra: Partial<QueryRequest> = {}): QueryRequest => ({ table: 'item', limit: 20, offset: 0, ...extra });
const change = { table: 'item', key: { id: 'north-row' }, values: { name: 'Changed' } };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function safe(outcome: 'not_applied' | 'unknown') {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, 'The tenant write could not be completed.');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('PRIVATE_SENTINEL'), false);
    return true;
  };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-write-runtime-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  const runtimes: Runtime[] = [];
  db.exec(`CREATE TABLE db_item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT COLLATE NOCASE NOT NULL,
      name TEXT NOT NULL, secret TEXT DEFAULT 'PRIVATE_SENTINEL', letters INTEGER AS (length(name)),
      UNIQUE (tenant_id COLLATE BINARY, name));
    CREATE TABLE db_private (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT);
    CREATE TABLE db_country (code TEXT PRIMARY KEY NOT NULL, name TEXT);
    CREATE TABLE db_local (tenant_id TEXT NOT NULL, local_id INTEGER NOT NULL, name TEXT, PRIMARY KEY (tenant_id, local_id));
    INSERT INTO db_item (id, tenant_id, name) VALUES ('north-row', 'north', 'Original'), ('south-row', 'south', 'South'),
      ('alias-row', 'North', 'Alias');
    INSERT INTO db_private VALUES ('private-row', 'north', 'Private');
    INSERT INTO db_country VALUES ('us', 'Global');
    INSERT INTO db_local VALUES ('north', 1, 'North'), ('south', 1, 'South');`);
  provisionSqliteTenantStore(path, binding);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['editor'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, membershipId: `${tenantId}-alice` });
    }
  });
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      private: { kind: 'tenant', column: 'tenant_id' },
      local: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  let time = 1000,
    identity: Identity | null = { id: 'alice', who: 'Alice', role: 'admin' };
  const reader = openSqliteTenantReadSource(path, ownership, binding, () => time);
  const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => time);
  t.after(async () => {
    try {
      await Promise.all(runtimes.map((runtime) => runtime.retire()));
      await reader.close();
      await writer.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  /* Every bound resource is written; some carry a column ceiling. */
  const blocks = (bound: Record<string, string>, fields: Record<string, { read: string[]; write: string[] }>) =>
    Object.fromEntries(
      Object.entries(bound).map(([name, physical]) => [
        name,
        { physical, access: 'write' as const, ...(fields[name] ? { fields: fields[name] } : {}) },
      ]),
    );
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Write fixture',
      sources: { business: { connection: binding.source.connection } },
      resources: blocks(resources, {
        item: { read: ['id', 'name'], write: ['id', 'name'] },
        local: { read: ['tenant_id', 'local_id', 'name'], write: ['local_id', 'name'] },
      }),
      auth: {
        roles: { editor: { read: ['item', 'country', 'local'], write: ['item', 'country', 'local'] }, admin: { read: true, write: true } },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'tenant write test',
  );
  const rows: RowScope = { item: true, private: true, country: true, local: true };
  const options: Options = {
    app,
    reader,
    writer,
    deployment: 'deployment-1',
    roles: ['editor', 'admin'],
    maxLifetimeMs: 5000,
    verifySession: (input) => (input.cookie === 'alice' ? identity : null),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    now: () => time,
  };
  const issue = (overrides: Partial<Options> = {}) => {
    const runtime = createTenantWriteRuntime({ ...options, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  return {
    db,
    reader,
    writer,
    app,
    rows,
    options,
    issue,
    maintenance,
    grant,
    name: () => db.prepare('SELECT name FROM db_item WHERE id = ?').get('north-row')!.name,
    setTime: (value: number) => {
      time = value;
    },
    setIdentity: (value: Identity | null) => {
      identity = value;
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

test('request owns one field-authorized transaction with managed hidden ownership and no delete/history', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  let retained!: TenantRequestTransaction;
  const result = await runtime.transaction(request, ['north'], async ({ principal, schema, data }) => {
    retained = data;
    const created = await data.insert({ table: 'item', values: { id: 'new-row', name: 'New' } });
    await data.update(change);
    return {
      roles: principal.roles,
      schema,
      created,
      own: Reflect.ownKeys(data),
      rows: await data.query(query()),
      count: await data.count('country'),
    };
  });
  assert.deepEqual(Reflect.ownKeys(runtime).sort(), ['retire', 'transaction']);
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(retained));
  assert.ok(Object.isFrozen(result));
  assert.deepEqual([...result.roles], ['editor']);
  assert.deepEqual([...result.own].sort(), ['count', 'insert', 'query', 'update']);
  assert.deepEqual(result.schema.tables.map((table) => table.id).sort(), ['country', 'item', 'local']);
  const item = result.schema.tables.find((table) => table.id === 'item')!;
  assert.deepEqual(
    item.columns.map((column) => column.name),
    ['id', 'name'],
  );
  assert.equal(item.deletable, false);
  assert.deepEqual(plain(result.created), {
    key: { id: 'new-row' },
    row: { id: 'new-row', name: 'New' },
    applied: { id: 'new-row', name: 'New' },
    sql: { text: '', params: [] },
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  assert.deepEqual(plain(result.rows.sql), { text: '', params: [] });
  assert.deepEqual(result.rows.rows.map((row) => row.id).sort(), ['new-row', 'north-row']);
  assert.equal(result.count, 1);
  assert.equal(f.name(), 'Changed');
  assert.equal(f.db.prepare("SELECT tenant_id FROM db_item WHERE id='new-row'").get()!.tenant_id, 'north');
  await assert.rejects(retained.update(change), TenantContextError);
  await assert.rejects(retained.count('item'), TenantContextError);
});

const forbidden: Record<string, (tx: TenantRequestTransaction) => Promise<unknown>> = {
  'hidden projection': (tx) => tx.query(query({ columns: ['secret'] })),
  'hidden filter': (tx) => tx.count('item', { groups: [[{ column: 'secret', op: '=', value: 'PRIVATE_SENTINEL' }]] }),
  'hidden sort': (tx) => tx.query(query({ orderBy: [{ column: 'secret', direction: 'asc' }] })),
  'private resource': (tx) => tx.count('private'),
  'runtime resource': (tx) => tx.count('__mistri_tenant_membership'),
  'global insert': (tx) => tx.insert({ table: 'country', values: { code: 'ca', name: 'Canada' } }),
  'global update': (tx) => tx.update({ table: 'country', key: { code: 'us' }, values: { name: 'New' } }),
  'hidden value': (tx) => tx.update({ ...change, values: { secret: 'Edited' } }),
  'hidden original': (tx) => tx.update({ ...change, expected: { secret: 'PRIVATE_SENTINEL' } }),
  'ownership insert': (tx) => tx.insert({ table: 'item', values: { id: 'new', name: 'New', tenant_id: 'north' } }),
  'ownership update': (tx) => tx.update({ ...change, values: { tenant_id: 'north' } }),
  'cross-tenant key': (tx) => tx.update({ ...change, key: { id: 'south-row' } }),
  'case alias key': (tx) => tx.update({ ...change, key: { id: 'alias-row' } }),
  'cross-tenant original': (tx) => tx.update({ ...change, expected: { name: 'South' } }),
  'incomplete composite PK': (tx) => tx.update({ table: 'local', key: { local_id: 1 }, values: { name: 'New' } }),
  'managed composite PK supplied another owner': (tx) =>
    tx.update({ table: 'local', key: { tenant_id: 'south', local_id: 1 }, values: { name: 'New' } }),
};
for (const [name, operation] of Object.entries(forbidden)) {
  test(`caught ${name} refusal poisons and rolls back earlier effects`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    let rejected = false;
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        await data.update(change);
        try {
          await operation(data);
        } catch {
          rejected = true;
        }
        return 'must not release';
      }),
      safe('not_applied'),
    );
    assert.equal(rejected, true);
    assert.equal(f.name(), 'Original');
  });
}

for (const selectors of [[], ['north', 'south'], ['North'], ['north '], ['missing']]) {
  test(`selector ${JSON.stringify(selectors)} refuses before callback`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    let entered = false;
    await assert.rejects(
      runtime.transaction(request, selectors, () => {
        entered = true;
      }),
      safe('not_applied'),
    );
    assert.equal(entered, false);
  });
}

for (const stage of ['admission', 'operation', 'after effect'] as const) {
  test(`session loss at ${stage} never commits`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    let entered = false;
    if (stage === 'admission') f.setIdentity(null);
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        entered = true;
        if (stage === 'operation') f.setIdentity(null);
        await data.update(change);
        if (stage === 'after effect') f.setIdentity(null);
      }),
      safe('not_applied'),
    );
    assert.equal(entered, stage !== 'admission');
    assert.equal(f.name(), 'Original');
  });
}

for (const reason of ['expired', 'backwards', 'account changed', 'retired', 'callback data'] as const) {
  test(`${reason} after an effect rolls back rather than delivering output`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    let retirement: Promise<void> | undefined;
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        await data.update(change);
        if (reason === 'expired') f.setTime(6000);
        if (reason === 'backwards') f.setTime(999);
        if (reason === 'account changed') f.setIdentity({ id: 'bob', who: 'Bob' });
        if (reason === 'retired') retirement = runtime.retire();
        return reason === 'callback data' ? data : 'safe output';
      }),
      safe('not_applied'),
    );
    await retirement;
    assert.equal(f.name(), 'Original');
  });
}

test('membership revocation after admission and before writer acquisition refuses', async (t) => {
  const f = await fixture(t);
  const runtime = f.issue({
    resolveRows: async () => {
      await f.revoke();
      return f.rows;
    },
  });
  let entered = false;
  await assert.rejects(
    runtime.transaction(request, ['north'], () => {
      entered = true;
    }),
    safe('not_applied'),
  );
  assert.equal(entered, false);
  assert.equal(f.name(), 'Original');
});

test('membership and authored rows are both mandatory ceilings', async (t) => {
  const f = await fixture(t),
    runtime = f.issue({ resolveMembershipRows: () => ({ ...f.rows, item: false }) });
  const count = await runtime.transaction(request, ['north'], ({ data }) => data.count('item'));
  assert.equal(count, 0);
  await assert.rejects(
    runtime.transaction(request, ['north'], ({ data }) => data.update(change)),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

test('accepted unawaited operations drain and capture mutable inputs immediately', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  let queued: Promise<unknown> | undefined;
  const result = await runtime.transaction(request, ['north'], ({ data }) => {
    const input = { ...change, values: { name: 'Captured' } };
    queued = data.update(input);
    input.values.name = 'Mutated';
    return { ok: true };
  });
  await queued;
  assert.equal(result.ok, true);
  assert.equal(f.name(), 'Captured');
});

test('unawaited failure poisons completion even if its rejection is consumed', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  await assert.rejects(
    runtime.transaction(request, ['north'], async ({ data }) => {
      await data.update(change);
      void data.query(query({ columns: ['secret'] })).catch(() => {});
      return 'not delivered';
    }),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

test('retirement reserves pending authentication and drains before source closure', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let settled = false;
  const runtime = f.issue({
    verifySession: async () => {
      entered.release();
      await released.promise;
      return { id: 'alice', who: 'Alice' };
    },
  });
  const invocation = assert.rejects(
    runtime.transaction(request, ['north'], () => 'never'),
    safe('not_applied'),
  );
  await entered.promise;
  const retirement = runtime.retire();
  assert.equal(runtime.retire(), retirement);
  void retirement.then(() => {
    settled = true;
  });
  await assert.rejects(
    runtime.transaction(request, ['north'], () => 'never'),
    safe('not_applied'),
  );
  assert.equal(settled, false);
  released.release();
  await invocation;
  await retirement;
  assert.equal(settled, true);
  assert.equal(f.name(), 'Original');
});

for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
  for (const executed of [false, true]) {
    test(`${boundary} ${executed ? 'lost acknowledgment' : 'before execution'} remains unknown through request owner`, async (t) => {
      const f = await fixture(t),
        runtime = f.issue();
      const original = DatabaseSync.prototype.exec;
      let armed = false;
      const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
        if (armed && sql === boundary) {
          if (executed) original.call(this, sql);
          throw new Error('PRIVATE_SENTINEL');
        }
        return original.call(this, sql);
      });
      try {
        await assert.rejects(
          runtime.transaction(request, ['north'], async ({ data }) => {
            await data.update(change);
            armed = true;
            if (boundary === 'ROLLBACK') throw new Error('PRIVATE_SENTINEL');
          }),
          safe('unknown'),
        );
      } finally {
        mocked.mock.restore();
      }
      assert.equal(f.name(), boundary === 'COMMIT' && executed ? 'Changed' : 'Original');
    });
  }
}

/* The session, the lifetime and retirement are checked again after COMMIT; the
   membership is not: the transaction held it from BEGIN to COMMIT, and a
   revocation after that does not change what was committed (below). */
for (const reason of ['logout', 'retire', 'expired'] as const) {
  test(`${reason} after confirmed commit suppresses output but remains unknown`, async (t) => {
    const f = await fixture(t);
    let armed = false,
      retirement: Promise<void> | undefined;
    let runtime!: Runtime;
    runtime = f.issue({
      verifySession: async (input) => {
        if (armed && f.name() === 'Changed') {
          if (reason === 'logout') return null;
          if (reason === 'retire') retirement = runtime.retire();
          if (reason === 'expired') f.setTime(6000);
        }
        return f.options.verifySession(input);
      },
    });
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        await data.update(change);
        armed = true;
        return 'PRIVATE_SENTINEL';
      }),
      safe('unknown'),
    );
    await retirement;
    assert.equal(f.name(), 'Changed');
  });
}

test('revoked after confirmed commit is answered as committed: the fence held the membership to COMMIT', async (t) => {
  const f = await fixture(t);
  let armed = false;
  const runtime = f.issue({
    verifySession: async (input) => {
      if (armed && f.name() === 'Changed') await f.revoke();
      return f.options.verifySession(input);
    },
  });
  const answer = await runtime.transaction(request, ['north'], async ({ data }) => {
    await data.update(change);
    armed = true;
    return 'committed';
  });
  assert.equal(answer, 'committed');
  assert.equal(f.name(), 'Changed');
  // The next write is the revoked member's, and is refused before it changes anything.
  await assert.rejects(
    runtime.transaction(request, ['north'], async ({ data }) => data.update({ ...change, values: { name: 'Again' } })),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Changed');
});

for (const bad of [null, undefined, [], 'app', 1]) {
  test(`invalid runtime options ${JSON.stringify(bad)} have a classified safe refusal`, () => {
    assert.throws(() => createTenantWriteRuntime(bad as unknown as Options), safe('not_applied'));
  });
}

test('broad field grants hide non-key ownership in schemas, reads and insert replies', async (t) => {
  const f = await fixture(t);
  const app = {
    ...f.app,
    resources: Object.fromEntries(Object.entries(f.app.resources ?? {}).map(([name, { fields: _fields, ...block }]) => [name, block])),
  };
  const runtime = f.issue({ app });
  const schema = await runtime.transaction(request, ['north'], (context) => context.schema);
  assert.equal(
    schema.tables.find((table) => table.id === 'item')!.columns.some((column) => column.name === 'tenant_id'),
    false,
  );
  const result = await runtime.transaction(request, ['north'], async ({ data }) => ({
    created: await data.insert({ table: 'item', values: { id: 'new-broad', name: 'Broad' } }),
    rows: await data.query(query()),
  }));
  assert.equal(JSON.stringify(result).includes('tenant_id'), false);
  assert.equal(f.db.prepare("SELECT tenant_id FROM db_item WHERE id='new-broad'").get()!.tenant_id, 'north');
  await assert.rejects(
    runtime.transaction(request, ['north'], ({ data }) => data.query(query({ columns: ['tenant_id'] }))),
    safe('not_applied'),
  );
  await assert.rejects(
    runtime.transaction(request, ['north'], ({ data }) => data.update({ ...change, values: { tenant_id: 'north' } })),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

/* A column the database computes is the database's to write: a broad grant reads it and offers no write of it, and
   a write that names it is refused before the database is asked, as under a row policy. */
test('a generated column is read under a broad grant and never written', async (t) => {
  const f = await fixture(t);
  const app = {
    ...f.app,
    resources: Object.fromEntries(Object.entries(f.app.resources ?? {}).map(([name, { fields: _fields, ...block }]) => [name, block])),
  };
  const runtime = f.issue({ app });
  const letters = await runtime.transaction(request, ['north'], ({ schema }) =>
    schema.tables.find((table) => table.id === 'item')!.columns.find((column) => column.name === 'letters')!,
  );
  assert.equal(letters.writable, false);
  const rows = await runtime.transaction(request, ['north'], async ({ data }) => {
    await data.insert({ table: 'item', values: { id: 'counted', name: 'Seven!!' } });
    return (await data.query(query({ columns: ['id', 'letters'], filter: { groups: [[{ column: 'id', op: '=', value: 'counted' }]] } })))
      .rows;
  });
  assert.deepEqual(plain(rows), [{ id: 'counted', letters: 7 }]);
  await assert.rejects(
    runtime.transaction(request, ['north'], ({ data }) => data.update({ ...change, values: { letters: 99 } })),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

test('complete readable composite keys remain tenant-bound and owner fields immutable', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  await runtime.transaction(request, ['north'], async ({ data, schema }) => {
    const owner = schema.tables.find((table) => table.id === 'local')!.columns.find((column) => column.name === 'tenant_id')!;
    assert.equal(owner.primaryKey, true);
    assert.equal(owner.writable, false);
    await data.update({ table: 'local', key: { tenant_id: 'north', local_id: 1 }, values: { name: 'Changed' } });
    const inserted = await data.insert({ table: 'local', values: { local_id: 2, name: 'Created' } });
    assert.deepEqual(plain(inserted.key), { tenant_id: 'north', local_id: 2 });
  });
  assert.deepEqual(plain(f.db.prepare('SELECT * FROM db_local ORDER BY tenant_id, local_id').all()), [
    { tenant_id: 'north', local_id: 1, name: 'Changed' },
    { tenant_id: 'north', local_id: 2, name: 'Created' },
    { tenant_id: 'south', local_id: 1, name: 'South' },
  ]);
});

test('hidden composite owner PK fails construction without broadening ordinary field rules', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.issue({
        app: {
          ...f.app,
          resources: { ...f.app.resources, local: { ...f.app.resources?.local, fields: { read: ['local_id', 'name'], write: ['name'] } } },
        },
      }),
    safe('not_applied'),
  );
  // Failed construction never takes ownership of the caller's sources.
  assert.equal(await f.issue().transaction(request, ['north'], ({ data }) => data.count('item')), 1);
});

test('selectors, authored rows and callback result are captured across awaits', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  const selectors = ['north'];
  const runtime = f.issue({
    verifySession: async (input) => {
      entered.release();
      await released.promise;
      return f.options.verifySession(input);
    },
  });
  const running = runtime.transaction(request, selectors, ({ data }) => data.count('item'));
  await entered.promise;
  selectors[0] = 'south';
  released.release();
  assert.equal(await running, 1);
  const output = { value: 'Captured' };
  const captured = await runtime.transaction(request, ['north'], () => {
    queueMicrotask(() => {
      output.value = 'Changed';
    });
    return output;
  });
  assert.equal(captured.value, 'Captured');
});

test('authored policy independently denies writes and cannot bypass membership ceiling', async (t) => {
  const f = await fixture(t),
    runtime = f.issue({ resolveRows: () => ({ ...f.rows, item: false }) });
  assert.equal(await runtime.transaction(request, ['north'], ({ data }) => data.count('item')), 0);
  await assert.rejects(
    runtime.transaction(request, ['north'], ({ data }) => data.update(change)),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

for (const shape of ['getter', 'proxy', 'thenable', 'cycle'] as const) {
  test(`accepted ${shape} request refuses without evaluating hooks and poisons prior writes`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    let traps = 0;
    let input: unknown;
    if (shape === 'getter')
      input = {
        ...change,
        get values() {
          traps++;
          return { name: 'Bad' };
        },
      };
    if (shape === 'proxy')
      input = new Proxy(change, {
        ownKeys(target) {
          traps++;
          return Reflect.ownKeys(target);
        },
      });
    // Deliberately malformed provider data must never be assimilated.
    if (shape === 'thenable')
      input = {
        ...change,
        // eslint-disable-next-line unicorn/no-thenable
        then() {
          traps++;
        },
      };
    if (shape === 'cycle') {
      input = { ...change };
      (input as { values: unknown }).values = input;
    }
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        await data.update(change);
        await data.update(input as typeof change).catch(() => {});
      }),
      safe('not_applied'),
    );
    assert.equal(traps, 0);
    assert.equal(f.name(), 'Original');
  });
}

for (const field of ['verifySession', 'resolveRows', 'resolveMembershipRows', 'authorizeDeletedRecord', 'now'] as const) {
  test(`${field} option accessors are not executed at construction`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const options = { ...f.options };
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        calls++;
        return () => {};
      },
    });
    assert.throws(() => createTenantWriteRuntime(options), safe('not_applied'));
    assert.equal(calls, 0);
  });
}

for (const value of [
  null,
  undefined,
  4,
  {
    // eslint-disable-next-line unicorn/no-thenable
    then() {
      throw new Error('must not run');
    },
  },
]) {
  test(`invalid session delivery ${String(value)} cannot enter a business callback`, async (t) => {
    const f = await fixture(t);
    let entered = false;
    const runtime = f.issue({ verifySession: () => value as unknown as Identity });
    await assert.rejects(
      runtime.transaction(request, ['north'], () => {
        entered = true;
      }),
      safe('not_applied'),
    );
    assert.equal(entered, false);
  });
}

test('a retained facade rejects work while final session verification is pending', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let afterCallback = false;
  const runtime = f.issue({
    verifySession: async (input) => {
      if (afterCallback) {
        entered.release();
        await released.promise;
      }
      return f.options.verifySession(input);
    },
  });
  let retained!: TenantRequestTransaction;
  const pending = runtime.transaction(request, ['north'], ({ data }) => {
    retained = data;
    afterCallback = true;
    return 'done';
  });
  await entered.promise;
  await assert.rejects(retained.update(change), TenantContextError);
  released.release();
  assert.equal(await pending, 'done');
  assert.equal(f.name(), 'Original');
});

test('admission completion clock high-water mark survives the request-owner handoff', async (t) => {
  const f = await fixture(t),
    times = [1000, 1000, 1000, 1500, 1400];
  let entered = false;
  const runtime = f.issue({ now: () => times.shift() ?? 1600 });
  await assert.rejects(
    runtime.transaction(request, ['north'], async ({ data }) => {
      entered = true;
      await data.update(change);
    }),
    safe('not_applied'),
  );
  assert.equal(entered, false);
  assert.equal(f.name(), 'Original');
});

test('deployment clock high-water mark is not reset for a later request', async (t) => {
  const f = await fixture(t);
  let time = 2000;
  f.setTime(2000);
  const runtime = f.issue({ now: () => time });
  assert.equal(await runtime.transaction(request, ['north'], ({ data }) => data.count('item')), 1);
  time = 1900;
  let entered = false;
  await assert.rejects(
    runtime.transaction(request, ['north'], () => {
      entered = true;
    }),
    safe('not_applied'),
  );
  assert.equal(entered, false);
});

test('inverse access is genuine-context only, without inspecting fabricated evidence', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  let traps = 0;
  await runtime.transaction(request, ['north'], (context) => {
    assert.deepEqual(Object.keys(context).sort(), ['data', 'principal', 'schema']);
    assert.deepEqual(Object.keys(context.data).sort(), ['count', 'insert', 'query', 'update']);
    assert.equal(typeof tenantInverseImages(context).capture, 'function');
    for (const fake of [
      { ...context },
      Object.create(context),
      new Proxy(context, {
        get() {
          traps++;
          throw new Error('must not inspect');
        },
        ownKeys() {
          traps++;
          throw new Error('must not inspect');
        },
      }),
    ])
      assert.throws(() => tenantInverseImages(fake), TenantContextError);
  });
  assert.equal(traps, 0);
});

test('retained inverse accessor and methods close before final session verification', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let afterCallback = false;
  const runtime = f.issue({
    authorizeDeletedRecord: () => true,
    verifySession: async (input) => {
      if (afterCallback) {
        entered.release();
        await released.promise;
      }
      return f.options.verifySession(input);
    },
  });
  let retained!: TenantWriteContext, images!: TenantInverseImages;
  const pending = runtime.transaction(request, ['north'], (context) => {
    retained = context;
    images = tenantInverseImages(context);
    afterCallback = true;
  });
  await entered.promise;
  assert.throws(() => tenantInverseImages(retained), TenantContextError);
  await assert.rejects(images.capture({ table: 'local', key: { tenant_id: 'north', local_id: 1 } }), TenantContextError);
  await assert.rejects(images.removeCurrent({ table: 'local', key: { tenant_id: 'north', local_id: 1 } }), TenantContextError);
  released.release();
  await pending;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM db_local').get()!.n, 2);
});

test('an accepted unawaited inverse operation drains before commit', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  const runtime = f.issue({
    authorizeDeletedRecord: async () => {
      entered.release();
      await released.promise;
      return true;
    },
  });
  let operation!: Promise<unknown>,
    settled = false;
  const pending = runtime
    .transaction(request, ['north'], (context) => {
      operation = tenantInverseImages(context).removeCurrent({ table: 'local', key: { tenant_id: 'north', local_id: 1 } });
    })
    .then(() => {
      settled = true;
    });
  await entered.promise;
  assert.equal(settled, false);
  released.release();
  await pending;
  await operation;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM db_local').get()!.n, 1);
});

test('a caught private inverse refusal poisons earlier ordinary writes', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  await assert.rejects(
    runtime.transaction(request, ['north'], async (context) => {
      await context.data.update(change);
      await tenantInverseImages(context)
        .removeCurrent({ table: 'local', key: { tenant_id: 'north', local_id: 1 } })
        .catch(() => {});
    }),
    safe('not_applied'),
  );
  assert.equal(f.name(), 'Original');
});

test('shared request owner permits one actual transaction; a caught second attempt cannot claim rollback of the first', async (t) => {
  const f = await fixture(t),
    owner = createTenantRequestRuntime(f.options);
  try {
    await assert.rejects(
      owner.run(request, ['north'], async (scope) => {
        await scope.transaction((records) => records.update(change));
        await scope.transaction((records) => records.update({ ...change, values: { name: 'Second' } })).catch(() => {});
        return 'cannot publish success';
      }),
      safe('unknown'),
    );
    assert.equal(f.name(), 'Changed');
  } finally {
    await owner.retire();
  }
});

test('shared request owner drains an accepted unawaited transaction but refuses retained acceptance', async (t) => {
  const f = await fixture(t),
    owner = createTenantRequestRuntime(f.options),
    entered = gate(),
    released = gate();
  let retained!: TenantRequestScope,
    settled = false;
  const pending = owner
    .run(request, ['north'], (scope) => {
      retained = scope;
      void scope.transaction(async (records) => {
        entered.release();
        await released.promise;
        return records.update(change);
      });
      return 'done';
    })
    .then((value) => {
      settled = true;
      return value;
    });
  try {
    await entered.promise;
    assert.equal(settled, false);
    await assert.rejects(
      retained.transaction((records) => records.update(change)),
      safe('not_applied'),
    );
    await assert.rejects(
      retained.commandTransaction(() => 'must not run', ['item']),
      safe('not_applied'),
    );
    released.release();
    assert.equal(await pending, 'done');
    assert.equal(f.name(), 'Changed');
  } finally {
    released.release();
    await pending.catch(() => {});
    await owner.retire();
  }
});

test('shared request owner captures callback output before a following mutation microtask', async (t) => {
  const f = await fixture(t),
    owner = createTenantRequestRuntime(f.options),
    value = { state: 'original' };
  try {
    const result = await owner.run(request, ['north'], () => {
      queueMicrotask(() => {
        value.state = 'mutated';
      });
      return value;
    });
    assert.equal(result.state, 'original');
    assert.ok(Object.isFrozen(result));
  } finally {
    await owner.retire();
  }
});

const callbackUnknowns = {
  native: () => new TransactionOutcomeUnknown(new Error('PRIVATE_SENTINEL native uncertainty')),
  command: () => new CommandTransactionFailure(new Error('PRIVATE_SENTINEL command uncertainty'), 'unknown'),
  source: () => new TenantWriteFailure('unknown'),
};
for (const [kind, failure] of Object.entries({ ...callbackUnknowns, known: () => new TenantWriteFailure('not_applied') })) {
  test(`ordinary write facade preserves ${kind} callback outcome after a caught malformed operation`, async (t) => {
    const f = await fixture(t),
      runtime = f.issue();
    await assert.rejects(
      runtime.transaction(request, ['north'], async ({ data }) => {
        await data.update(change);
        // Capture refuses NaN before queue execution, but the accepted operation
        // still poisons this facade's drain even though the callback catches it.
        await assert.rejects(data.update({ ...change, values: { name: NaN } }), TenantContextError);
        throw failure();
      }),
      safe(kind === 'known' ? 'not_applied' : 'unknown'),
    );
    assert.equal(f.name(), 'Original');
    assert.equal(f.db.isTransaction, false);
  });
}
for (const [kind, unknown] of Object.entries(callbackUnknowns)) {
  test(`shared request owner preserves ${kind} callback uncertainty over an earlier known drain failure`, async (t) => {
    const f = await fixture(t),
      owner = createTenantRequestRuntime(f.options);
    try {
      await assert.rejects(
        owner.run(request, ['north'], async (scope) => {
          await assert.rejects(
            scope.transaction(async (records) => {
              await records.update(change);
              throw new Error('PRIVATE_SENTINEL confirmed rollback');
            }),
            safe('not_applied'),
          );
          // This is after actual source completion, not a fake transaction or
          // an injected raw handle. finish() still retains the known rejection.
          assert.equal(f.name(), 'Original');
          throw unknown();
        }),
        safe('unknown'),
      );
      assert.equal(f.name(), 'Original');
      assert.equal(f.db.isTransaction, false);
    } finally {
      await owner.retire();
    }
  });
}

test('shared request owner preserves unknown drain outcome over a later ordinary callback failure', async (t) => {
  const f = await fixture(t),
    owner = createTenantRequestRuntime(f.options);
  try {
    await assert.rejects(
      owner.run(request, ['north'], async (scope) => {
        await assert.rejects(
          scope.transaction(async (records) => {
            await records.update(change);
            throw new TransactionOutcomeUnknown(new Error('PRIVATE_SENTINEL native uncertainty'));
          }),
          safe('unknown'),
        );
        throw new Error('PRIVATE_SENTINEL later ordinary refusal');
      }),
      safe('unknown'),
    );
    assert.equal(f.name(), 'Original');
  } finally {
    await owner.retire();
  }
});

test('shared request owner does not invent uncertainty when both drain and callback failures are known', async (t) => {
  const f = await fixture(t),
    owner = createTenantRequestRuntime(f.options);
  try {
    await assert.rejects(
      owner.run(request, ['north'], async (scope) => {
        await assert.rejects(
          scope.transaction(async (records) => {
            await records.update(change);
            throw new Error('PRIVATE_SENTINEL confirmed rollback');
          }),
          safe('not_applied'),
        );
        throw new TenantWriteFailure('not_applied');
      }),
      safe('not_applied'),
    );
    assert.equal(f.name(), 'Original');
  } finally {
    await owner.retire();
  }
});
