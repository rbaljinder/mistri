/**
 * Delegated administration and invitations: a tenant's own members
 * administering it (tenantDelegation.ts). A delegate's authority is its own
 * membership, read in the transaction that makes the change: its own tenant
 * only, within the rule's ceiling, never its own membership, and never from a
 * support row. SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a
 * server, on a database of each test's own, where a concurrent demotion is
 * shown to wait for — then refuse — the delegate's change.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { migratePostgresTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import {
  openSqliteTenantAdministration,
  openTenantAdministration,
  TenantAdministrationFailure,
  type TenantAdministration,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { captureAdministrationPolicy, type AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { captureInvitationPolicy, type InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { TenantInvitationFailure } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { delegationRoleCheck } from '../packages/mistri/src/server/tenant/tenantFeatureDelegation.js';
import { roleCeilingCheck, roleCeilingHook } from '../packages/mistri/src/server/tenant/tenantFeatureMembershipRoles.js';
import { TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartupError.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import type { AdministrationIntent } from '../packages/mistri/src/shared/tenantAdministration.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { pgClient, TENANT_DIALECTS, uuidPostgresDatabase, type Control, type TenantDialect } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const HOUR = 3_600_000;
const administration = (): AdministrationPolicy => ({
  id: 'dealer-management',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  operators: [],
  delegates: [
    {
      role: 'dealer_admin',
      operations: ['grantMembership', 'replaceMembership', 'revokeMembership'],
      roles: ['dealer_admin', 'dealer_staff'],
    },
  ],
});
const invitations = (): InvitationPolicy => ({
  id: 'dealer-invitations',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  maxRedemptionLifetimeMs: 120_000,
  maxPendingPerTenant: 10,
  operators: [],
  delegates: [{ role: 'dealer_admin', operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'], roles: ['dealer_staff'] }],
});
const refusedAdministration = (error: unknown) => error instanceof TenantAdministrationFailure && error.outcome === 'not_applied';
const refusedInvitation = (error: unknown) => error instanceof TenantInvitationFailure && error.outcome === 'not_applied';

async function fixture(t: TestContext, dialect: TenantDialect) {
  const f = await tenantAdministrationFixture(t);
  let exec: (sql: string, ...params: unknown[]) => Promise<void>,
    all: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  let where: { path: string } | { url: string }, session: (() => Promise<Control>) | undefined;
  if (dialect === 'sqlite') {
    provisionSqliteTenantInvitations(f.path, f.binding);
    where = { path: f.path };
    exec = async (sql, ...params) => {
      f.db.prepare(sql).run(...(params as never[]));
    };
    all = async (sql, ...params) =>
      f.db
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }));
  } else {
    const { url, drop } = await uuidPostgresDatabase('tenant_delegation');
    const control = await pgClient(url),
      extra: Control[] = [];
    t.after(async () => {
      for (const client of [...extra, control]) await client.end().catch(() => {});
      await drop();
    });
    await migratePostgresTenantStore(url, f.binding);
    await migratePostgresTenantAdministrationJournal(url, f.binding);
    await migratePostgresTenantInvitations(url, f.binding);
    where = { url };
    const numbered = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    exec = async (sql, ...params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    };
    all = async (sql, ...params) => (await control.query(postgresRuntimeSql(numbered(sql)), params)).rows;
    session = async () => {
      const client = await pgClient(url);
      extra.push(client);
      return client;
    };
  }
  const { operator, target, outsider } = f.users;
  const until = Date.now() + HOUR;
  await exec(
    `INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant')`,
  );
  const member = (id: string, tenant: string, account: string, roles: string[]) =>
    exec(
      `INSERT INTO "${tables.membership}"
    (id, tenant_id, account_id, status, version, roles_json, valid_until, kind) VALUES (?, ?, ?, 'active', '1', ?, ?, 'member')`,
      id,
      tenant,
      account,
      JSON.stringify(roles),
      until,
    );
  // The operator is north's dealer admin, the target its staff, the outsider south's dealer admin.
  await member('north-operator', 'north', operator.accountId, ['dealer_admin']);
  await member('north-target', 'north', target.accountId, ['dealer_staff']);
  await member('south-outsider', 'south', outsider.accountId, ['dealer_admin']);
  let owner: TenantAdministration | undefined;
  const open = async (options: { policy?: AdministrationPolicy; invitations?: InvitationPolicy } = { policy: administration() }) => {
    const common = { binding: f.binding, auth: f.auth, deployment: 'delegation-tests', ...options };
    owner =
      'path' in where
        ? await openSqliteTenantAdministration({ ...common, path: where.path })
        : await openTenantAdministration({ ...common, url: where.url });
    f.addCleanup(owner.retire);
    return owner;
  };
  // Receipts written in one millisecond tie on completed_at: SQLite's rowid is their insertion order.
  const receipts = () =>
    all(
      `SELECT actor_id AS actor, tenant_id AS tenant, operation FROM "${journal.receipt}" ORDER BY completed_at, ${dialect === 'sqlite' ? 'rowid' : 'operation, id'}`,
    );
  const memberships = () =>
    all(`SELECT id, tenant_id AS tenant, account_id AS account, status, version, roles_json AS roles, kind
    FROM "${tables.membership}" ORDER BY id`);
  return { ...f, exec, all, open, receipts, memberships, session, until };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`delegated administration on ${dialect}`, { skip }, () => {
    test('a delegate opens administration from its own membership, sees its own tenant only, and never its own row', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open();
      const { operator, target, outsider } = f.users;
      assert.equal(await owner.open(target.request, { expectedAccount: target.accountId }), null);
      const session = await owner.open(operator.request, { expectedAccount: operator.accountId });
      assert.ok(session);
      const context = { expectedAccount: operator.accountId, context: session.context };
      const page = await owner.tenants(operator.request, context);
      assert.deepEqual(
        page.items.map((item) => item.tenantId),
        ['north'],
      );
      assert.deepEqual(
        page.items[0].capabilities.map((capability) => capability.operation),
        ['grantMembership', 'replaceMembership', 'revokeMembership'],
      );
      assert.ok(page.items[0].capabilities.every((capability) => capability.roles.join() === 'dealer_admin,dealer_staff'));
      const listed = await owner.memberships(operator.request, { ...context, tenantId: 'north', operation: 'replaceMembership' });
      assert.deepEqual(
        listed.items.map((item) => item.accountId),
        [target.accountId],
      );
      await assert.rejects(
        owner.memberships(operator.request, { ...context, tenantId: 'south', operation: 'revokeMembership' }),
        refusedAdministration,
      );
      // The outsider is a delegate in south, and only there.
      const theirs = await owner.open(outsider.request, { expectedAccount: outsider.accountId });
      assert.deepEqual(
        (await owner.tenants(outsider.request, { expectedAccount: outsider.accountId, context: theirs!.context })).items.map(
          (item) => item.tenantId,
        ),
        ['south'],
      );
    });

    test('a delegate grants, replaces and revokes within its ceiling, in its own tenant, never its own membership', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open();
      const { operator, target, outsider } = f.users;
      const session = (await owner.open(operator.request, { expectedAccount: operator.accountId }))!;
      const run = (intent: AdministrationIntent) =>
        owner.execute(operator.request, {
          expectedAccount: operator.accountId,
          context: session.context,
          idempotencyKey: crypto.randomUUID(),
          intent,
        });
      const soon = Date.now() + 60_000;
      const granted = await run({
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: outsider.accountId,
        roles: ['dealer_staff'],
        validUntil: soon,
      });
      assert.equal(granted.change.after.membership!.status, 'active');
      const refused = async (intent: AdministrationIntent) => {
        const before = JSON.stringify([await f.memberships(), await f.receipts()]);
        await assert.rejects(run(intent), refusedAdministration);
        assert.equal(JSON.stringify([await f.memberships(), await f.receipts()]), before);
      };
      // Outside its tenant, outside its ceiling, or the tenant row itself.
      await refused({
        operation: 'grantMembership',
        tenantId: 'south',
        expectedTenantVersion: '1',
        accountId: target.accountId,
        roles: ['dealer_staff'],
        validUntil: soon,
      });
      await refused({
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: 'someone',
        roles: ['owner'],
        validUntil: soon,
      });
      await refused({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' });
      await refused({ operation: 'createTenant', tenantId: 'east' });
      // Its own membership: never replaced, revoked or granted again.
      await refused({
        operation: 'replaceMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: 'north-operator',
        expectedMembershipVersion: '1',
        roles: ['dealer_staff'],
        validUntil: soon,
      });
      await refused({
        operation: 'revokeMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: 'north-operator',
        expectedMembershipVersion: '1',
      });
      await refused({
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: operator.accountId,
        roles: ['dealer_staff'],
        validUntil: soon,
      });
      // Others, within the ceiling: another dealer admin may be made, and revoked.
      await run({
        operation: 'replaceMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: 'north-target',
        expectedMembershipVersion: '1',
        roles: ['dealer_admin'],
        validUntil: soon,
      });
      await run({
        operation: 'revokeMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        membershipId: 'north-target',
        expectedMembershipVersion: '2',
      });
      assert.deepEqual(
        (await f.receipts()).map((row) => [row.actor, row.tenant, row.operation]),
        [
          [operator.accountId, 'north', 'grantMembership'],
          [operator.accountId, 'north', 'replaceMembership'],
          [operator.accountId, 'north', 'revokeMembership'],
        ],
      );
    });

    test('a delegate is fenced on its own membership: demoted, revoked or suspended, it acts no more', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open();
      const { operator, outsider } = f.users;
      const session = (await owner.open(operator.request, { expectedAccount: operator.accountId }))!;
      const grant = () =>
        owner.execute(operator.request, {
          expectedAccount: operator.accountId,
          context: session.context,
          idempotencyKey: crypto.randomUUID(),
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: outsider.accountId,
            roles: ['dealer_staff'],
            validUntil: Date.now() + 60_000,
          },
        });
      await f.exec(`UPDATE "${tables.membership}" SET roles_json = '["dealer_staff"]', version = '2' WHERE id = 'north-operator'`);
      await assert.rejects(grant(), refusedAdministration);
      await f.exec(
        `UPDATE "${tables.membership}" SET roles_json = '["dealer_admin"]', valid_until = ?, version = '3' WHERE id = 'north-operator'`,
        Date.now() - 1,
      );
      await assert.rejects(grant(), refusedAdministration);
      await f.exec(`UPDATE "${tables.membership}" SET valid_until = ?, version = '4' WHERE id = 'north-operator'`, f.until);
      await f.exec(`UPDATE "${tables.tenant}" SET status = 'suspended', version = '2' WHERE id = 'north'`);
      await assert.rejects(grant(), refusedAdministration);
      await f.exec(`UPDATE "${tables.tenant}" SET status = 'active', version = '3' WHERE id = 'north'`);
      await f.exec(`UPDATE "${tables.membership}" SET status = 'revoked', version = '5' WHERE id = 'north-operator'`);
      await assert.rejects(grant(), refusedAdministration);
      assert.deepEqual(await f.receipts(), []);
    });

    test('a support membership never makes a delegate', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open();
      const { target } = f.users;
      await f.exec(`INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('@platform', 'active', '1', 'platform')`);
      await f.exec(
        `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
        VALUES ('platform-target', '@platform', ?, 'active', '1', '["manager"]', ?, 'member')`,
        target.accountId,
        f.until,
      );
      await f.exec(
        `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind,
        parent_id, parent_version, platform_version) VALUES ('support-target', 'south', ?, 'active', '1', '["dealer_admin"]', ?, 'support',
        'platform-target', '1', '1')`,
        target.accountId,
        f.until,
      );
      assert.equal(await owner.open(target.request, { expectedAccount: target.accountId }), null);
    });

    if (dialect === 'postgres')
      test("a concurrent demotion waits for the delegate's change or refuses it", async (t) => {
        const f = await fixture(t, dialect),
          owner = await f.open();
        const { operator, outsider } = f.users;
        const session = (await owner.open(operator.request, { expectedAccount: operator.accountId }))!;
        const demoter = await f.session!();
        await demoter.query('BEGIN');
        await demoter.query(
          `UPDATE ${runtimeTable('postgres', tables.membership)} SET roles_json = '["dealer_staff"]', version = '2' WHERE id = 'north-operator'`,
        );
        let settled = false;
        const attempt = owner.execute(operator.request, {
          expectedAccount: operator.accountId,
          context: session.context,
          idempotencyKey: crypto.randomUUID(),
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: outsider.accountId,
            roles: ['dealer_staff'],
            validUntil: Date.now() + 60_000,
          },
        });
        void attempt.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await delay(400);
        assert.equal(settled, false, "the delegate's transaction waits on its own locked membership");
        await demoter.query('COMMIT');
        await assert.rejects(attempt, refusedAdministration);
        assert.deepEqual(await f.receipts(), []);
      });

    test('a delegate issues invitations in its own tenant, and acceptance rechecks its authority', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open({ invitations: invitations() });
      const { operator, target, outsider } = f.users;
      const api = owner.invitations!;
      assert.equal(await api.openIssuer(target.request, { expectedAccount: target.accountId }), null);
      const issuer = await api.openIssuer(operator.request, { expectedAccount: operator.accountId });
      assert.ok(issuer);
      const context = { expectedAccount: operator.accountId, context: issuer.context };
      assert.deepEqual(
        (await api.targets(operator.request, context)).items.map((item) => [item.tenantId, item.capabilities.length]),
        [['north', 3]],
      );
      const issue = (account: string, tenantId = 'north', roles = ['dealer_staff']) =>
        api.execute(operator.request, {
          ...context,
          idempotencyKey: crypto.randomUUID(),
          intent: {
            operation: 'issueInvitation',
            tenantId,
            expectedTenantVersion: '1',
            accountId: account,
            roles,
            redeemUntil: Date.now() + 60_000,
            validUntil: Date.now() + 120_000,
          },
        });
      await assert.rejects(issue(outsider.accountId, 'south'), refusedInvitation);
      await assert.rejects(issue(outsider.accountId, 'north', ['dealer_admin']), refusedInvitation);
      await assert.rejects(issue(operator.accountId), refusedInvitation);
      const accept = async (token: string) => {
        const recipient = await api.openRecipient(outsider.request, {
          expectedAccount: outsider.accountId,
          invitationId: invitationTokenId(token),
        });
        const owned = { expectedAccount: outsider.accountId, context: recipient.context };
        const preview = await api.preview(outsider.request, { ...owned, token });
        return api.execute(outsider.request, { ...owned, idempotencyKey: crypto.randomUUID(), intent: preview.intent, token });
      };
      const { token } = await issue(outsider.accountId);
      // Demoted before acceptance, the delegate's invitation no longer holds.
      await f.exec(`UPDATE "${tables.membership}" SET roles_json = '["dealer_staff"]', version = '2' WHERE id = 'north-operator'`);
      await assert.rejects(accept(token!), refusedInvitation);
      await f.exec(`UPDATE "${tables.membership}" SET roles_json = '["dealer_admin"]', version = '3' WHERE id = 'north-operator'`);
      const accepted = await accept(token!);
      assert.equal((accepted.result as { status?: string }).status, 'accepted');
      assert.deepEqual(
        (await f.receipts()).map((row) => [row.actor, row.operation]),
        [
          [operator.accountId, 'issueInvitation'],
          [outsider.accountId, 'acceptInvitation'],
        ],
      );
    });
  });
}

test('delegate rules: one ceiling per operation, never the tenant row, and tenant-realm roles only', () => {
  const denied = (value: unknown) => assert.throws(() => captureAdministrationPolicy(value));
  const base = administration();
  denied({
    ...base,
    delegates: [...base.delegates!, { role: 'dealer_manager', operations: ['revokeMembership'], roles: ['dealer_staff'] }],
  });
  denied({ ...base, delegates: [{ role: 'dealer_admin', operations: ['createTenant'], roles: ['dealer_staff'] }] });
  denied({ ...base, delegates: [{ role: 'dealer_admin', operations: ['setTenantStatus'], roles: ['dealer_staff'] }] });
  denied({ ...base, delegates: [] });
  denied({ ...base, delegates: undefined });
  assert.throws(() =>
    captureInvitationPolicy({ ...invitations(), delegates: [{ role: 'dealer_admin', operations: ['acceptInvitation'], roles: ['x'] }] }),
  );
  assert.throws(() => captureInvitationPolicy({ ...invitations(), delegates: undefined }));
  const app = { auth: { roles: { dealer_admin: { realm: 'tenant' }, dealer_staff: { realm: 'tenant' }, manager: { realm: 'platform' } } } };
  delegationRoleCheck.run({ app, policy: { administration: base, invitations: invitations() } } as never);
  for (const delegates of [
    [{ role: 'manager', operations: ['grantMembership'], roles: ['dealer_staff'] }],
    [{ role: 'dealer_admin', operations: ['grantMembership'], roles: ['manager'] }],
    [{ role: 'dealer_admin', operations: ['grantMembership'], roles: ['nobody'] }],
  ]) {
    assert.throws(() => delegationRoleCheck.run({ app, policy: { administration: { ...base, delegates } } } as never), TenantStartupError);
  }
});

/* An operator rule naming a platform role: whoever holds it through an active platform membership administers,
   resolved as a support grant is, read in the transaction that makes the change, and only when such a rule exists. */
