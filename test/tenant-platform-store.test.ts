import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { PLATFORM_TENANT_ID, type PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import {
  TENANT_TABLES as tables,
  createSqliteTenantAdministration,
  createSqliteTenantMembershipGuard,
  provisionSqliteTenantStore,
  readSqlitePlatformMembership,
  readSqliteTenantMembership,
  readSqliteTenantMembershipsSnapshot,
  type TenantStoreBinding,
} from '../packages/mistri/src/server/tenant/tenantStore.js';

/* Store v2 on SQLite: the platform realm's reserved row and memberships, and
   the support-membership columns carried for the support slice. */

const source = { id: 'business', connection: 'owned-business' };
const binding = (): TenantStoreBinding => ({ appId: 'app', source, storeId: 'store-1' });
const platformLookup = (accountId = 'lee') => ({ realm: 'platform' as const, appId: 'app', accountId, source, deployment: 'generation-1' });
const tenantLookup = (accountId: string, tenantId: string) => ({ appId: 'app', accountId, tenantId, source, deployment: 'generation-1' });
const evidence = (patch: Partial<PlatformMembershipEvidence> = {}): PlatformMembershipEvidence => ({
  ...platformLookup(),
  membershipId: 'platform-lee',
  membershipVersion: '1',
  platformVersion: '1',
  roles: ['manager'],
  verifiedAt: 50,
  validUntil: 5000,
  ...patch,
});
type Administration = ReturnType<typeof createSqliteTenantAdministration>;
type Guard = ReturnType<typeof createSqliteTenantMembershipGuard>;

async function withStore(work: (db: DatabaseSync) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-platform-store-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE business_record (id TEXT PRIMARY KEY)');
    assert.deepEqual(provisionSqliteTenantStore(path, binding()), { version: 1, provisioned: true });
    await work(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function transaction(db: DatabaseSync, work: (admin: Administration, guard: Guard) => Promise<void>): Promise<void> {
  db.exec('BEGIN');
  const operations = new TransactionOperations();
  try {
    await work(
      createSqliteTenantAdministration(db, operations, binding()),
      createSqliteTenantMembershipGuard(db, operations, binding(), () => 100),
    );
    await operations.finish();
    db.exec('COMMIT');
  } catch (error) {
    try {
      await operations.finish();
    } catch {
      /* The original refusal is the assertion target. */
    }
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
async function seed(db: DatabaseSync) {
  await transaction(db, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      status: 'active',
      roles: ['staff'],
      validUntil: 10_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'lee',
      membershipId: 'platform-lee',
      status: 'active',
      roles: ['manager'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  });
}
const refused = (work: () => Promise<unknown>) => assert.rejects(work, TenantContextError);

test('the platform row is one reserved row that no tenant path can name', async () =>
  withStore(async (db) => {
    await seed(db);
    assert.deepEqual(
      db
        .prepare(`SELECT id, kind FROM "${tables.tenant}" ORDER BY id`)
        .all()
        .map((row) => ({ ...row })),
      [
        { id: PLATFORM_TENANT_ID, kind: 'platform' },
        { id: 'north', kind: 'tenant' },
      ],
    );
    // The layout itself: the reserved id is the platform kind and nothing else is.
    for (const row of [`('${PLATFORM_TENANT_ID}', 'active', '1', 'tenant')`, `('south', 'active', '1', 'platform')`]) {
      assert.throws(() => db.exec(`INSERT INTO "${tables.tenant}" VALUES ${row}`), /CHECK constraint failed/);
    }
    // Maintenance: a tenant change can never name the platform row, and the platform row is created once.
    await refused(() =>
      transaction(db, (admin) => admin.putTenant({ tenantId: PLATFORM_TENANT_ID, status: 'active', expectedVersion: null })),
    );
    await refused(() =>
      transaction(db, (admin) => admin.putTenant({ tenantId: PLATFORM_TENANT_ID, status: 'suspended', expectedVersion: '1' })),
    );
    await refused(() =>
      transaction(db, (admin) =>
        admin.putMembership({
          tenantId: PLATFORM_TENANT_ID,
          accountId: 'mallory',
          membershipId: 'sneaky',
          status: 'active',
          roles: ['manager'],
          validUntil: 10_000,
          expectedVersion: null,
        }),
      ),
    );
    await refused(() => transaction(db, (admin) => admin.putPlatform({ status: 'active', expectedVersion: null })));
    await refused(() =>
      transaction(db, (admin) => admin.putPlatform({ tenantId: 'north', status: 'active', expectedVersion: null } as never)),
    );
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${tables.membership}" WHERE id = 'sneaky'`).get()?.n, 0);
  }));

test('platform memberships read as platform records only; tenant admission and discovery never see them', async () =>
  withStore(async (db) => {
    await seed(db);
    assert.deepEqual(
      { ...readSqlitePlatformMembership(db, binding(), platformLookup()) },
      {
        realm: 'platform',
        appId: 'app',
        accountId: 'lee',
        platformStatus: 'active',
        platformVersion: '1',
        membershipId: 'platform-lee',
        membershipVersion: '1',
        status: 'active',
        roles: ['manager'],
        validUntil: 10_000,
      },
    );
    assert.equal(readSqlitePlatformMembership(db, binding(), platformLookup('alice')), null);
    // `@platform` fails the selector, so a tenant lookup cannot even ask for it.
    assert.throws(() => readSqliteTenantMembership(db, binding(), tenantLookup('lee', PLATFORM_TENANT_ID)), TenantContextError);
    // A tenant lookup is not a platform lookup, nor the reverse.
    assert.throws(() => readSqlitePlatformMembership(db, binding(), tenantLookup('lee', 'north') as never), TenantContextError);
    assert.throws(() => readSqliteTenantMembership(db, binding(), platformLookup() as never), TenantContextError);
    db.exec('BEGIN');
    const discover = (accountId: string) =>
      readSqliteTenantMembershipsSnapshot(db, binding(), { appId: 'app', accountId, source, deployment: 'generation-1' }, () => 100).map(
        (record) => record.tenantId,
      );
    assert.deepEqual(discover('lee'), []);
    assert.deepEqual(discover('alice'), ['north']);
    db.exec('COMMIT');
  }));

test('the platform guard fences revocation, suspension and a changed platform version', async () =>
  withStore(async (db) => {
    await seed(db);
    await transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence()));
    // Each realm's guard takes its own evidence only.
    await refused(() => transaction(db, async (_admin, guard) => guard.assertCurrent(evidence() as never)));
    await refused(() =>
      transaction(db, async (_admin, guard) => guard.assertPlatformCurrent({ ...evidence(), roles: ['manager', 'admin'] })),
    );
    // Suspending the platform row stops the whole realm; its version moves.
    await transaction(db, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
    await refused(() => transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence())));
    await refused(() => transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence({ platformVersion: '2' }))));
    await transaction(db, (admin) => admin.putPlatform({ status: 'active', expectedVersion: '2' }));
    await refused(() => transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence())));
    await transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence({ platformVersion: '3' })));
    // Revoking the membership ends it.
    await transaction(db, (admin) =>
      admin.putPlatformMembership({
        accountId: 'lee',
        membershipId: 'platform-lee',
        status: 'revoked',
        roles: ['manager'],
        validUntil: 10_000,
        expectedVersion: '1',
      }),
    );
    await refused(() => transaction(db, async (_admin, guard) => guard.assertPlatformCurrent(evidence({ platformVersion: '3' }))));
    // Closed is terminal, as for a tenant.
    await transaction(db, (admin) => admin.putPlatform({ status: 'closed', expectedVersion: '3' }));
    await refused(() => transaction(db, (admin) => admin.putPlatform({ status: 'active', expectedVersion: '4' })));
  }));

