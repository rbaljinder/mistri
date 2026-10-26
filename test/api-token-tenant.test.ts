/** S1 of the API tenant bridge on SQLite: a token record's tenant membership
 * binding through the codec and the v2 layout, an `all` App refusing a bound
 * token, and `api-token issue --tenant` through the real CLI against a tenant
 * App with two tenants — issued only for an active membership of the named
 * tenant, bound to that membership's current version. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { SQLITE_API_TOKEN_DDL, SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { captureApiTokenRecord, narrowApiTokenScope } from '../packages/mistri/src/server/api/apiTokenScope.js';
import { decodeApiTokenSqlRow, encodeApiTokenSqlRow } from '../packages/mistri/src/server/api/apiTokenStorageContract.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, SESSION_SECRET, tokenCli, writeDepotApp } from './appApiCli.js';

const tokenId = '36c77f92-cf69-412d-ade3-3971490fb83a';
const binding = { tenantId: 'north', membershipId: 'm-alice-north', membershipVersion: '1' };
const stored = (tenant?: typeof binding) => ({
  format: 'twa1',
  digest: 'ab'.repeat(32),
  version: '1',
  record: {
    id: tokenId,
    appId: 'depot',
    subject: { kind: 'account', id: 'alice' },
    label: 'Depot',
    roles: ['member'],
    createdAt: 100,
    createdBy: 'operator',
    expiresAt: 8640000000000000,
    ...(tenant ? { tenant } : {}),
  },
});

test('the codec and the v2 layout keep a tenant binding whole, and refuse a partial one', () => {
  const row = encodeApiTokenSqlRow(stored(binding));
  assert.deepEqual([row.tenant_id, row.membership_id, row.membership_version], ['north', 'm-alice-north', '1']);
  assert.deepEqual(decodeApiTokenSqlRow(row).record.tenant, binding);
  const unbound = encodeApiTokenSqlRow(stored());
  assert.deepEqual([unbound.tenant_id, unbound.membership_id, unbound.membership_version], [null, null, null]);
  assert.equal(Object.hasOwn(decodeApiTokenSqlRow(unbound).record, 'tenant'), false);
  for (const change of [{ membership_version: null }, { tenant_id: null }, { membership_id: null }]) {
    assert.throws(() => decodeApiTokenSqlRow({ ...row, ...change }));
  }
  for (const tenant of [
    { ...binding, tenantId: 'North' },
    { ...binding, tenantId: '@platform' },
    { ...binding, membershipVersion: '0' },
    { ...binding, membershipVersion: '01' },
    { tenantId: 'north', membershipId: 'm' },
  ]) {
    assert.throws(() => captureApiTokenRecord(stored(tenant as typeof binding).record));
  }
  const db = new DatabaseSync(':memory:');
  try {
    for (const ddl of SQLITE_API_TOKEN_DDL) db.exec(ddl);
    const insert = (values: Record<string, unknown>) =>
      db
        .prepare(`INSERT INTO "${SQLITE_API_TOKEN_TABLES.token}" (${Object.keys(values).join(',')})
      VALUES (${Object.keys(values)
        .map(() => '?')
        .join(',')})`)
        .run(...(Object.values(values) as never[]));
    insert(row);
    assert.deepEqual(decodeApiTokenSqlRow(db.prepare(`SELECT * FROM "${SQLITE_API_TOKEN_TABLES.token}"`).get()).record.tenant, binding);
    db.exec(`DELETE FROM "${SQLITE_API_TOKEN_TABLES.token}"`);
    // The physical layer refuses what the codec refuses.
    for (const change of [{ membership_version: null }, { tenant_id: null }, { tenant_id: 'North' }, { membership_version: '01' }]) {
      assert.throws(() => insert({ ...row, ...change }));
    }
    assert.throws(() => db.prepare(`INSERT INTO "${SQLITE_API_TOKEN_TABLES.meta}" VALUES(1,2,'depot',?,'twa1')`).run(tokenId));
  } finally {
    db.close();
  }
});

test('an all App refuses a token bound to a tenant membership', () => {
  const app = parseAppConfig(
    {
      id: 'depot',
      name: 'Depot',
      connection: 'data',
      resources: { item: {} },
      auth: { roles: { member: { read: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['member'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const scope = (tenant?: typeof binding) =>
    narrowApiTokenScope(
      stored(tenant).record,
      app,
      { appId: 'depot', subject: { kind: 'account', id: 'alice' }, eligible: true, roles: ['member'] },
      [{ id: 'list:item', eligibleRoles: ['member'] }],
      1000,
    );
  assert.deepEqual(scope().operations, ['list:item']);
  assert.throws(() => scope(binding));
});

/** The depot App on SQLite: two tenants, alice a member of north only, bob of
 * south only, and an operator account; the token store provisioned by the CLI. */
