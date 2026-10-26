import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import type { ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import { captureTenantData, TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  createTenantInverseImages,
  type TenantDeletedRecordPolicy,
  type TenantHistoryImage,
  type TenantInverseImages,
} from '../packages/mistri/src/server/tenant/tenantInverseImages.js';
import { runTenantManagedTransaction } from '../packages/mistri/src/server/tenant/tenantManagedTransaction.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { composeTenantReadScope } from '../packages/mistri/src/server/tenant/tenantReadScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';

const principal: TenantMembershipEvidence = {
  appId: 'app',
  source: { id: 'business', connection: 'owned' },
  accountId: 'alice',
  tenantId: 'north',
  deployment: 'deployment',
  membershipId: 'grant',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['editor'],
  verifiedAt: 100,
  validUntil: 1000,
};
const request = (): DeleteRequest => ({ table: 'item', key: { id: 'one' } });
const row = () => ({ id: 'one', tenant_id: 'north', name: 'Original', amount: 1, optional: null });
const image = (): TenantHistoryImage => ({ ...request(), row: row() });
const sql = { text: 'PRIVATE_SQL_SENTINEL', params: ['PRIVATE_OWNER'] };
function ownership(): TenantOwnershipSnapshot {
  const schema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'Test',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: 'main',
        isView: false,
        columns: [
          { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
          { name: 'tenant_id', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'amount', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'optional', type: 'TEXT', nullable: true, primaryKey: false },
        ],
      },
    ],
  };
  return captureTenantOwnership({
    appId: principal.appId,
    source: principal.source,
    schema,
    physicalSchema: schema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
}
function access(owned = ownership()): ResourceAccess {
  return {
    readable: new Set(Object.keys(owned.resources)),
    writable: new Set(Object.keys(owned.resources)),
    fields: new Map(
      owned.schema.tables.map((table) => [
        table.id,
        {
          read: new Set(table.columns.filter((column) => column.name !== 'tenant_id' || column.primaryKey).map((column) => column.name)),
          write: new Set(table.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name)),
        },
      ]),
    ),
  };
}
function harness() {
  const operations = new TransactionOperations();
  let active = true,
    calls = 0;
  const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>): Promise<R> => {
    calls++;
    if (!active) return Promise.reject(new TenantContextError());
    let captured!: A, invalid: { error: unknown } | undefined;
    try {
      captured = captureTenantData(input);
    } catch (error) {
      invalid = { error };
    }
    return operations.run(async () => {
      if (invalid) throw invalid.error;
      return captureTenantData(await work(captured));
    });
  };
  return {
    invoke,
    calls: () => calls,
    finish: async () => {
      active = false;
      await operations.finish();
    },
  };
}
function fake(options: { owned?: TenantOwnershipSnapshot; grants?: ResourceAccess; policy?: TenantDeletedRecordPolicy | null } = {}) {
  const owned = options.owned ?? ownership(),
    grants = options.grants ?? access(owned),
    guard = harness();
  const log: Array<{ method: string; input: unknown }> = [];
  let rows: Array<Record<string, unknown>> = [row()];
  const records: WriteTransaction = {
    async query(input) {
      log.push({ method: 'query', input });
      const selected = rows.filter((row) =>
        (input.filter?.groups ?? [[]]).some((group) =>
          group.every((condition) =>
            condition.op === 'isNull' ? row[condition.column] === null : row[condition.column] === condition.value,
          ),
        ),
      );
      return {
        columns: owned.schema.tables.find((table) => table.id === input.table)!.columns.map((column) => column.name),
        rows: selected.map((row) => ({ ...row })),
        ms: 0,
        sql,
      };
    },
    async count() {
      throw new Error('unused');
    },
    async update() {
      throw new Error('unused');
    },
    async remove(input) {
      log.push({ method: 'remove', input });
      rows = [];
      return { affected: 1, sql };
    },
    async insert(input) {
      log.push({ method: 'insert', input });
      rows = [{ ...input.values, tenant_id: principal.tenantId }];
      const key: Record<string, string | number> = input.values.id ? { id: String(input.values.id) } : {};
      return { key, applied: input.values, sql };
    },
  };
  const policy = options.policy === null ? undefined : (options.policy ?? (() => true));
  const inverse = createTenantInverseImages(owned, principal, grants, records, policy, guard.invoke);
  return {
    inverse,
    owned,
    grants,
    records,
    log,
    guard,
    setRows: (value: Array<Record<string, unknown>>) => {
      rows = value;
    },
  };
}

