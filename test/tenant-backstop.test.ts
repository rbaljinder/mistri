/**
 * The row-security backstop's wiring, without a server (docs/postgresql.md): the connection's `"backstop"` and
 * `"owner"` as the config reads them, the engine's refusal of a scoped read or write that forgot its tenant, and
 * the routing a tenant host does on top — which tenant a write's policy reads, and which pool and role each
 * adapter is handed. postgres-tenant-backstop.test.ts proves the same against a real server.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { loadConfig } from '../packages/engine/src/server/connections.js';
import { backstopOf } from '../packages/engine/src/server/poolConfig.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import {
  declareTenantBackstop,
  forgetTenantPools,
  tenantAdapter,
  tenantBackstop,
} from '../packages/mistri/src/server/tenant/tenantConnections.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import type { PlatformTenantEvidence } from '../packages/mistri/src/server/tenant/tenantPlatformTenant.js';
import { memberWriteKind } from '../packages/mistri/src/server/tenant/tenantWriteKindMember.js';
import { platformWriteKind } from '../packages/mistri/src/server/tenant/tenantWriteKindPlatform.js';
import { platformTenantWriteKind } from '../packages/mistri/src/server/tenant/tenantWriteKindPlatformTenant.js';
import { backstopTenantOf } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';

const RUNTIME = 'postgres://app_runtime@db:5432/app';
const OWNER = 'postgres://app_owner@db:5432/app';
const check = (entry: Record<string, unknown>, http = false) => backstopOf({ name: 'main', ...entry }, http, 'mistri.json');

test('"backstop" and "owner" come together, on PostgreSQL alone', () => {
  assert.equal(check({ url: RUNTIME }), undefined);
  assert.deepEqual(check({ url: RUNTIME, owner: ` ${OWNER} `, backstop: 'rls' }), { owner: OWNER, backstop: 'rls' });
  assert.deepEqual(check({ url: '${RUNTIME_URL}', owner: '${OWNER_URL}', backstop: 'rls' }), {
    owner: '${OWNER_URL}',
    backstop: 'rls',
  });
  assert.throws(() => check({ url: 'https://api.example.com', owner: OWNER, backstop: 'rls' }, true), /HTTP connection/);
  assert.throws(() => check({ url: RUNTIME, owner: OWNER }), /"owner" without "backstop"/);
  assert.throws(() => check({ url: RUNTIME, owner: OWNER, backstop: 'force' }), /The one backstop is "rls"/);
  assert.throws(() => check({ url: RUNTIME, owner: OWNER, backstop: true }), /The one backstop is "rls"/);
  assert.throws(() => check({ url: RUNTIME, backstop: 'rls' }), /without "owner"/);
  assert.throws(() => check({ url: RUNTIME, owner: '', backstop: 'rls' }), /must be a PostgreSQL URL/);
  assert.throws(() => check({ url: RUNTIME, owner: 5, backstop: 'rls' }), /must be a PostgreSQL URL/);
  assert.throws(() => check({ url: RUNTIME, owner: 'mysql://owner@db/app', backstop: 'rls' }), /not a PostgreSQL URL/);
  assert.throws(() => check({ url: './shop.db', owner: OWNER, backstop: 'rls' }), /SQLite has no roles/);
});

test('loadConfig carries "backstop" and "owner" on the connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-backstop-'));
  try {
    const file = join(directory, 'mistri.json');
    writeFileSync(file, JSON.stringify({ connections: [{ name: 'main', url: RUNTIME, owner: OWNER, backstop: 'rls' }] }));
    const loaded = await loadConfig(file, CONFIG_SECTIONS);
    assert.equal(loaded?.connections[0].backstop, 'rls');
    assert.equal(loaded?.connections[0].owner, OWNER);
    writeFileSync(file, JSON.stringify({ connections: [{ name: 'main', url: RUNTIME, backstop: 'rls' }] }));
    await assert.rejects(loadConfig(file, CONFIG_SECTIONS), /without "owner"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/* Never connected: every case below refuses, or answers, before a statement is sent. */
const adapter = (options: ConstructorParameters<typeof PostgresAdapter>[5] = {}) =>
  new PostgresAdapter('postgres://nobody@127.0.0.1:1/none', 'backstop proof', ['public'], undefined, undefined, options);