async function depot(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-token-tenant-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  t.after(() => db.close());
  db.exec(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
  const { appDir, config, policy } = writeDepotApp(directory, { business, authStore: authPath, physical: 'physical_item' });
  const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
  provisionSqliteTenantStore(business, store);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, store));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const [account, tenantId] of [
      ['alice', 'north'],
      ['bob', 'south'],
    ]) {
      await admin.putMembership({
        tenantId,
        accountId: account,
        membershipId: `m-${account}-${tenantId}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 3600000,
        expectedVersion: null,
      });
    }
  });
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }
  const accounts = new DatabaseSync(authPath);
  try {
    for (const id of ['alice', 'bob', 'operator'])
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
  } finally {
    accounts.close();
  }
  const storeId = '5b1f0c52-7c1e-4c55-9e0a-4a7f3f0c2d11',
    common = ['--app', appDir, '--config', config, '--store-id', storeId];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const issue = (subject: string, extra: readonly string[]) =>
    tokenCli([
      'issue',
      ...common,
      '--subject',
      subject,
      '--actor',
      'operator',
      '--role',
      'member',
      '--label',
      'Depot',
      '--expires-at',
      new Date(Date.now() + 600000).toISOString(),
      ...extra,
    ]);
  return { directory, appDir, config, policy, common, issue, maintenance };
}

test('api-token issue --tenant binds an active membership of the named tenant, and nothing else', { timeout: 180000 }, async (t) => {
  const f = await depot(t);
  const tenant = (id: string) => ['--tenant', id, '--policy', f.policy];
  const issued = await f.issue('alice', tenant('north'));
  assert.equal(issued.code, 0, issued.err);
  const { result } = JSON.parse(issued.out) as { result: { token: string; tokenId: string } };
  const inspected = await tokenCli(['inspect', ...f.common, '--token-id', result.tokenId]);
  assert.equal(inspected.code, 0, inspected.err);
  assert.deepEqual(JSON.parse(inspected.out).result.record.tenant, {
    tenantId: 'north',
    membershipId: 'm-alice-north',
    membershipVersion: '1',
  });
  assert.equal(inspected.out.includes(result.token), false);
  // Not a member of south; no such tenant; unbound; command exposure: nothing is issued.
  for (const extra of [tenant('south'), tenant('west'), [], [...tenant('north'), '--commands', join(f.directory, 'commands.mts')]]) {
    const refused = await f.issue('alice', extra);
    assert.equal(refused.code, 2, extra.join(' '));
    assert.equal(refused.out, '');
  }
  // bob's own tenant issues for bob, and binds bob's membership.
  const bob = await f.issue('bob', tenant('south'));
  assert.equal(bob.code, 0, bob.err);
  // A revoked membership issues nothing, whatever the account's native state.
  await f.maintenance((admin) =>
    admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'm-alice-north',
      status: 'revoked',
      roles: ['member'],
      validUntil: Date.now() + 3600000,
      expectedVersion: '1',
    }),
  );
  assert.equal((await f.issue('alice', tenant('north'))).code, 2);
});

test(
  'a tenant catalog refuses the managed ownership column and platform roles before anything is issued',
  { timeout: 120000 },
  async (t) => {
    const f = await depot(t);
    for (const api of [{ version: 1, roles: ['member'], resources: { item: { fields: ['id', 'tenant_id'] } } }]) {
      const app = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(f.appDir, 'app.json'), 'utf8')));
      writeFileSync(join(f.appDir, 'app.json'), JSON.stringify({ ...app, api }));
      writeFileSync(join(f.appDir, 'authority.lock'), (await loadApp(f.appDir, { lock: 'report' })).authority!.report);
      const refused = await f.issue('alice', ['--tenant', 'north', '--policy', f.policy]);
      assert.equal(refused.code, 2);
      assert.equal(refused.out, '');
    }
  },
);
