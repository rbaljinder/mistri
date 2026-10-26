import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource, type TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  provisionSqliteTenantStore,
  readSqliteTenantMembershipsSnapshot,
  TENANT_TABLES as tables,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';

const owner = { appId: 'app', source: { id: 'business', connection: 'private-connection' }, storeId: 'store' };
const lookup = () => ({ appId: 'app', accountId: 'alice', source: { ...owner.source }, deployment: 'generation' });
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  return true;
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-bootstrap-'));
  const path = join(dir, 'business.db'),
    db = new DatabaseSync(path);
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    await Promise.allSettled(sources.map((source) => source.close()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, label TEXT)',
  );
  provisionSqliteTenantStore(path, owner);
  const add = (tenantId: string, account = 'alice', status = 'active', tenantStatus = 'active', expiry = 10_000, roles = ['reader']) => {
    db.prepare(`INSERT OR IGNORE INTO "${tables.tenant}" VALUES (?, ?, '1', 'tenant')`).run(tenantId, tenantStatus);
    db.prepare(`INSERT INTO "${tables.membership}" VALUES (?, ?, ?, ?, '1', ?, ?, 'member', NULL, NULL, NULL)`).run(
      tenantId + '-' + account,
      tenantId,
      account,
      status,
      JSON.stringify(roles),
      expiry,
    );
  };
  db.exec('BEGIN');
  const schema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const logical = mapScopeCatalog(schema, new Map([['item', 'item']]));
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: logical,
    physicalSchema: schema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const open = (now = () => 100) => {
    const source = openSqliteTenantReadSource(path, ownership, owner, now);
    sources.push(source);
    return source;
  };
  return { db, add, open, path, ownership };
}

test('discovery returns exactly own active unexpired memberships in binary tenant order, without business reads', async (t) => {
  const f = fixture(t);
  f.add('z');
  f.add('a_');
  f.add('a-');
  f.add('other', 'Alice');
  f.add('bob', 'bob');
  f.add('invited', 'alice', 'invited');
  f.add('revoked', 'alice', 'revoked');
  f.add('suspended', 'alice', 'active', 'suspended');
  f.add('closed', 'alice', 'active', 'closed');
  f.add('expired', 'alice', 'active', 'active', 100);
  const source = f.open(),
    rows = await source.readMemberships(lookup());
  assert.deepEqual(
    rows.map((row) => row.tenantId),
    ['a-', 'a_', 'z'],
  );
  assert.ok(Object.isFrozen(rows) && rows.every((row) => Object.isFrozen(row) && Object.isFrozen(row.roles)));
  assert.equal(rows[0].membershipVersion, '1');
  assert.equal(rows[0].accountId, 'alice');
  assert.deepEqual(await source.readMemberships({ ...lookup(), accountId: 'unknown' }), []);
  assert.equal('query' in source || 'db' in source || 'transaction' in source, false);
});

test('256 is complete, 257 refuses, and ineligible memberships do not consume the bound', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 256; n++) f.add(`t${String(n).padStart(3, '0')}`);
  for (let n = 0; n < 10; n++) f.add(`expired${n}`, 'alice', 'active', 'active', 100);
  const source = f.open();
  assert.equal((await source.readMemberships(lookup())).length, 256);
  f.add('overflow');
  await assert.rejects(source.readMemberships(lookup()), safe);
});

for (const patch of [
  { appId: 'other' },
  { source: { ...owner.source, id: 'BUSINESS' } },
  { source: { ...owner.source, connection: 'alias' } },
  { accountId: ' alice' },
  { accountId: '' },
  { deployment: '' },
  { tenantId: 'north' },
  { extra: true },
]) {
  test(`discovery refuses mismatched/malformed lookup ${JSON.stringify(patch)}`, async (t) => {
    const f = fixture(t);
    f.add('north');
    await assert.rejects(f.open().readMemberships({ ...lookup(), ...patch }), safe);
  });
}