test('under the backstop the engine refuses a tenant read or write that names no tenant, and sets the one it is given', async () => {
  const runtime = adapter({ rowSecurity: { role: 'app_runtime' } });
  const owner = adapter({ rowSecurity: { role: 'app_runtime', bypass: true } });
  const plain = adapter();
  try {
    const set = (on: PostgresAdapter, tenant: string | null | undefined) =>
      (on as unknown as Record<string, Function>).tenantSet.call(on, tenant, 'proof');
    assert.throws(() => set(runtime, undefined), /proof was asked without a tenant under the row-security backstop/);
    assert.equal(set(runtime, null), '');
    assert.equal(set(runtime, "north's"), "; SET LOCAL mistri.tenant = 'north''s'");
    assert.throws(() => set(runtime, 'a\\b'), Refusal);
    assert.equal(set(owner, undefined), '', "the owner's adapter is not bound by the policy");
    assert.equal(set(plain, undefined), '', 'without the backstop nothing changes');
    await assert.rejects(
      runtime.readSnapshot(async () => assert.fail('never opened')),
      /readSnapshot was asked without a tenant under the row-security backstop/,
    );
    await assert.rejects(runtime.scopeReads({}), (error: unknown) => error instanceof Refusal && /read in a snapshot/.test(error.message));
    assert.throws(() => adapter({ rowSecurity: { role: '' } }), /A row-security role is a role name/);
  } finally {
    await Promise.all([runtime.close(), owner.close(), plain.close()]);
  }
});

const binding: TenantStoreBinding = { appId: 'app', source: { id: 'business', connection: 'main' }, storeId: 'store-1' };
const platformMember = {
  realm: 'platform',
  appId: 'app',
  accountId: 'operator',
  membershipId: 'operator',
  membershipVersion: '1',
  platformVersion: '1',
  roles: ['operator'],
  deployment: 'd1',
} as unknown as PlatformMembershipEvidence;

test("a write's policy reads its member's tenant, the named tenant of a platform-tenant command, and none for the platform's own", () => {
  const member = {
    appId: 'app',
    accountId: 'alice',
    tenantId: 'north',
    membershipId: 'm1',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['member'],
    deployment: 'd1',
  } as unknown as TenantMembershipEvidence;
  assert.equal(backstopTenantOf(memberWriteKind, binding, member), 'north');
  assert.equal(backstopTenantOf(platformWriteKind, binding, platformMember), undefined, "the owner's writer runs it");
  const named = { ...platformMember, realm: 'platform-tenant', tenantId: 'south', tenantVersion: '3' } as unknown as PlatformTenantEvidence;
  assert.equal(backstopTenantOf(platformTenantWriteKind, binding, named), 'south');
});

test("a tenant host's adapters run as the runtime role, and its owner's on the owner's own pool, once the backstop is declared", async () => {
  const replica = 'postgres://app_runtime@replica:5432/app';
  const opened: PostgresAdapter[] = [];
  const open = (url: string, role: 'runtime' | 'owner', isReplica = false) => {
    const made = tenantAdapter(url, 'backstop routing', isReplica, role);
    opened.push(made);
    return made as unknown as { rowSecurity?: { role: string; force: boolean; bypass: boolean }; database: string };
  };
  try {
    const before = open(RUNTIME, 'owner');
    assert.equal(before.rowSecurity, undefined, 'without a backstop an owner adapter is the runtime one');
    assert.equal(before.database, RUNTIME);
    assert.equal(tenantBackstop(RUNTIME), undefined);

    declareTenantBackstop(RUNTIME, { owner: OWNER, role: 'app_runtime', ownerRole: 'app_owner', replicas: [replica] });
    assert.deepEqual(tenantBackstop(RUNTIME), { owner: OWNER, role: 'app_runtime' });
    assert.deepEqual(tenantBackstop(replica), { owner: OWNER, role: 'app_runtime' });
    const runtime = open(RUNTIME, 'runtime');
    assert.deepEqual({ ...runtime.rowSecurity }, { role: 'app_runtime', force: false, bypass: false });
    assert.equal(runtime.database, RUNTIME);
    const reader = open(replica, 'runtime', true);
    assert.deepEqual({ ...reader.rowSecurity }, { role: 'app_runtime', force: false, bypass: false });
    const owner = open(RUNTIME, 'owner');
    assert.deepEqual({ ...owner.rowSecurity }, { role: 'app_runtime', force: false, bypass: true });
    assert.equal(owner.database, OWNER);
  } finally {
    await Promise.all(opened.map((each) => each.close()));
    forgetTenantPools();
  }
  assert.equal(tenantBackstop(RUNTIME), undefined, 'forgotten between hosts');
});
