import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations, type UpdateRequest } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { createTenantRecordHistory } from '../packages/mistri/src/server/tenant/tenantRecordHistory.js';
import type { TenantWriteRuntimeOptions } from '../packages/mistri/src/server/tenant/tenantWriteRuntime.js';
import { openSqliteTenantWriteSource, TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

type Request = { cookie: string };
type Options = TenantWriteRuntimeOptions<Request>;
type Service = ReturnType<typeof createTenantRecordHistory<Request>>;
const request = { cookie: 'alice' };
const binding = { appId: 'history-app', source: { id: 'business', connection: 'business-db' }, storeId: 'history-fixture' };
const resources = { item: 'db_item', local: 'db_local', country: 'db_country' };
const change = (name = 'Changed', id = 'north-row'): UpdateRequest => ({ table: 'item', key: { id }, values: { name } });
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
    assert.equal(error.code, 'tenant_write_unavailable');
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, 'The tenant write could not be completed.');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('PRIVATE_SENTINEL'), false);
    return true;
  };
}
function undoId(value: { undoId?: string }): string {
  assert.equal(typeof value.undoId, 'string', 'successful lossless update has an opaque Undo token');
  assert.match(value.undoId!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return value.undoId!;
}

async function fixture(t: TestContext, ownerCollation: 'BINARY' | 'NOCASE' | 'RTRIM' = 'BINARY') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-update-history-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  const services: Service[] = [];
  const sources: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      await Promise.all(services.map((service) => service.retire()));
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE db_item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, name TEXT COLLATE NOCASE NOT NULL, note TEXT, untouched TEXT DEFAULT 'Untouched',
      secret TEXT DEFAULT 'PRIVATE_SENTINEL', amount NUMERIC, payload BLOB,
      UNIQUE (tenant_id COLLATE BINARY, business_id));
    CREATE TABLE db_local (tenant_id TEXT COLLATE ${ownerCollation} NOT NULL, local_id INTEGER NOT NULL, name TEXT,
      PRIMARY KEY (tenant_id COLLATE BINARY, local_id));
    CREATE TABLE db_country (code TEXT PRIMARY KEY NOT NULL, name TEXT);
    INSERT INTO db_item (id,tenant_id,business_id,name,note,amount,payload) VALUES
      ('north-row','north','same-business','Original',NULL,10,NULL),
      ('north-other','north','other','Other','',20,NULL),
      ('south-row','south','same-business','South',NULL,30,NULL),
      ('alias-row','North','same-business','Alias',NULL,40,NULL);
    INSERT INTO db_local VALUES ('north',1,'North local'),('south',1,'South local');
    INSERT INTO db_country VALUES ('us','Global');`);
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
      for (const accountId of ['alice', 'bob'])
        await admin.putMembership({ ...grant, tenantId, accountId, membershipId: `${tenantId}-${accountId}` });
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
      local: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  let time = 1000;
  let identity: Identity | null = { id: 'alice', who: 'Alice', role: 'admin' };
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
      name: 'History fixture',
      sources: { business: { connection: binding.source.connection } },
      resources: blocks(resources, {
        item: {
          read: ['id', 'business_id', 'name', 'note', 'untouched', 'amount', 'payload'],
          write: ['business_id', 'name', 'note', 'amount', 'payload'],
        },
        local: { read: ['tenant_id', 'local_id', 'name'], write: ['name'] },
      }),
      auth: {
        roles: {
          editor: { read: true, write: true },
          viewer: { read: true },
          limited: { read: true, write: true, fields: { item: { read: ['id', 'name'], write: [] } } },
          admin: { read: true, write: true },
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'tenant update history test',
  );
  const rows: RowScope = { item: true, local: true, country: true };
  const issue = async (overrides: Partial<Options> = {}) => {
    const reader = openSqliteTenantReadSource(path, ownership, binding, () => time);
    sources.push(reader);
    const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => time);
    sources.push(writer);
    const options: Options = {
      app,
      reader,
      writer,
      deployment: 'deployment-1',
      roles: ['editor', 'viewer', 'limited', 'admin'],
      maxLifetimeMs: 5000,
      verifySession: (input) => (input.cookie === 'alice' ? identity : null),
      resolveMembershipRows: () => rows,
      resolveRows: () => rows,
      now: () => time,
      ...overrides,
    };
    const service = createTenantRecordHistory(options);
    services.push(service);
    return service;
  };
  return {
    db,
    app,
    rows,
    issue,
    maintenance,
    grant,
    row: (id = 'north-row') =>
      plain(db.prepare('SELECT id,tenant_id,business_id,name,note,untouched,secret FROM db_item WHERE id=?').get(id)),
    setTime: (next: number) => {
      time = next;
    },
    setIdentity: (next: Identity | null) => {
      identity = next;
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

test('real update, safe preview and exact Undo preserve hidden ownership, untouched fields and another tenant', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(Object.keys(service).sort(), ['importRows', 'insert', 'preview', 'previewRemove', 'remove', 'retire', 'undo', 'update']);
  const updated = await service.update(request, ['north'], change());
  const id = undoId(updated);
  assert.deepEqual(plain(updated.result), { affected: 1, applied: { name: 'Changed' }, sql: { text: '', params: [] } });
  const preview = await service.preview(request, ['north']);
  assert.equal(preview.next?.id, id);
  assert.equal(preview.writes.length, 1);
  assert.deepEqual(Object.keys(preview.writes[0]).sort(), ['at', 'id', 'kind', 'revertible', 'summary']);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_SENTINEL|tenant_id|db_item|Original|Changed|before|after/);
  f.db.prepare('UPDATE db_item SET untouched=? WHERE id=?').run('Independent change', 'north-row');
  const undone = await service.undo(request, ['north'], { expectedId: id });
  assert.equal(undone.reverted, true);
  assert.equal(undone.outcome, 'applied');
  assert.equal(undone.undone.id, id);
  assert.equal(f.row()!.name, 'Original');
  assert.equal(f.row()!.untouched, 'Independent change');
  assert.equal(f.row()!.tenant_id, 'north');
  assert.equal(f.row()!.secret, 'PRIVATE_SENTINEL');
  assert.equal(f.row('south-row')!.name, 'South');
  assert.equal(f.row('alias-row')!.name, 'Alias');
  assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
});

test('readable composite ownership keys can update and Undo without granting ownership mutation', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const id = undoId(
    await service.update(request, ['north'], { table: 'local', key: { tenant_id: 'north', local_id: 1 }, values: { name: 'Changed' } }),
  );
  await service.undo(request, ['north'], { expectedId: id });
  assert.deepEqual(plain(f.db.prepare('SELECT * FROM db_local ORDER BY tenant_id').all()), [
    { tenant_id: 'north', local_id: 1, name: 'North local' },
    { tenant_id: 'south', local_id: 1, name: 'South local' },
  ]);
  await assert.rejects(
    service.update(request, ['north'], { table: 'local', key: { tenant_id: 'north', local_id: 1 }, values: { tenant_id: 'south' } }),
    safe('not_applied'),
  );
});

for (const [collation, alias] of [
  ['NOCASE', 'North'],
  ['RTRIM', 'north '],
] as const) {
  test(`history preflight cannot normalize a ${collation} composite owner alias into write authority`, async (t) => {
    const f = await fixture(t, collation),
      service = await f.issue();
    await assert.rejects(
      service.update(request, ['north'], { table: 'local', key: { tenant_id: alias, local_id: 1 }, values: { name: 'Should not change' } }),
      safe('not_applied'),
    );
    assert.deepEqual(plain(f.db.prepare('SELECT * FROM db_local ORDER BY tenant_id').all()), [
      { tenant_id: 'north', local_id: 1, name: 'North local' },
      { tenant_id: 'south', local_id: 1, name: 'South local' },
    ]);
    assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
  });
}

for (const [field, before, saved, outside] of [
  ['name', 'Original', 'Saved', 'SAVED'],
  ['note', null, '', null],
  ['note', '', null, ''],
] as const) {
  test(`exact touched ${field} distinguishes ${JSON.stringify(saved)} from ${JSON.stringify(outside)} despite SQL equality`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    f.db.prepare(`UPDATE db_item SET ${field}=? WHERE id='north-row'`).run(before);
    const id = undoId(await service.update(request, ['north'], { ...change(), values: { [field]: saved } }));
    f.db.prepare(`UPDATE db_item SET ${field}=? WHERE id='north-row'`).run(outside);
    await assert.rejects(service.undo(request, ['north'], { expectedId: id }), safe('not_applied'));
    assert.equal(f.row()![field], outside);
    assert.equal((await service.preview(request, ['north'])).next?.id, id, 'confirmed rollback retains the inverse');
    f.db.prepare(`UPDATE db_item SET ${field}=? WHERE id='north-row'`).run(saved);
    await service.undo(request, ['north'], { expectedId: id });
    assert.equal(f.row()![field], before);
  });
}

test('same actor in two tenants and another account never discover or consume the other partition', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const north = undoId(await service.update(request, ['north'], change('North edit')));
  assert.deepEqual(plain(await service.preview(request, ['south'])), { writes: [] });
  await assert.rejects(service.undo(request, ['south'], { expectedId: north }), safe('not_applied'));
  const south = undoId(await service.update(request, ['south'], change('South edit', 'south-row')));
  assert.notEqual(north, south);
  await assert.rejects(service.undo(request, ['south'], { expectedId: north }), safe('not_applied'));
  await assert.rejects(service.undo(request, ['north'], { expectedId: south }), safe('not_applied'));
  f.setIdentity({ id: 'bob', who: 'Bob', role: 'admin' });
  assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
  await assert.rejects(service.undo(request, ['north'], { expectedId: north }), safe('not_applied'));
  f.setIdentity({ id: 'alice', who: 'Alice', role: 'admin' });
  assert.equal((await service.preview(request, ['north'])).next?.id, north);
  assert.equal((await service.preview(request, ['south'])).next?.id, south);
  await service.undo(request, ['north'], { expectedId: north });
  assert.equal(f.row('south-row')!.name, 'South edit');
});

for (const transition of ['version', 'reinvitation', 'tenant version', 'viewer', 'limited'] as const) {
  test(`${transition} cannot revive or disclose a prior authorization partition`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    const id = undoId(await service.update(request, ['north'], change()));
    if (transition === 'reinvitation') {
      await f.revoke();
      await f.maintenance((admin) => admin.putMembership({ ...f.grant, membershipId: 'new-grant', expectedVersion: null }));
    } else if (transition === 'tenant version') {
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '1' }));
    } else
      await f.maintenance((admin) =>
        admin.putMembership({ ...f.grant, roles: transition === 'version' ? ['editor'] : [transition], expectedVersion: '1' }),
      );
    assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
    await assert.rejects(service.undo(request, ['north'], { expectedId: id }), safe('not_applied'));
    assert.equal(f.row()!.name, 'Changed');
    if (transition === 'viewer' || transition === 'limited')
      await assert.rejects(service.update(request, ['north'], change('No authority')), safe('not_applied'));
  });
}

test('a new deployment over the same paired namespace has no old Undo authority', async (t) => {
  const f = await fixture(t),
    first = await f.issue();
  const id = undoId(await first.update(request, ['north'], change()));
  const second = await f.issue({ deployment: 'deployment-2' });
  assert.deepEqual(plain(await second.preview(request, ['north'])), { writes: [] });
  await assert.rejects(second.undo(request, ['north'], { expectedId: id }), safe('not_applied'));
  assert.equal((await first.preview(request, ['north'])).next?.id, id);
});

for (const policy of ['membership', 'authored'] as const) {
  test(`newer row hidden by current ${policy} policy is a barrier, never older-entry fallthrough`, async (t) => {
    const f = await fixture(t);
    let hidden = false;
    const resolve = (): RowScope => ({ ...f.rows, item: hidden ? { groups: [[{ column: 'id', op: '=', value: 'north-row' }]] } : true });
    const service = await f.issue(policy === 'membership' ? { resolveMembershipRows: resolve } : { resolveRows: resolve });
    const older = undoId(await service.update(request, ['north'], change('Older')));
    const newer = undoId(await service.update(request, ['north'], change('Newer', 'north-other')));
    hidden = true;
    assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
    for (const expectedId of [older, newer]) await assert.rejects(service.undo(request, ['north'], { expectedId }), safe('not_applied'));
    assert.equal(f.row()!.name, 'Older');
    assert.equal(f.row('north-other')!.name, 'Newer');
    hidden = false;
    assert.equal((await service.preview(request, ['north'])).next?.id, newer);
  });
}

test('revoked membership refuses all history disclosure and inverse writes', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const id = undoId(await service.update(request, ['north'], change()));
  await f.revoke();
  await assert.rejects(service.preview(request, ['north']), safe('not_applied'));
  await assert.rejects(service.undo(request, ['north'], { expectedId: id }), safe('not_applied'));
  assert.equal(f.row()!.name, 'Changed');
});

test('update arguments and selectors are detached before pending authentication; replies cannot rewrite history', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  const service = await f.issue({
    verifySession: async () => {
      entered.release();
      await released.promise;
      return { id: 'alice', who: 'Alice' };
    },
  });
  const input = change('Captured'),
    selectors = ['north'];
  const running = service.update(request, selectors, input);
  await entered.promise;
  input.values.name = 'Mutated';
  input.key.id = 'south-row';
  selectors[0] = 'south';
  released.release();
  const updated = await running,
    id = undoId(updated);
  assert.equal(f.row()!.name, 'Captured');
  assert.equal(f.row('south-row')!.name, 'South');
  assert.ok(Object.isFrozen(updated));
  assert.ok(Object.isFrozen(updated.result.applied));
  assert.throws(() => {
    updated.result.applied.name = 'Forged';
  }, TypeError);
  const preview = await service.preview(request, ['north']);
  assert.ok(Object.isFrozen(preview.writes));
  assert.throws(() => {
    preview.writes[0].id = id + 100;
  }, TypeError);
  await service.undo(request, ['north'], { expectedId: id });
  assert.equal(f.row()!.name, 'Original');
});

for (const bad of [
  null,
  {},
  { expectedId: 0 },
  { expectedId: -1 },
  { expectedId: 1.5 },
  { expectedId: '1' },
  { expectedId: Infinity },
  { expectedId: 1, before: { name: 'Forged' } },
  { expectedId: 1, tenantId: 'south' },
]) {
  test(`strict Undo input ${JSON.stringify(bad)} grants no supplied history authority`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    const id = undoId(await service.update(request, ['north'], change()));
    await assert.rejects(service.undo(request, ['north'], bad as unknown as { expectedId: string }), safe('not_applied'));
    assert.equal((await service.preview(request, ['north'])).next?.id, id);
    assert.equal(f.row()!.name, 'Changed');
  });
}

for (const bad of [null, { limit: 0 }, { limit: 51 }, { limit: '1' }, { limit: 1.5 }, { limit: NaN }, { limit: 1, accountId: 'bob' }]) {
  test(`strict preview input ${JSON.stringify(bad)} never expands history selection`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    await assert.rejects(service.preview(request, ['north'], bad as { limit?: number }), safe('not_applied'));
  });
}

test('forged update history images, managed owners, hidden fields, global tables and guessed keys refuse without effects', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  for (const input of [
    { ...change(), before: { name: 'Forged' } },
    { ...change(), after: { name: 'Forged' } },
    { ...change(), values: { tenant_id: 'north' } },
    { ...change(), values: { secret: 'Forged' } },
    { ...change(), expected: { secret: 'PRIVATE_SENTINEL' } },
    change('Guessed', 'south-row'),
    change('Guessed', 'alias-row'),
    { table: 'country', key: { code: 'us' }, values: { name: 'No global writes' } },
    { table: '__mistri_tenant_membership', key: { id: 'north-alice' }, values: { roles: 'admin' } },
    { ...change(), values: {} },
    { ...change(), key: {} },
  ])
    await assert.rejects(service.update(request, ['north'], input as UpdateRequest), safe('not_applied'));
  assert.equal(f.row()!.name, 'Original');
  assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
});

for (const kind of ['blob', 'unsafe integer REAL'] as const) {
  test(`${kind} original cannot create a lossy inverse or expose an older Undo past its barrier`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    const older = undoId(await service.update(request, ['north'], change('Older')));
    const column = kind === 'blob' ? 'payload' : 'amount';
    f.db.exec(
      kind === 'blob'
        ? "UPDATE db_item SET payload=X'000102FF' WHERE id='north-row'"
        : "UPDATE db_item SET amount=1e20 WHERE id='north-row'",
    );
    const result = await service.update(request, ['north'], { ...change(), values: { [column]: null } });
    assert.equal(result.result.affected, 1);
    assert.equal(result.undoId, undefined);
    const preview = await service.preview(request, ['north']);
    assert.equal(preview.next, undefined);
    assert.equal(preview.writes[0].blocksUndo, true);
    assert.equal(preview.writes[0].revertible, false);
    assert.doesNotMatch(JSON.stringify(preview), /000102|100000000000000000000|<4 bytes>/);
    await assert.rejects(service.undo(request, ['north'], { expectedId: older }), safe('not_applied'));
    assert.equal(f.row()!.name, 'Older');
    assert.equal(f.db.prepare(`SELECT ${column} AS value FROM db_item WHERE id='north-row'`).get()!.value, null);
  });
}

test('preview limit bounds summaries without changing newest token; older token cannot skip the newest inverse', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const older = undoId(await service.update(request, ['north'], change('First')));
  const newer = undoId(await service.update(request, ['north'], change('Second')));
  const preview = await service.preview(request, ['north'], { limit: 1 });
  assert.equal(preview.writes.length, 1);
  assert.equal(preview.next?.id, newer);
  await assert.rejects(service.undo(request, ['north'], { expectedId: older }), safe('not_applied'));
  assert.equal(f.row()!.name, 'Second');
  await service.undo(request, ['north'], { expectedId: newer });
  assert.equal(f.row()!.name, 'First');
  assert.equal((await service.preview(request, ['north'])).next?.id, older);
  await service.undo(request, ['north'], { expectedId: older });
  assert.equal(f.row()!.name, 'Original');
});

for (const shape of ['getter', 'proxy', 'sparse selectors'] as const) {
  test(`${shape} input is rejected without evaluating request hooks or changing history`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    let traps = 0;
    let input: UpdateRequest = change();
    if (shape === 'getter')
      Object.defineProperty(input, 'values', {
        enumerable: true,
        get() {
          traps++;
          return { name: 'Bad' };
        },
      });
    if (shape === 'proxy')
      input = new Proxy(input, {
        ownKeys(target) {
          traps++;
          return Reflect.ownKeys(target);
        },
      });
    const selectors = ['north'];
    if (shape === 'sparse selectors') delete selectors[0];
    await assert.rejects(service.update(request, selectors, input), safe('not_applied'));
    assert.equal(traps, 0);
    assert.equal(f.row()!.name, 'Original');
    assert.deepEqual(plain(await service.preview(request, ['north'])), { writes: [] });
  });
}

for (const twice of [false, true]) {
  test(`${twice ? 'double' : 'single'} postcommit publication Date failure remains unknown and blocks older history only in its partition`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    const older = undoId(await service.update(request, ['north'], change('Older')));
    const south = undoId(await service.update(request, ['south'], change('South own', 'south-row')));
    const original = Date.prototype.toISOString;
    let publications = 0;
    const mocked = t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
      // Other layers may use Dates before COMMIT; inject only once a separate
      // SQLite handle can observe the landed business change.
      if (f.row()!.name !== 'Committed') return original.call(this);
      publications++;
      if (twice || publications === 1) throw new Error('PRIVATE_SENTINEL');
      return original.call(this);
    });
    try {
      await assert.rejects(service.update(request, ['north'], change('Committed')), safe('unknown'));
    } finally {
      mocked.mock.restore();
    }
    assert.equal(publications, 2);
    assert.equal(f.row()!.name, 'Committed');
    const preview = await service.preview(request, ['north']);
    assert.equal(preview.next, undefined);
    assert.equal(preview.writes[0].undoState, 'unknown');
    await assert.rejects(service.undo(request, ['north'], { expectedId: older }), safe(twice ? 'unknown' : 'not_applied'));
    assert.equal(f.row()!.name, 'Committed');
    assert.equal((await service.preview(request, ['south'])).next?.id, south);
  });
}

for (const operation of ['update', 'undo'] as const) {
  for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
    for (const executed of [false, true]) {
      test(`${operation} writer ${boundary} ${executed ? 'lost acknowledgment' : 'before execution'} stays unknown and retires the unsafe source`, async (t) => {
        const f = await fixture(t),
          service = await f.issue();
        const id = undoId(await service.update(request, ['north'], change()));
        if (operation === 'undo' && boundary === 'ROLLBACK') f.db.exec("UPDATE db_item SET name='External' WHERE id='north-row'");
        const original = DatabaseSync.prototype.exec,
          writers = new WeakSet<DatabaseSync>();
        let faults = 0;
        const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
          if (sql === 'BEGIN IMMEDIATE') writers.add(this);
          if (writers.has(this) && sql === boundary) {
            faults++;
            if (executed) original.call(this, sql);
            throw new Error('PRIVATE_SENTINEL');
          }
          return original.call(this, sql);
        });
        try {
          const attempt =
            operation === 'undo'
              ? service.undo(request, ['north'], { expectedId: id })
              : service.update(request, ['north'], {
                  ...change('Second'),
                  ...(boundary === 'ROLLBACK' ? { expected: { name: 'Incorrect' } } : {}),
                });
          await assert.rejects(attempt, safe('unknown'));
        } finally {
          mocked.mock.restore();
        }
        assert.ok(faults > 0, 'the actual owned writer fault was reached');
        assert.equal(
          f.row()!.name,
          boundary === 'COMMIT' && executed
            ? operation === 'undo'
              ? 'Original'
              : 'Second'
            : operation === 'undo' && boundary === 'ROLLBACK'
              ? 'External'
              : 'Changed',
        );
        await assert.rejects(service.update(request, ['north'], change('Must not retry')), safe('not_applied'));
      });
    }
  }
}

for (const operation of ['update', 'undo'] as const) {
  for (const reason of ['session', 'membership', 'expiry'] as const) {
    test(`${operation} ${reason} loss after confirmed commit cannot claim rollback or forget an uncertain inverse`, async (t) => {
      const f = await fixture(t);
      let armed = false,
        triggered = false;
      const target = operation === 'undo' ? 'Original' : 'Second';
      const service = await f.issue({
        verifySession: async () => {
          if (armed && !triggered && f.row()!.name === target) {
            triggered = true;
            if (reason === 'session') return null;
            if (reason === 'membership') await f.revoke();
            if (reason === 'expiry') f.setTime(6000);
          }
          return { id: 'alice', who: 'Alice' };
        },
      });
      const id = undoId(await service.update(request, ['north'], change()));
      armed = true;
      const attempt =
        operation === 'undo' ? service.undo(request, ['north'], { expectedId: id }) : service.update(request, ['north'], change('Second'));
      /* A revocation after COMMIT does not reach a committed write's answer: its
         transaction held the membership from BEGIN to COMMIT. A lost session or
         lifetime still withholds it, and the outcome stays unknown. */
      if (reason === 'membership') await attempt;
      else await assert.rejects(attempt, safe('unknown'));
      assert.equal(triggered, true);
      assert.equal(f.row()!.name, target);
      if (reason === 'membership') {
        await assert.rejects(service.preview(request, ['north']), safe('not_applied'));
      } else {
        const preview = await service.preview(request, ['north']);
        assert.equal(preview.next, undefined);
        assert.ok(preview.writes.length > 0, 'unknown inverse cannot have been forgotten');
        assert.equal(preview.writes[0].undoState, 'unknown');
        await assert.rejects(service.undo(request, ['north'], { expectedId: id }), safe(operation === 'undo' ? 'unknown' : 'not_applied'));
        assert.equal(f.row()!.name, target);
      }
    });
  }
}

test('duplicate Undo during postcommit acknowledgment is busy and cannot run twice or fall through to an older entry', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let armed = false,
    once = false;
  const service = await f.issue({
    verifySession: async () => {
      if (armed && !once && f.row()!.name === 'First') {
        once = true;
        entered.release();
        await released.promise;
      }
      return { id: 'alice', who: 'Alice' };
    },
  });
  const older = undoId(await service.update(request, ['north'], change('First')));
  const newer = undoId(await service.update(request, ['north'], change('Second')));
  armed = true;
  const running = service.undo(request, ['north'], { expectedId: newer });
  try {
    await entered.promise;
    await assert.rejects(service.undo(request, ['north'], { expectedId: newer }), safe('unknown'));
    await assert.rejects(service.undo(request, ['north'], { expectedId: older }), safe('unknown'));
    assert.equal(f.row()!.name, 'First');
  } finally {
    released.release();
  }
  assert.equal((await running).undone.id, newer);
  assert.equal((await service.preview(request, ['north'])).next?.id, older);
});

test('retirement stops admission synchronously and drains reserved authentication before closing', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let settled = false;
  const service = await f.issue({
    verifySession: async () => {
      entered.release();
      await released.promise;
      return { id: 'alice', who: 'Alice' };
    },
  });
  const running = assert.rejects(service.update(request, ['north'], change()), safe('not_applied'));
  await entered.promise;
  const retirement = service.retire();
  try {
    assert.equal(service.retire(), retirement);
    void retirement.then(() => {
      settled = true;
    });
    await assert.rejects(service.preview(request, ['north']), safe('not_applied'));
    await assert.rejects(service.update(request, ['north'], change()), safe('not_applied'));
    assert.equal(settled, false);
  } finally {
    released.release();
  }
  await running;
  await retirement;
  assert.equal(settled, true);
  assert.equal(f.row()!.name, 'Original');
});

test('retirement during postcommit delivery drains publication and preserves unknown outcome', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let once = false;
  const service = await f.issue({
    verifySession: async () => {
      if (!once && f.row()!.name === 'Changed') {
        once = true;
        entered.release();
        await released.promise;
      }
      return { id: 'alice', who: 'Alice' };
    },
  });
  const running = assert.rejects(service.update(request, ['north'], change()), safe('unknown'));
  await entered.promise;
  let retired = false;
  const retirement = service.retire();
  void retirement.then(() => {
    retired = true;
  });
  assert.equal(retired, false);
  released.release();
  await running;
  await retirement;
  assert.equal(retired, true);
  assert.equal(f.row()!.name, 'Changed');
});

test('even a valid own token grants no authority to supplied history images or another identity', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const id = undoId(await service.update(request, ['north'], change()));
  for (const extra of [
    { before: { name: 'Forged' } },
    { after: { name: 'Changed' } },
    { key: { id: 'south-row' } },
    { tenantId: 'south' },
    { accountId: 'bob' },
    { principal: { roles: ['admin'] } },
  ]) {
    await assert.rejects(service.undo(request, ['north'], { expectedId: id, ...extra }), safe('not_applied'));
    assert.equal(f.row()!.name, 'Changed');
    assert.equal((await service.preview(request, ['north'])).next?.id, id);
  }
  await service.undo(request, ['north'], { expectedId: id });
  assert.equal(f.row()!.name, 'Original');
});

test('pending Undo captures the exact token and selector before awaiting verification', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    released = gate();
  let armed = false;
  const service = await f.issue({
    verifySession: async () => {
      if (armed) {
        entered.release();
        await released.promise;
      }
      return { id: 'alice', who: 'Alice' };
    },
  });
  const north = undoId(await service.update(request, ['north'], change()));
  const south = undoId(await service.update(request, ['south'], change('South edit', 'south-row')));
  armed = true;
  const input = { expectedId: north },
    selectors = ['north'];
  const running = service.undo(request, selectors, input);
  await entered.promise;
  input.expectedId = south;
  selectors[0] = 'south';
  released.release();
  assert.equal((await running).undone.id, north);
  assert.equal(f.row()!.name, 'Original');
  assert.equal(f.row('south-row')!.name, 'South edit');
  assert.equal((await service.preview(request, ['south'])).next?.id, south);
});