const byRole = (extra: AdministrationPolicy['operators'] = []): AdministrationPolicy => ({
  id: 'dealer-management',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  operators: [
    { platformRole: 'platform_admin', tenants: ['north'], operations: ['grantMembership', 'setTenantStatus'], roles: ['dealer_staff'] },
    ...extra,
  ],
});

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`platform-role operator rules on ${dialect}`, { skip }, () => {
    const platform = async (f: Awaited<ReturnType<typeof fixture>>, account: string, roles: string[]) => {
      await f.exec(`INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('@platform', 'active', '1', 'platform')`);
      await f.exec(
        `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
        VALUES ('platform-member', '@platform', ?, 'active', '1', ?, ?, 'member')`,
        account,
        JSON.stringify(roles),
        f.until,
      );
    };

    test('an active platform membership holding the role admits, within the rule, and nobody else', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open({ policy: byRole() });
      const { target, outsider } = f.users;
      await platform(f, target.accountId, ['platform_admin']);
      assert.equal(await owner.open(outsider.request, { expectedAccount: outsider.accountId }), null);
      const session = (await owner.open(target.request, { expectedAccount: target.accountId }))!;
      assert.ok(session);
      const context = { expectedAccount: target.accountId, context: session.context };
      const page = await owner.tenants(target.request, context);
      assert.deepEqual(
        page.items.map((item) => [item.tenantId, item.capabilities.map((capability) => `${capability.operation}:${capability.roles}`)]),
        [['north', ['setTenantStatus:dealer_staff', 'grantMembership:dealer_staff']]],
      );
      const run = (intent: AdministrationIntent) =>
        owner.execute(target.request, { ...context, idempotencyKey: crypto.randomUUID(), intent });
      const soon = Date.now() + 60_000;
      const grant = { operation: 'grantMembership', tenantId: 'north', expectedTenantVersion: '1', accountId: outsider.accountId } as const;
      await assert.rejects(run({ ...grant, roles: ['dealer_admin'], validUntil: soon }), refusedAdministration);
      await assert.rejects(run({ ...grant, tenantId: 'south', roles: ['dealer_staff'], validUntil: soon }), refusedAdministration);
      const done = await run({ ...grant, roles: ['dealer_staff'], validUntil: soon });
      assert.equal(done.change.after.membership!.status, 'active');
      assert.deepEqual(await f.receipts(), [{ actor: target.accountId, tenant: 'north', operation: 'grantMembership' }]);
    });

    test('an expired or revoked platform membership, or a suspended platform, admits nothing, read at the change', async (t) => {
      const f = await fixture(t, dialect),
        owner = await f.open({ policy: byRole() });
      const { target, outsider } = f.users;
      await platform(f, target.accountId, ['platform_admin']);
      const session = (await owner.open(target.request, { expectedAccount: target.accountId }))!;
      const run = () =>
        owner.execute(target.request, {
          expectedAccount: target.accountId,
          context: session.context,
          idempotencyKey: crypto.randomUUID(),
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: outsider.accountId,
            roles: ['dealer_staff'],
            validUntil: Date.now() + 60_000,
          },
        });
      await f.exec(`UPDATE "${tables.membership}" SET status = 'revoked', version = '2' WHERE id = 'platform-member'`);
      await assert.rejects(run(), refusedAdministration);
      await f.exec(`UPDATE "${tables.membership}" SET status = 'active', valid_until = ?, version = '3' WHERE id = 'platform-member'`, 1);
      await assert.rejects(run(), refusedAdministration);
      assert.equal(await owner.open(target.request, { expectedAccount: target.accountId }), null);
      await f.exec(`UPDATE "${tables.membership}" SET valid_until = ?, version = '4' WHERE id = 'platform-member'`, f.until);
      await f.exec(`UPDATE "${tables.tenant}" SET status = 'suspended', version = '2' WHERE id = '@platform'`);
      await assert.rejects(run(), refusedAdministration);
      // A platform role the rule does not name admits nothing either.
      await f.exec(`UPDATE "${tables.tenant}" SET status = 'active', version = '3' WHERE id = '@platform'`);
      await f.exec(`UPDATE "${tables.membership}" SET roles_json = '["reviewer"]', version = '5' WHERE id = 'platform-member'`);
      await assert.rejects(run(), refusedAdministration);
      assert.deepEqual(await f.receipts(), []);
      await f.exec(`UPDATE "${tables.membership}" SET roles_json = '["platform_admin"]', version = '6' WHERE id = 'platform-member'`);
      await run();
    });

    test('a role rule and an account rule matching one account give their roles together', async (t) => {
      const f = await fixture(t, dialect);
      const { operator } = f.users;
      const owner = await f.open({
        policy: byRole([{ accountId: operator.accountId, tenants: ['north'], operations: ['grantMembership'], roles: ['dealer_admin'] }]),
      });
      await platform(f, operator.accountId, ['platform_admin']);
      const session = (await owner.open(operator.request, { expectedAccount: operator.accountId }))!;
      const page = await owner.tenants(operator.request, { expectedAccount: operator.accountId, context: session.context });
      const grant = page.items[0].capabilities.find((capability) => capability.operation === 'grantMembership')!;
      assert.deepEqual([...grant.roles].sort(), ['dealer_admin', 'dealer_staff']);
    });

    if (dialect === 'sqlite')
      test('a policy without a role rule reads no platform membership: the store is not touched to refuse', async (t) => {
        const f = await fixture(t, dialect);
        const { operator, outsider } = f.users;
        const accounts = await f.open({
          policy: {
            ...byRole(),
            operators: [{ accountId: operator.accountId, tenants: ['north'], operations: ['grantMembership'], roles: ['dealer_staff'] }],
          },
        });
        // A second policy on one deployment needs its own version.
        const roles = await f.open({ policy: { ...byRole(), version: 'v2' } });
        // The membership table gone: any read of it fails.
        f.db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE "${tables.membership}"`);
        assert.equal(await accounts.open(outsider.request, { expectedAccount: outsider.accountId }), null);
        assert.ok(await accounts.open(operator.request, { expectedAccount: operator.accountId }));
        await assert.rejects(roles.open(outsider.request, { expectedAccount: outsider.accountId }), refusedAdministration);
      });
  });
}

test('a role rule names a platform-realm role of an App with a platform, and places tenant roles only', () => {
  const roles = { dealer_staff: { realm: 'tenant' }, platform_admin: { realm: 'platform' }, robot: { realm: 'platform', service: true } };
  const app = { auth: { roles, tenancy: { platform: {} } } };
  // An invitation operator rule is held to the same ceiling as an administration one.
  for (const policy of [
    (operator: Record<string, unknown>) =>
      ({ administration: { ...byRole(), operators: [{ tenants: ['north'], operations: ['grantMembership'], ...operator }] } }) as never,
    (operator: Record<string, unknown>) =>
      ({ invitations: { operators: [{ tenants: ['north'], operations: ['issueInvitation'], ...operator }] } }) as never,
  ]) {
    roleCeilingCheck.run({ app, policy: policy({ platformRole: 'platform_admin', roles: ['dealer_staff'] }) } as never);
    for (const [subject, operator] of [
      [app, { platformRole: 'platform_admin', roles: ['platform_admin'] }],
      [app, { platformRole: 'dealer_staff', roles: ['dealer_staff'] }],
      [app, { platformRole: 'robot', roles: ['dealer_staff'] }],
      [app, { platformRole: 'nobody', roles: ['dealer_staff'] }],
      [{ auth: { roles } }, { platformRole: 'platform_admin', roles: ['dealer_staff'] }],
    ] as const) {
      assert.throws(() => roleCeilingCheck.run({ app: subject, policy: policy(operator) } as never), TenantStartupError);
      assert.throws(() => roleCeilingHook.declare!({ app: subject, policy: policy(operator) } as never));
    }
  }
});