test('lookup capture precedes queue wait and never invokes proxies/getters', async (t) => {
  const f = fixture(t);
  f.add('north');
  const source = f.open();
  const input = lookup(),
    pending = source.readMemberships(input);
  input.accountId = 'bob';
  input.source.connection = 'changed';
  assert.equal((await pending)[0].accountId, 'alice');
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('private');
  };
  for (const hostile of [
    new Proxy(lookup(), { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty(lookup(), 'accountId', { get: trap }),
  ]) {
    await assert.rejects(source.readMemberships(hostile), safe);
  }
  assert.equal(hooks, 0);
});

test('snapshot helper refuses borrowed ownership when no transaction exists and never commits the owner transaction', (t) => {
  const f = fixture(t);
  f.add('north');
  assert.throws(() => readSqliteTenantMembershipsSnapshot(f.db, owner, lookup(), () => 100), safe);
  f.db.exec('BEGIN');
  assert.equal(readSqliteTenantMembershipsSnapshot(f.db, owner, lookup(), () => 100).length, 1);
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
});

for (const sql of [
  `UPDATE "${tables.meta}" SET store_id='replacement'`,
  `CREATE TRIGGER hostile AFTER UPDATE ON "${tables.membership}" BEGIN SELECT 1; END`,
  'ALTER TABLE item ADD COLUMN widened TEXT',
  'CREATE TABLE unknown_business(id TEXT)',
])
  test(`discovery refuses same-handle store or complete catalog drift: ${sql}`, async (t) => {
    const f = fixture(t);
    f.add('north');
    const source = f.open();
    f.db.exec(sql);
    await assert.rejects(source.readMemberships(lookup()), safe);
  });

test('TEMP store shadow is refused on that snapshot, but a separate writer TEMP cannot shadow the pinned reader', async (t) => {
  const f = fixture(t);
  f.add('north');
  const source = f.open();
  f.db.exec(`CREATE TEMP TABLE "${tables.membership}"(id TEXT)`);
  f.db.exec('BEGIN');
  assert.throws(() => readSqliteTenantMembershipsSnapshot(f.db, owner, lookup(), () => 100), safe);
  f.db.exec('ROLLBACK');
  assert.equal((await source.readMemberships(lookup())).length, 1);
});

for (const column of ['version', 'roles_json', 'id'])
  test(`malformed stored ${column} is refusal, never an empty result`, async (t) => {
    const f = fixture(t);
    f.add('north');
    const source = f.open();
    f.db.prepare(`UPDATE "${tables.membership}" SET ${column}=?`).run(column === 'roles_json' ? '["reader","reader"]' : '');
    await assert.rejects(source.readMemberships(lookup()), safe);
  });

for (const bad of [NaN, Infinity, -1, 1.5, '100'])
  test(`invalid discovery clock ${String(bad)} refuses`, async (t) => {
    const f = fixture(t);
    f.add('north');
    await assert.rejects(f.open(() => bad as number).readMemberships(lookup()), safe);
  });

test('expiry includes queue delay and refuses expiry or regression at snapshot completion', async (t) => {
  const f = fixture(t);
  f.add('north', 'alice', 'active', 'active', 200);
  let now = 100;
  const source = f.open(() => now),
    pending = source.readMemberships(lookup());
  now = 200;
  assert.deepEqual(await pending, []);
  for (const times of [
    [100, 200],
    [100, 99],
  ]) {
    await assert.rejects(f.open(() => times.shift()!).readMemberships(lookup()), safe);
  }
});

for (const boundary of [1, 2])
  test(`reentrant close at discovery clock ${boundary} prevents buffered release and drains queue`, async (t) => {
    const f = fixture(t);
    f.add('north');
    let calls = 0,
      closing: Promise<void> | undefined;
    const source = f.open(() => {
      if (++calls === boundary) closing = source.close();
      return 100;
    });
    const first = source.readMemberships(lookup()),
      second = source.readMemberships(lookup());
    await assert.rejects(first, safe);
    await assert.rejects(second, safe);
    await closing;
    await assert.rejects(source.readMemberships(lookup()), safe);
    assert.equal(source.close(), source.close());
  });
