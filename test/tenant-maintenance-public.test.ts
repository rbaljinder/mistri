/**
 * Public tenant maintenance (`@mistriwork/mistri/maintenance`): the operator steps that
 * seed a lender platform — its `@platform` row, dealers, platform staff and
 * dealer members, and the native accounts they sign in with — each one
 * transaction with its receipt/audit pair under `maintenance:<operator>`.
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server, on a
 * database of each test's own.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { validatePair } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalContract.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { pgClient, TENANT_DIALECTS, uuidPostgresDatabase, type TenantDialect } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'db' }, storeId: 'lending-store' };
const DAY = 24 * 60 * 60 * 1000;
const password = (name: string) => `maintenance-${name}-password-123`;
const people = ['ada', 'lee', 'sam', 'kim'].map((name) => ({ email: `${name}@example.test`, name, password: password(name) }));
type Row = Record<string, unknown>;

function writeApp(directory: string, store: string, patch: (manifest: Record<string, any>) => void = () => {}): string {
  const dir = join(directory, `app-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  const manifest: Record<string, any> = {
    id: 'lending',
    name: 'Lending',
    sources: { business: { connection: 'db' } },
    resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
    auth: {
      store,
      signUp: 'invite',
      rows: 'tenant',
      tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
      roles: {
        staff: { realm: 'tenant', read: true, write: ['lead'] },
        viewer: { realm: 'tenant', read: true },
        manager: { realm: 'platform', read: true },
        reviewer: { realm: 'platform', read: true },
        // A jobs module principal's role: no membership in either realm holds it.
        sweeper: { realm: 'tenant', read: true, service: true },
      },
    },
    views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
    nav: [
      { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
      { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
    ],
    home: 'leads',
  };
  patch(manifest);
  writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest));
  return dir;
}

async function fixture(t: TestContext, dialect: TenantDialect) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-maintenance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = writeApp(directory, join(directory, 'auth.db'));
  let where: maintenance.TenantMaintenanceTarget, all: (sql: string, ...params: unknown[]) => Promise<Row[]>;
  let exec: (sql: string, ...params: unknown[]) => Promise<void>;
  if (dialect === 'sqlite') {
    const path = join(directory, 'business.db'),
      db = new DatabaseSync(path);
    t.after(() => db.close());
    db.exec(
      'PRAGMA foreign_keys = ON; CREATE TABLE dealer (id TEXT PRIMARY KEY); CREATE TABLE lead (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)',
    );
    await maintenance.provisionStores({ sqlite: path }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
    where = { sqlite: path };
    all = async (sql, ...params) =>
      db
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }));
    exec = async (sql, ...params) => {
      db.prepare(sql).run(...(params as never[]));
    };
  } else {
    const { url, drop } = await uuidPostgresDatabase('tenant_maintenance');
    const control = await pgClient(url);
    t.after(async () => {
      await control.end().catch(() => {});
      await drop();
    });
    await control.query('CREATE TABLE dealer (id text PRIMARY KEY); CREATE TABLE lead (id text PRIMARY KEY, tenant_id text NOT NULL)');
    await maintenance.migratePostgresTenantStore(url, binding);
    await maintenance.migratePostgresTenantAdministrationJournal(url, binding);
    where = { postgres: url };
    const numbered = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    all = async (sql, ...params) => (await control.query(postgresRuntimeSql(numbered(sql)), params)).rows;
    exec = async (sql, ...params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    };
  }
  const receipts = () =>
    all(`SELECT r.actor_id AS actor, r.tenant_id AS tenant, r.operation, r.result_json AS result, r.change_json AS change,
    r.policy_id AS policy FROM "${journal.receipt}" r ORDER BY r.completed_at, r.id`);
  const memberships = () =>
    all(`SELECT id, tenant_id AS tenant, account_id AS account, status, version, roles_json AS roles, kind
    FROM "${tables.membership}" ORDER BY tenant_id, account_id, id`);
  const anchors = () => all(`SELECT id, status, version, kind FROM "${tables.tenant}" ORDER BY id`);
  return { directory, app, where, all, exec, receipts, memberships, anchors };
}

/** A stored refusal changes nothing: the same rows and receipts after as before. */
async function unchanged(f: Awaited<ReturnType<typeof fixture>>, attempt: () => Promise<unknown>, pattern: RegExp) {
  const before = JSON.stringify([await f.anchors(), await f.memberships(), await f.receipts()]);
  await assert.rejects(
    attempt(),
    (error: unknown) =>
      error instanceof maintenance.TenantMaintenanceRefusal &&
      error.outcome === 'not_applied' &&
      pattern.test(error.message) &&
      !/password-123/.test(error.message),
  );
  assert.equal(JSON.stringify([await f.anchors(), await f.memberships(), await f.receipts()]), before);
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const [ada, lee, sam, kim] = await maintenance.createAppAccounts(f.app, people);
  const operator = 'ops-ada';
  const platform = await maintenance.setPlatformStatus(f.where, binding, { status: 'active', expectedVersion: null, operator });
  const north = await maintenance.putTenant(f.where, binding, { tenantId: 'north', status: 'active', expectedVersion: null, operator });
  const south = await maintenance.putTenant(f.where, binding, { tenantId: 'south', status: 'active', expectedVersion: null, operator });
  return { ada, lee, sam, kim, operator, platform, north, south };
}