test('private helper exposes five frozen methods and captures complete owner image without SQL', async () => {
  const f = fake(),
    captured = await f.inverse.capture(request());
  assert.deepEqual(Object.keys(f.inverse).sort(), ['capture', 'removeCreated', 'removeCurrent', 'restoreDeleted', 'visible']);
  assert.ok(Object.isFrozen(f.inverse));
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured!.row));
  assert.deepEqual(structuredClone(captured), image());
  assert.equal(JSON.stringify(captured).includes('PRIVATE_'), false);
  assert.equal(f.guard.calls(), 1);
  await f.guard.finish();
});

for (const method of ['capture', 'removeCurrent', 'removeCreated', 'restoreDeleted'] as const)
  test(`no explicit policy: ${method} gets no full-row authority`, async () => {
    const f = fake({ policy: null });
    if (method === 'capture') assert.equal(await f.inverse.capture(request()), undefined);
    else await assert.rejects(method === 'removeCurrent' ? f.inverse.removeCurrent(request()) : f.inverse[method](image()));
    assert.equal(f.log.length, 0);
    await f.guard.finish().catch(() => {});
  });

for (const grant of ['resource-read', 'resource-write', 'hidden-normal', 'readonly-normal', 'hidden-PK', 'readonly-PK']) {
  test(`${grant} refuses capture before any full-row read`, async () => {
    const grants = access(),
      fields = grants.fields!.get('item')!;
    if (grant === 'resource-read') (grants.readable as Set<string>).delete('item');
    if (grant === 'resource-write') (grants.writable as Set<string>).delete('item');
    if (grant === 'hidden-normal') (fields.read as Set<string>).delete('name');
    if (grant === 'readonly-normal') (fields.write as Set<string>).delete('name');
    if (grant === 'hidden-PK') (fields.read as Set<string>).delete('id');
    if (grant === 'readonly-PK') (fields.write as Set<string>).delete('id');
    const f = fake({ grants });
    assert.equal(await f.inverse.capture(request()), undefined);
    assert.equal(await f.inverse.visible(image(), true), false);
    assert.equal(f.log.length, 0);
    await f.guard.finish();
  });
}

test('captured grants and methods cannot be replaced or mutated across policy waits', async () => {
  let observed: TenantHistoryImage | undefined;
  const f = fake({
    policy: async (member, record) => {
      assert.ok(Object.isFrozen(member));
      assert.ok(Object.isFrozen(record.row));
      observed = record;
      return true;
    },
  });
  (f.grants.readable as Set<string>).clear();
  (f.grants.fields!.get('item')!.read as Set<string>).clear();
  f.records.query = async () => {
    throw new Error('replaced');
  };
  const captured = await f.inverse.capture(request());
  assert.equal(captured!.row.tenant_id, 'north');
  assert.equal(observed!.row.name, 'Original');
  assert.equal(Reflect.set(observed!.row, 'name', 'Changed'), false);
  await f.guard.finish();
});

const thenable = {};
Reflect.set(thenable, 'then', () => assert.fail('no custom thenables'));
for (const value of ['false', null, {}, thenable]) {
  test(`nonboolean deleted policy ${typeof value} fails the owning invocation`, async () => {
    const f = fake({ policy: () => value as unknown as boolean });
    await assert.rejects(f.inverse.capture(request()));
    await assert.rejects(f.inverse.capture(request()));
    await assert.rejects(f.guard.finish());
    assert.equal(f.log.filter((call) => call.method === 'query').length, 2);
  });
}

test('native async policy rejection preserves original uncertainty and never removes', async () => {
  const error = new TransactionOutcomeUnknown(new Error('driver'));
  const f = fake({ policy: () => Promise.reject(error) });
  await assert.rejects(f.inverse.removeCurrent(request()), (value) => value === error);
  await assert.rejects(f.guard.finish(), (value) => value === error);
  assert.equal(
    f.log.some((call) => call.method === 'remove'),
    false,
  );
});

test('false policy is an unavailable image, not a deletion grant', async () => {
  const f = fake({ policy: () => false });
  assert.equal(await f.inverse.capture(request()), undefined);
  assert.equal(await f.inverse.visible(image(), true), false);
  await f.guard.finish();
});