test('support rows are carried for the support slice and never admit through a member read', async () =>
  withStore(async (db) => {
    await seed(db);
    const insert = (values: string) =>
      db.exec(`INSERT INTO "${tables.membership}"
    (id, tenant_id, account_id, status, version, roles_json, valid_until, kind, parent_id, parent_version, platform_version) VALUES ${values}`);
    insert(`('support-lee', 'north', 'lee', 'active', '1', '["staff"]', 10000, 'support', 'platform-lee', '1', '1')`);
    assert.equal(readSqliteTenantMembership(db, binding(), tenantLookup('lee', 'north')), null);
    db.exec('BEGIN');
    assert.deepEqual(
      readSqliteTenantMembershipsSnapshot(db, binding(), { appId: 'app', accountId: 'lee', source, deployment: 'generation-1' }, () => 100),
      [],
    );
    db.exec('COMMIT');
    // A support row names its parent and the versions it was opened against; a member row names none.
    for (const values of [
      `('s2', 'north', 'kim', 'active', '1', '[]', 10000, 'support', NULL, '1', '1')`,
      `('s3', 'north', 'kim', 'active', '1', '[]', 10000, 'support', 'platform-lee', NULL, '1')`,
      `('s4', 'north', 'kim', 'active', '1', '[]', 10000, 'support', 'platform-lee', '1', NULL)`,
      `('m2', 'north', 'kim', 'active', '1', '[]', 10000, 'member', 'platform-lee', '1', '1')`,
      // A support session is never an invitation.
      `('s5', 'north', 'kim', 'invited', '1', '[]', 10000, 'support', 'platform-lee', '1', '1')`,
    ])
      assert.throws(() => insert(values), /CHECK constraint failed/);
    // One live support session per account, while an ordinary membership beside it stays legal.
    assert.throws(
      () => insert(`('support-lee-2', 'north', 'lee', 'active', '1', '[]', 10000, 'support', 'platform-lee', '1', '1')`),
      /UNIQUE/,
    );
    insert(`('north-lee', 'north', 'lee', 'active', '1', '["staff"]', 10000, 'member', NULL, NULL, NULL)`);
    assert.equal(readSqliteTenantMembership(db, binding(), tenantLookup('lee', 'north'))?.membershipId, 'north-lee');
  }));