async function signsIn(app: string, email: string, secret: string): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-maintenance-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  try {
    auth = await createAppAuth(await loadApp(app), { baseURL: origin, trustedOrigins: [origin] });
    const handler = auth.handler;
    server.on('request', (req, res) => {
      void handler(req, res).catch(() => res.destroy());
    });
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: secret }),
    });
    await response.arrayBuffer();
    return response.status;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    auth?.close();
  }
}

test('the maintenance entry offers the tenant steps and no HTTP surface', () => {
  for (const name of [
    'putTenant',
    'setPlatformStatus',
    'grantPlatformMembership',
    'revokePlatformMembership',
    'grantTenantMembership',
    'revokeTenantMembership',
    'createAppAccounts',
    'TenantMaintenanceRefusal',
  ] as const)
    assert.equal(typeof maintenance[name], 'function', name);
});

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`tenant maintenance on ${dialect}`, { skip }, () => {
    test('seeds the platform, dealers, staff and members, each change with its receipt and audit', async (t) => {
      const f = await fixture(t, dialect);
      const { lee, sam, operator, platform, north, south } = await seed(f);
      assert.deepEqual([platform.version, platform.status, north.version, south.version], ['1', 'active', '1', '1']);
      const validUntil = Date.now() + 30 * DAY;
      const manager = await maintenance.grantPlatformMembership(f.where, binding, {
        app: f.app,
        accountId: lee,
        roles: ['manager', 'reviewer'],
        validUntil,
        operator,
      });
      const staff = await maintenance.grantTenantMembership(f.where, binding, {
        app: f.app,
        tenantId: 'north',
        accountId: sam,
        roles: ['staff'],
        validUntil,
        operator,
      });
      assert.equal(manager.version, '1');
      assert.equal(staff.version, '1');
      assert.deepEqual(
        (await f.memberships()).map((row) => [row.tenant, row.account, row.status, row.version, row.kind]),
        [
          ['@platform', lee, 'active', '1', 'member'],
          ['north', sam, 'active', '1', 'member'],
        ],
      );
      assert.deepEqual(JSON.parse((await f.memberships())[0].roles as string).sort(), ['manager', 'reviewer']);

      const suspended = await maintenance.putTenant(f.where, binding, {
        tenantId: 'north',
        status: 'suspended',
        expectedVersion: '1',
        operator,
      });
      assert.equal(suspended.version, '2');
      const stored = await f.receipts();
      assert.deepEqual(
        stored.map((row) => [row.actor, row.tenant, row.operation]),
        [
          ['maintenance:ops-ada', '@platform', 'setPlatformStatus'],
          ['maintenance:ops-ada', 'north', 'putTenant'],
          ['maintenance:ops-ada', 'south', 'putTenant'],
          ['maintenance:ops-ada', '@platform', 'grantPlatformMembership'],
          ['maintenance:ops-ada', 'north', 'grantTenantMembership'],
          ['maintenance:ops-ada', 'north', 'putTenant'],
        ],
      );
      for (const row of stored) {
        assert.equal(row.result, row.change);
        assert.equal(row.policy, 'mistri-maintenance');
      }
      assert.deepEqual(JSON.parse(stored[5].result as string), {
        operation: 'putTenant',
        before: { tenantId: 'north', status: 'active', version: '1' },
        after: { tenantId: 'north', status: 'suspended', version: '2' },
      });
      const grant = JSON.parse(stored[4].result as string);
      assert.equal(grant.membership.membershipId, staff.membershipId);
      assert.equal(grant.anchor.version, '1');
      assert.equal(JSON.stringify(stored).includes('password'), false);

      // A suspended dealer takes no new member; reactivation restores it.
      await unchanged(
        f,
        () =>
          maintenance.grantTenantMembership(f.where, binding, {
            app: f.app,
            tenantId: 'north',
            accountId: lee,
            roles: ['viewer'],
            validUntil,
            operator,
          }),
        /must exist and be active/,
      );
      await maintenance.putTenant(f.where, binding, { tenantId: 'north', status: 'active', expectedVersion: '2', operator });
      await maintenance.grantTenantMembership(f.where, binding, {
        app: f.app,
        tenantId: 'north',
        accountId: lee,
        roles: ['viewer'],
        validUntil,
        operator,
      });
    });

    test('versions are compare-and-set, closing is for good, and a stale step writes nothing', async (t) => {
      const f = await fixture(t, dialect);
      const { operator } = await seed(f);
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'north', status: 'active', expectedVersion: null, operator }),
        /nothing was written/,
      );
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'north', status: 'suspended', expectedVersion: '7', operator }),
        /nothing was written/,
      );
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'east', status: 'suspended', expectedVersion: null, operator }),
        /starts active/,
      );
      await unchanged(
        f,
        () => maintenance.setPlatformStatus(f.where, binding, { status: 'active', expectedVersion: null, operator }),
        /nothing was written/,
      );
      await maintenance.putTenant(f.where, binding, { tenantId: 'south', status: 'closed', expectedVersion: '1', operator });
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'south', status: 'active', expectedVersion: '2', operator }),
        /closed/,
      );
      // Inputs are exact; the reserved platform id is never a tenant id.
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: '@platform', status: 'active', expectedVersion: null, operator }),
        /tenant id/,
      );
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'east', status: 'active', expectedVersion: null, operator: 'ops ada' }),
        /operator/,
      );
      await unchanged(
        f,
        () => maintenance.putTenant(f.where, binding, { tenantId: 'east', status: 'active', expectedVersion: null } as never),
        /exactly/,
      );
      await unchanged(
        f,
        () =>
          maintenance.putTenant(
            f.where,
            { ...binding, storeId: 'another-store' },
            { tenantId: 'east', status: 'active', expectedVersion: null, operator },
          ),
        /nothing was written/,
      );
      // A platform suspension then keeps it closed to grants until it is active again.
      await maintenance.setPlatformStatus(f.where, binding, { status: 'suspended', expectedVersion: '1', operator });
      assert.deepEqual(
        (await f.anchors()).find((row) => row.id === '@platform'),
        { id: '@platform', status: 'suspended', version: '2', kind: 'platform' },
      );
    });

    test("role ceilings, lifetimes, liveness and the account are the loaded App's facts", async (t) => {
      const f = await fixture(t, dialect);
      const { lee, sam, operator } = await seed(f);
      const soon = Date.now() + DAY;
      const platform = (patch: Record<string, unknown>) =>
        maintenance.grantPlatformMembership(f.where, binding, {
          app: f.app,
          accountId: lee,
          roles: ['manager'],
          validUntil: soon,
          operator,
          ...patch,
        } as never);
      const tenant = (patch: Record<string, unknown>) =>
        maintenance.grantTenantMembership(f.where, binding, {
          app: f.app,
          tenantId: 'north',
          accountId: sam,
          roles: ['staff'],
          validUntil: soon,
          operator,
          ...patch,
        } as never);
      await unchanged(f, () => platform({ roles: ['staff'] }), /"staff" is not one of this App's platform-realm roles/);
      await unchanged(f, () => tenant({ roles: ['manager'] }), /"manager" is not one of this App's tenant-realm roles/);
      await unchanged(f, () => tenant({ roles: ['owner'] }), /"owner" is not one of this App's tenant-realm roles/);
      await unchanged(f, () => tenant({ roles: ['sweeper'] }), /"sweeper" is not one of this App's tenant-realm roles a person holds/);
      await unchanged(f, () => platform({ roles: ['sweeper'] }), /"sweeper" is not one of this App's platform-realm roles/);
      await unchanged(f, () => tenant({ roles: [] }), /1 to 256 distinct/);
      await unchanged(f, () => tenant({ validUntil: Date.now() + 367 * DAY }), /366 days/);
      await unchanged(f, () => tenant({ validUntil: Date.now() - 1 }), /future instant/);
      await unchanged(f, () => tenant({ accountId: 'no-such-account' }), /No account with that id/);
      await unchanged(f, () => platform({ accountId: 'no-such-account' }), /No account with that id/);
      await unchanged(f, () => tenant({ tenantId: 'east' }), /must exist and be active/);
      const other = writeApp(f.directory, join(f.directory, 'auth.db'), (manifest) => {
        manifest.id = 'other';
      });
      await unchanged(f, () => tenant({ app: other }), /not "lending"/);
      const flat = writeApp(f.directory, join(f.directory, 'auth.db'), (manifest) => {
        delete manifest.auth.tenancy.platform;
        delete manifest.resources.dealer;
        delete manifest.views.dealers;
        manifest.nav = ['leads'];
        for (const role of Object.values(manifest.auth.roles) as Record<string, unknown>[]) delete role.realm;
        delete manifest.auth.roles.manager;
        delete manifest.auth.roles.reviewer;
        delete manifest.auth.tenancy.profile;
      });
      await unchanged(f, () => platform({ app: flat }), /no platform realm/);

      // One live membership per account in a realm or a tenant.
      await platform({});
      await unchanged(f, () => platform({ roles: ['reviewer'] }), /already holds a live platform membership/);
      await tenant({});
      await unchanged(f, () => tenant({ roles: ['viewer'] }), /already holds a live membership in this tenant/);
      // A suspended platform takes no new staff.
      await maintenance.setPlatformStatus(f.where, binding, { status: 'suspended', expectedVersion: '1', operator });
      await unchanged(f, () => platform({ accountId: sam }), /must exist and be active/);
    });

    test('revoking a platform membership is terminal, and the support sessions under it end with it', async (t) => {
      const f = await fixture(t, dialect);
      const { lee, operator } = await seed(f);
      const granted = await maintenance.grantPlatformMembership(f.where, binding, {
        app: f.app,
        accountId: lee,
        roles: ['manager'],
        validUntil: Date.now() + DAY,
        operator,
      });
      // A support membership under it, as opening one writes it. This store has
      // no support audit, so there is no chain to close; the row still ends,
      // because what keeps a lease out is the row.
      await f.exec(
        `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind,
        parent_id, parent_version, platform_version) VALUES (?, 'north', ?, 'active', '1', '["staff"]', ?, 'support', ?, '1', '1')`,
        'support-lee',
        lee,
        Date.now() + DAY,
        granted.membershipId,
      );
      await unchanged(
        f,
        () =>
          maintenance.revokePlatformMembership(f.where, binding, { membershipId: granted.membershipId, expectedVersion: '2', operator }),
        /nothing was written/,
      );
      const revoked = await maintenance.revokePlatformMembership(f.where, binding, {
        membershipId: granted.membershipId,
        expectedVersion: '1',
        operator,
      });
      // No audit in this store, so there was no chain to verify or to fail.
      assert.deepEqual(
        { ...revoked, receiptId: 'receipt' },
        {
          membershipId: granted.membershipId,
          version: '2',
          receiptId: 'receipt',
          supportRevoked: ['support-lee'],
          supportChainUnverified: [],
        },
      );
      const rows = await f.memberships();
      assert.deepEqual(
        rows.map((row) => [row.id === granted.membershipId ? 'platform' : row.id, row.status, row.version]),
        [
          ['platform', 'revoked', '2'],
          ['support-lee', 'revoked', '2'],
        ],
      );
      const receipt = (await f.receipts()).at(-1)!;
      assert.equal(receipt.operation, 'revokePlatformMembership');
      assert.deepEqual(JSON.parse(receipt.result as string).supportRevoked, ['support-lee']);
      assert.deepEqual(JSON.parse(receipt.result as string).supportChainUnverified, []);
      await unchanged(
        f,
        () =>
          maintenance.revokePlatformMembership(f.where, binding, { membershipId: granted.membershipId, expectedVersion: '2', operator }),
        /nothing was written/,
      );
      // The support row is not a platform membership to revoke.
      await unchanged(
        f,
        () => maintenance.revokePlatformMembership(f.where, binding, { membershipId: 'support-lee', expectedVersion: '1', operator }),
        /nothing was written/,
      );
      // Revoked, the account may be granted again: one live membership, not one ever.
      await maintenance.grantPlatformMembership(f.where, binding, {
        app: f.app,
        accountId: lee,
        roles: ['reviewer'],
        validUntil: Date.now() + DAY,
        operator,
      });
    });

    test('revoking a tenant membership is terminal, journaled, and idempotent', async (t) => {
      const f = await fixture(t, dialect);
      const { lee, sam, operator } = await seed(f);
      const validUntil = Date.now() + DAY;
      const granted = await maintenance.grantTenantMembership(f.where, binding, {
        app: f.app,
        tenantId: 'north',
        accountId: sam,
        roles: ['staff'],
        validUntil,
        operator,
      });
      const revoke = (patch: Record<string, unknown> = {}) =>
        maintenance.revokeTenantMembership(f.where, binding, {
          tenantId: 'north',
          membershipId: granted.membershipId,
          expectedVersion: '1',
          operator,
          ...patch,
        } as never);
      await unchanged(f, () => revoke({ expectedVersion: '2' }), /nothing was written/);
      await unchanged(f, () => revoke({ tenantId: 'south' }), /nothing was written/);
      await unchanged(f, () => revoke({ membershipId: 'no-such-membership' }), /nothing was written/);
      // A platform membership is not a tenant's to revoke.
      const staff = await maintenance.grantPlatformMembership(f.where, binding, {
        app: f.app,
        accountId: lee,
        roles: ['manager'],
        validUntil,
        operator,
      });
      await unchanged(f, () => revoke({ tenantId: '@platform', membershipId: staff.membershipId }), /tenant id/);
      await unchanged(f, () => revoke({ membershipId: staff.membershipId }), /nothing was written/);

      const revoked = await revoke();
      assert.deepEqual({ ...revoked, receiptId: 'receipt' }, { membershipId: granted.membershipId, version: '2', receiptId: 'receipt' });
      assert.equal(typeof revoked.receiptId, 'string');
      assert.deepEqual(
        (await f.memberships()).filter((row) => row.tenant === 'north').map((row) => [row.status, row.version]),
        [['revoked', '2']],
      );
      const receipt = (await f.receipts()).at(-1)!;
      assert.deepEqual([receipt.actor, receipt.tenant, receipt.operation], ['maintenance:ops-ada', 'north', 'revokeTenantMembership']);
      const change = JSON.parse(receipt.result as string);
      assert.deepEqual(
        [change.before.status, change.after.status, change.after.version, change.anchor.tenantId],
        ['active', 'revoked', '2', 'north'],
      );

      // Again, at any version: nothing written, nothing journaled, no receipt.
      const before = JSON.stringify([await f.memberships(), await f.receipts()]);
      assert.deepEqual(await revoke(), { membershipId: granted.membershipId, version: '2', receiptId: null });
      assert.deepEqual(await revoke({ expectedVersion: '2' }), { membershipId: granted.membershipId, version: '2', receiptId: null });
      assert.equal(JSON.stringify([await f.memberships(), await f.receipts()]), before);
      // Revoked, the account may be granted again.
      await maintenance.grantTenantMembership(f.where, binding, {
        app: f.app,
        tenantId: 'north',
        accountId: sam,
        roles: ['staff'],
        validUntil,
        operator,
      });
    });

    test('a stored maintenance receipt validates only as maintenance', async (t) => {
      const f = await fixture(t, dialect);
      await seed(f);
      const [row] = await f.all(`SELECT * FROM "${journal.receipt}" r WHERE r.operation = 'putTenant' LIMIT 1`);
      const receipt = {
        id: row.id,
        actorId: row.actor_id,
        tenantId: row.tenant_id,
        operation: row.operation,
        operationVersion: Number(row.operation_version),
        idempotencyKey: row.idempotency_key,
        fingerprint: row.fingerprint,
        resultJson: row.result_json,
        requestId: row.request_id,
        completedAt: row.completed_at,
      } as never;
      const audit = {
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        deployment: row.deployment,
        sessionId: row.session_id,
        changeJson: row.change_json,
      } as never;
      validatePair(receipt, audit);
      const tampered = (patch: Record<string, unknown>, auditPatch: Record<string, unknown> = {}) =>
        assert.throws(() => validatePair({ ...(receipt as object), ...patch } as never, { ...(audit as object), ...auditPatch } as never));
      tampered({ actorId: 'ops-ada' });
      tampered({ actorId: 'maintenance:' });
      tampered({}, { policyId: 'administrators' });
      tampered({
        resultJson: JSON.stringify({
          ...JSON.parse(row.result_json as string),
          after: { tenantId: 'north', status: 'active', version: '2' },
        }),
      });
      tampered({ tenantId: '@platform' });
    });

    test('createAppAccounts makes native accounts that sign in, and refuses a whole batch that names a taken address', async (t) => {
      const f = await fixture(t, dialect);
      const ids = await maintenance.createAppAccounts(f.app, people.slice(0, 2));
      assert.equal(ids.length, 2);
      assert.notEqual(ids[0], ids[1]);
      const auth = new DatabaseSync(join(f.directory, 'auth.db'));
      t.after(() => auth.close());
      const users = () =>
        auth
          .prepare('SELECT id, email, name FROM "user" ORDER BY email')
          .all()
          .map((row) => ({ ...row }));
      assert.deepEqual(users(), [
        { id: ids[0], email: 'ada@example.test', name: 'ada' },
        { id: ids[1], email: 'lee@example.test', name: 'lee' },
      ]);
      // Each is a row of the account trail, made by the maintenance step, with the role the store gave it.
      const roles = auth
        .prepare('SELECT role FROM "user" ORDER BY email')
        .all()
        .map((row) => String(row.role).split(','));
      const trail = auth
        .prepare('SELECT * FROM "accountAudit" ORDER BY targetEmail')
        .all()
        .map(({ id, createdAt, after, ...row }) => ({ ...row, after: JSON.parse(String(after)) }));
      assert.deepEqual(
        trail,
        ['ada', 'lee'].map((name, index) => ({
          action: 'create',
          actorId: 'maintenance',
          actorEmail: '',
          principal: 'maintenance',
          targetId: ids[index],
          targetEmail: `${name}@example.test`,
          before: null,
          after: { email: `${name}@example.test`, name, roles: roles[index], active: true },
        })),
      );
      assert.equal(JSON.stringify(trail).includes('password'), false);
      const credentials = auth.prepare(`SELECT password FROM "account" WHERE providerId = 'credential'`).all();
      assert.equal(credentials.length, 2);
      assert.ok(credentials.every((row) => typeof row.password === 'string' && !row.password.includes('password-123')));
      assert.equal(await signsIn(f.app, 'ada@example.test', password('ada')), 200);
      assert.equal(await signsIn(f.app, 'ada@example.test', password('lee')), 401);

      const refused = async (accounts: unknown, pattern: RegExp, app = f.app) => {
        const before = JSON.stringify(users());
        await assert.rejects(
          maintenance.createAppAccounts(app, accounts as never),
          (error: unknown) =>
            error instanceof maintenance.TenantMaintenanceRefusal && pattern.test(error.message) && !/password-123/.test(error.message),
        );
        assert.equal(JSON.stringify(users()), before);
      };
      await refused(
        [people[2], { ...people[1], email: 'LEE@example.test' }],
        /already have accounts, so none was created: lee@example\.test/,
      );
      await refused([people[2], people[2]], /listed twice/);
      await refused([{ ...people[2], password: 'short' }], /Account 1 is not valid/);
      await refused([{ ...people[2], email: 'not an address' }], /Account 1 is not valid/);
      await refused([{ ...people[2], name: '' }], /Account 1 is not valid/);
      await refused([{ ...people[2], role: 'admin' }], /Account 1 is not valid/);
      await refused([], /1 to 256/);
      const social = writeApp(f.directory, join(f.directory, 'auth.db'), (manifest) => {
        manifest.auth.providers = ['github'];
      });
      await refused([people[2]], /does not sign in with email/, social);

      // An account whose row of the trail cannot be written is not made.
      auth.exec('CREATE TRIGGER audit_refused BEFORE INSERT ON "accountAudit" BEGIN SELECT RAISE(ABORT, \'refused\'); END');
      const before = JSON.stringify(users());
      await assert.rejects(maintenance.createAppAccounts(f.app, [people[2]]), maintenance.TenantMaintenanceRefusal);
      assert.equal(JSON.stringify(users()), before);
      auth.exec('DROP TRIGGER audit_refused');
    });

    if (dialect === 'postgres')
      test('a PostgreSQL auth store: accounts are made there and grants look them up there', async (t) => {
        const f = await fixture(t, dialect);
        const store = await uuidPostgresDatabase('tenant_maintenance_auth');
        t.after(store.drop);
        await migratePostgresAuthStore(store.url);
        const app = writeApp(f.directory, store.url);
        const [ada] = await maintenance.createAppAccounts(app, people.slice(0, 1));
        const control = await pgClient(store.url);
        try {
          assert.deepEqual((await control.query(`SELECT action, "actorId", principal, "targetId" FROM mistri.auth_account_audit`)).rows, [
            { action: 'create', actorId: 'maintenance', principal: 'maintenance', targetId: ada },
          ]);
        } finally {
          await control.end();
        }
        const operator = 'ops-ada';
        await maintenance.putTenant(f.where, binding, { tenantId: 'north', status: 'active', expectedVersion: null, operator });
        await maintenance.grantTenantMembership(f.where, binding, {
          app,
          tenantId: 'north',
          accountId: ada,
          roles: ['staff'],
          validUntil: Date.now() + DAY,
          operator,
        });
        await assert.rejects(
          maintenance.grantTenantMembership(f.where, binding, {
            app,
            tenantId: 'north',
            accountId: 'no-such-account',
            roles: ['staff'],
            validUntil: Date.now() + DAY,
            operator,
          }),
          /No account with that id/,
        );
        await assert.rejects(maintenance.createAppAccounts(app, people.slice(0, 1)), /already have accounts/);
      });
  });
}