test('visible deleted image requires policy but never treats absence as authorization', async () => {
  const f = fake();
  f.setRows([]);
  assert.equal(await f.inverse.visible(image(), true), true);
  assert.equal(f.log.length, 0);
  assert.equal(await f.inverse.visible(image(), false), false);
  await f.guard.finish();
});

test('visible current image checks the visible canonical key, not stale whole-row equality', async () => {
  const f = fake();
  f.setRows([{ ...row(), name: 'Changed' }]);
  assert.equal(await f.inverse.visible(image(), false), true);
  await assert.rejects(f.inverse.removeCreated(image()));
  await assert.rejects(f.guard.finish());
  assert.equal(
    f.log.some((call) => call.method === 'remove'),
    false,
  );
});

for (const value of ['North', 'south', 'north ', null, 1])
  test(`foreign stored owner ${String(value)} cannot form an image`, async () => {
    const f = fake();
    f.setRows([{ ...row(), tenant_id: value }]);
    assert.equal(await f.inverse.capture(request()), undefined);
    assert.equal(await f.inverse.visible({ ...image(), row: { ...row(), tenant_id: value as string } }, true), false);
    await f.guard.finish();
  });

for (const patch of [
  { amount: '1' },
  { amount: '' },
  { amount: Number.MAX_SAFE_INTEGER + 1 },
  { name: '<3 bytes>' },
  { name: { nested: true } },
  { id: null },
  { extra: 'unknown' },
]) {
  test(`non-restorable stored image ${JSON.stringify(patch)} yields no inverse`, async () => {
    const f = fake();
    f.setRows([{ ...row(), ...patch }]);
    assert.equal(await f.inverse.capture(request()), undefined);
    await f.guard.finish();
  });
}

test('remove and restore use one invocation each; restore omits only managed ownership', async () => {
  let policies = 0;
  const f = fake({
    policy: () => {
      policies++;
      return true;
    },
  });
  const removed = await f.inverse.removeCurrent(request());
  assert.equal(policies, 2);
  assert.equal(f.guard.calls(), 1);
  await f.inverse.restoreDeleted(removed);
  assert.equal(policies, 4);
  assert.equal(f.guard.calls(), 2);
  const inserted = f.log.find((call) => call.method === 'insert')!.input;
  assert.deepEqual(structuredClone(inserted), { table: 'item', values: { id: 'one', name: 'Original', amount: 1, optional: null } });
  await f.inverse.removeCreated(removed);
  assert.equal(policies, 6);
  assert.equal(f.guard.calls(), 3);
  await f.guard.finish();
});

for (const method of ['capture', 'removeCurrent', 'visible', 'removeCreated', 'restoreDeleted'] as const) {
  test(`${method} hostile inputs never execute getters/proxies and retained handles delegate refusal`, async () => {
    const f = fake();
    let calls = 0;
    const getter = {
      ...image(),
      get row() {
        calls++;
        return row();
      },
    };
    const proxy = new Proxy(request(), {
      ownKeys() {
        calls++;
        return [];
      },
    });
    const promise =
      method === 'capture' || method === 'removeCurrent'
        ? f.inverse[method](proxy)
        : method === 'visible'
          ? f.inverse.visible(getter, true)
          : f.inverse[method](getter);
    await assert.rejects(promise);
    await assert.rejects(f.guard.finish());
    assert.equal(calls, 0);
    assert.equal(f.log.length, 0);
    await assert.rejects(f.inverse.capture(request()));
  });
}

test('factory does not invoke access, record-method or lock getters or proxied sets', () => {
  let calls = 0;
  for (const bad of ['access', 'set', 'method']) {
    const f = fake(),
      grants = access();
    if (bad === 'access')
      Object.defineProperty(grants, 'fields', {
        enumerable: true,
        get() {
          calls++;
          return new Map();
        },
      });
    if (bad === 'set')
      grants.readable = new Proxy(new Set(['item']), {
        get() {
          calls++;
          return undefined;
        },
      });
    if (bad === 'method')
      Object.defineProperty(f.records, 'query', {
        get() {
          calls++;
          return undefined;
        },
      });
    assert.throws(() => createTenantInverseImages(f.owned, principal, grants, f.records, () => true, f.guard.invoke));
  }
  const f = fake();
  Object.defineProperty(f.records, 'lockRecord', {
    get() {
      calls++;
      return undefined;
    },
  });
  assert.ok(createTenantInverseImages(f.owned, principal, access(), f.records, () => true, f.guard.invoke));
  assert.equal(calls, 0);
});

test('image and request capture precede the delegated queue wait', async () => {
  const f = fake(),
    input = request(),
    removal = f.inverse.removeCurrent(input);
  input.key.id = 'foreign';
  const captured = await removal;
  const restoring = structuredClone(captured),
    pending = f.inverse.restoreDeleted(restoring);
  restoring.row.tenant_id = 'south';
  restoring.row.name = 'Mutated';
  restoring.key.id = 'foreign';
  await pending;
  assert.equal((await f.inverse.capture(request()))!.row.name, 'Original');
  await f.guard.finish();
});

test('missing/extra image fields and mismatched canonical keys cannot authorize a deleted inverse', async () => {
  const f = fake();
  const missing = image();
  Reflect.deleteProperty(missing.row, 'optional');
  for (const value of [missing, { ...image(), row: { ...row(), extra: 'hidden' } }, { ...image(), key: { id: 'other' } }])
    assert.equal(await f.inverse.visible(value, true), false);
  assert.equal(f.log.length, 0);
  await f.guard.finish();
});

test('historical image must supply its own complete key rather than deriving missing authority from the row', async () => {
  const f = fake(),
    invalid = image();
  Reflect.deleteProperty(invalid, 'key');
  await assert.rejects(f.inverse.restoreDeleted(invalid));
  await assert.rejects(f.guard.finish());
  assert.equal(f.log.length, 0);
});

test('unknown, physical aliases and private targets gain no capture authority', async () => {
  const f = fake();
  for (const table of ['missing', 'business.item', '__mistri_tenant_membership', '__proto__']) {
    assert.equal(await f.inverse.capture({ table, key: { id: 'one' } }), undefined);
  }
  assert.equal(f.log.length, 0);
  await f.guard.finish();
});

test('unkeyed tables have no inverse and view ownership is refused before creating a helper', async () => {
  const original = ownership();
  const unkeyed = structuredClone(original);
  for (const schema of [unkeyed.schema, unkeyed.physicalSchema]) {
    for (const column of schema.tables[0].columns) column.primaryKey = false;
  }
  const f = fake({ owned: captureTenantOwnership(unkeyed) });
  assert.equal(await f.inverse.capture(request()), undefined);
  assert.equal(f.log.length, 0);
  await f.guard.finish();
  const view = structuredClone(original);
  for (const schema of [view.schema, view.physicalSchema]) schema.tables[0].isView = true;
  assert.throws(() => fake({ owned: view }), TenantContextError);
});

test('factory rejects mismatched principal source and hostile evidence without evaluating it', () => {
  const f = fake();
  let calls = 0;
  for (const value of [
    { ...principal, source: { ...principal.source, connection: 'other' } },
    { ...principal, tenantId: 'North' },
    {
      ...principal,
      get tenantId() {
        calls++;
        return 'north';
      },
    },
    new Proxy(principal, {
      ownKeys() {
        calls++;
        return [];
      },
    }),
  ]) {
    assert.throws(() => createTenantInverseImages(f.owned, value, f.grants, f.records, () => true, f.guard.invoke));
  }
  assert.equal(calls, 0);
});

async function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-inverse-')),
    path = join(directory, 'data.db');
  const db = new DatabaseSync(path),
    adapter = new SqliteAdapter(path, 'Test');
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE country (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE item (id TEXT PRIMARY KEY ON CONFLICT REPLACE NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'south',
      name TEXT NOT NULL, amount INTEGER NOT NULL, optional TEXT, parent_id TEXT REFERENCES parent(id), country_id TEXT REFERENCES country(id));
    CREATE TABLE local (tenant_id TEXT COLLATE NOCASE NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY(tenant_id COLLATE BINARY,id));
    CREATE TABLE padded (tenant_id TEXT COLLATE RTRIM NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY(tenant_id COLLATE BINARY,id));
    INSERT INTO country VALUES ('us','Global');
    INSERT INTO parent VALUES ('north-parent','north','Parent'), ('south-parent','south','Other');
    INSERT INTO item VALUES ('one','north','Original',1,NULL,'north-parent','us'), ('foreign','south','Hidden',2,NULL,'south-parent','us');
    INSERT INTO local VALUES ('north',1,'Original'); INSERT INTO padded VALUES ('north',1,'Original');`);
  const physicalSchema = readSqliteScopeCatalog(db).schema;
  const resources = Object.fromEntries(['country', 'parent', 'item', 'local', 'padded'].map((id) => [id, id]));
  const owned = captureTenantOwnership({
    appId: principal.appId,
    source: principal.source,
    physicalSchema,
    schema: mapScopeCatalog(physicalSchema, new Map(Object.entries(resources))),
    resources,
    ownership: {
      country: { kind: 'global', access: 'read-only' },
      parent: { kind: 'tenant', column: 'tenant_id' },
      item: { kind: 'tenant', column: 'tenant_id' },
      local: { kind: 'tenant', column: 'tenant_id' },
      padded: { kind: 'tenant', column: 'tenant_id' },
    },
  });
  const all = Object.fromEntries(Object.keys(resources).map((id) => [id, true]));
  let scope = composeTenantReadScope(owned, principal, all, all);
  const run = <T>(
    work: (images: TenantInverseImages, records: WriteTransaction) => Promise<T>,
    policy: TenantDeletedRecordPolicy | undefined = () => true,
    grants = access(owned),
  ) =>
    adapter.scopeTransaction(scope, (tx) =>
      runTenantManagedTransaction(owned, principal, tx, async (records) => {
        const guard = harness();
        try {
          const result = await work(createTenantInverseImages(owned, principal, grants, records, policy, guard.invoke), records);
          await guard.finish();
          return result;
        } catch (error) {
          await guard.finish().catch(() => {});
          throw error;
        }
      }),
    );
  return {
    db,
    owned,
    run,
    setHidden: () => {
      scope = composeTenantReadScope(owned, principal, all, {
        ...all,
        item: { groups: [[{ column: 'name', op: '!=', value: 'Hidden' }]] },
      });
    },
  };
}

test('SQLite delete and restore use actual complete owned image, preserving hidden owner and nullable values', async (t) => {
  const f = await sqlite(t);
  const captured = await f.run((images) => images.removeCurrent(request()));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 0);
  assert.equal(captured.row.tenant_id, 'north');
  assert.equal(captured.row.optional, null);
  await f.run((images) => images.restoreDeleted(captured));
  assert.equal(f.db.prepare("SELECT tenant_id FROM item WHERE id='one'").get()!.tenant_id, 'north');
  await f.run((images) => images.removeCreated(captured));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 0);
});

test('SQLite creation-removal Undo requires full exact afterimage', async (t) => {
  const f = await sqlite(t);
  const captured = await f.run(async (images, records) => {
    await records.insert({
      table: 'item',
      values: { id: 'created', name: 'Created', amount: 2, optional: null, parent_id: 'north-parent', country_id: 'us' },
    });
    return (await images.capture({ table: 'item', key: { id: 'created' } }))!;
  });
  f.db.exec("UPDATE item SET amount=3 WHERE id='created'");
  await assert.rejects(f.run((images) => images.removeCreated(captured)));
  assert.equal(f.db.prepare("SELECT amount FROM item WHERE id='created'").get()!.amount, 3);
});

for (const [table, owner] of [
  ['local', 'North'],
  ['padded', 'north '],
])
  test(`SQLite ${table} owner alias refuses before canonicalization`, async (t) => {
    const f = await sqlite(t);
    await assert.rejects(f.run((images) => images.removeCurrent({ table, key: { tenant_id: owner, id: 1 } })));
    assert.equal(f.db.prepare(`SELECT name FROM ${table}`).get()!.name, 'Original');
    const captured = await f.run((images) => images.removeCurrent({ table, key: { tenant_id: 'north', id: 1 } }));
    await f.run((images) => images.restoreDeleted(captured));
  });

test('SQLite global and inbound-child resources are ineligible before image authority', async (t) => {
  const f = await sqlite(t);
  await f.run(async (images) => {
    assert.equal(await images.capture({ table: 'country', key: { id: 'us' } }), undefined);
    assert.equal(await images.capture({ table: 'parent', key: { id: 'north-parent' } }), undefined);
  });
});

for (const gate of ['parent-resource', 'parent-key'])
  test(`SQLite hidden outbound ${gate} forbids image capture`, async (t) => {
    const f = await sqlite(t),
      grants = access(f.owned);
    if (gate === 'parent-resource') (grants.readable as Set<string>).delete('parent');
    else (grants.fields!.get('parent')!.read as Set<string>).delete('id');
    assert.equal(
      await f.run(
        (images) => images.capture(request()),
        () => true,
        grants,
      ),
      undefined,
    );
  });

test('SQLite policy revocation after removal rolls back the actual deletion', async (t) => {
  const f = await sqlite(t);
  let calls = 0;
  await assert.rejects(
    f.run(
      (images) => images.removeCurrent(request()),
      () => ++calls === 1,
    ),
  );
  assert.equal(calls, 2);
  assert.equal(f.db.prepare("SELECT name FROM item WHERE id='one'").get()!.name, 'Original');
});

test('SQLite deleted-image policy remains required; restore refuses changed parent tenant', async (t) => {
  const f = await sqlite(t),
    captured = await f.run((images) => images.removeCurrent(request()));
  assert.equal(
    await f.run(
      (images) => images.visible(captured, true),
      () => false,
    ),
    false,
  );
  f.db.exec("UPDATE parent SET tenant_id='south' WHERE id='north-parent'");
  await assert.rejects(f.run((images) => images.restoreDeleted(captured)));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 0);
});

test('SQLite hidden replacement cannot be overwritten by schema ON CONFLICT REPLACE', async (t) => {
  const f = await sqlite(t),
    captured = await f.run((images) => images.removeCurrent(request()));
  f.db.exec("INSERT INTO item VALUES ('one','south','Hidden',9,NULL,'south-parent','us')");
  assert.equal(await f.run((images) => images.visible(captured, false)), false);
  await assert.rejects(f.run((images) => images.restoreDeleted(captured)));
  assert.equal(f.db.prepare("SELECT tenant_id FROM item WHERE id='one'").get()!.tenant_id, 'south');
});

test('SQLite current-row scope loss blocks removal and restored afterimage outside scope rolls back', async (t) => {
  const f = await sqlite(t),
    captured = await f.run((images) => images.capture(request()));
  f.setHidden();
  f.db.exec("UPDATE item SET name='Hidden' WHERE id='one'");
  assert.equal(await f.run((images) => images.visible(captured!, false)), false);
  await assert.rejects(f.run((images) => images.removeCreated(captured!)));
  f.db.exec("DELETE FROM item WHERE id='one'");
  await assert.rejects(f.run((images) => images.restoreDeleted({ ...captured!, row: { ...captured!.row, name: 'Hidden' } })));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 0);
});

test('SQLite policy loss after restoration rolls back the actual insert', async (t) => {
  const f = await sqlite(t),
    captured = await f.run((images) => images.removeCurrent(request()));
  let calls = 0;
  await assert.rejects(
    f.run(
      (images) => images.restoreDeleted(captured),
      () => ++calls === 1,
    ),
  );
  assert.equal(calls, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 0);
});

for (const change of ["amount = ' '", "name = X'010203'"])
  test(`SQLite lossy stored ${change} produces no inverse and cannot be removed`, async (t) => {
    const f = await sqlite(t);
    f.db.exec(`UPDATE item SET ${change} WHERE id='one'`);
    assert.equal(await f.run((images) => images.capture(request())), undefined);
    await assert.rejects(f.run((images) => images.removeCurrent(request())));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM item WHERE id='one'").get()!.n, 1);
  });

test('SQLite caught malformed inverse input poisons completion and rolls back an earlier write', async (t) => {
  const f = await sqlite(t);
  await assert.rejects(
    f.run(async (images, records) => {
      await records.update({ table: 'item', key: { id: 'one' }, values: { name: 'Changed' } });
      await assert.rejects(images.removeCurrent({ table: 'local', key: { id: 1 } }));
    }),
  );
  assert.equal(f.db.prepare("SELECT name FROM item WHERE id='one'").get()!.name, 'Original');
});

test('SQLite hidden owner component of a composite PK gets no inverse exception', async (t) => {
  const f = await sqlite(t),
    grants = access(f.owned);
  (grants.fields!.get('local')!.read as Set<string>).delete('tenant_id');
  assert.equal(
    await f.run(
      (images) => images.capture({ table: 'local', key: { tenant_id: 'north', id: 1 } }),
      () => true,
      grants,
    ),
    undefined,
  );
});
