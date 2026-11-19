/**
 * openTenant: createTenant then issueInvitation under one request key, each
 * authorized by its own policy as when called alone. A retry with the key and
 * the same intent finishes what the last attempt left; the key with another
 * intent is refused before anything is written. SQLite only: the steps are
 * the existing operations, whose dialect coverage lives in their own suites.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { openSqliteTenantAdministration, TenantAdministrationFailure } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { TenantOpenKeyConflict } from '../packages/mistri/src/server/tenant/tenantOpening.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import type { InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const HOUR = 3_600_000;
const administration = (operators: AdministrationPolicy['operators']): AdministrationPolicy => ({
  id: 'dealer-management',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  operators,
});
const invitations = (rules: Pick<InvitationPolicy, 'operators'> & Partial<InvitationPolicy>): InvitationPolicy => ({
  id: 'dealer-invitations',
  version: 'v1',
  maxMembershipLifetimeMs: 600_000,
  maxRedemptionLifetimeMs: 120_000,
  maxPendingPerTenant: 10,
  ...rules,
});
const refused = (error: unknown) => error instanceof TenantAdministrationFailure && error.outcome === 'not_applied';

type Users = Awaited<ReturnType<typeof tenantAdministrationFixture>>['users'];

async function fixture(t: TestContext, policies: (users: Users) => { policy: AdministrationPolicy; invitations: InvitationPolicy }) {
  const f = await tenantAdministrationFixture(t);
  provisionSqliteTenantInvitations(f.path, f.binding);
  const until = Date.now() + HOUR;
  const exec = (sql: string, ...params: unknown[]) => void f.db.prepare(sql).run(...(params as never[]));
  const all = (sql: string, ...params: unknown[]) =>
    f.db
      .prepare(sql)
      .all(...(params as never[]))
      .map((row) => ({ ...(row as Record<string, unknown>) }));
  exec(`INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('north', 'active', '1', 'tenant')`);
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
  const owner = await openSqliteTenantAdministration({
    binding: f.binding,
    auth: f.auth,
    deployment: 'open-tenant-tests',
    path: f.path,
    ...policies(f.users),
  });
  f.addCleanup(owner.retire);
  // The opening's own claim is a receipt beside its steps' (on '@platform'), written in createTenant's transaction.
  const receipts = () =>
    all(`SELECT tenant_id AS tenant, operation FROM "${journal.receipt}" WHERE operation <> 'openTenant' ORDER BY completed_at, rowid`);
  const claims = () => all(`SELECT tenant_id AS tenant FROM "${journal.receipt}" WHERE operation = 'openTenant'`).map((row) => row.tenant);
  const tenants = () => all(`SELECT id FROM "${tables.tenant}" WHERE kind = 'tenant' ORDER BY id`).map((row) => row.id);
  return { ...f, exec, member, owner, receipts, claims, tenants };
}

const opening = (accountId: string, key = 'opening-east-0001') => ({
  key,
  profile: 'dealer-profile-17',
  tenant: { tenantId: 'east' },
  invitation: { accountId, roles: ['dealer_staff'], redeemUntil: Date.now() + 60_000, validUntil: Date.now() + 120_000 },
});

test('a retry with the same key finishes an opening that stopped between createTenant and issueInvitation', async (t) => {
  // The operator creates tenants; invitations come from a tenant's own dealer admin, which east has none of at first.
  const f = await fixture(t, (users) => ({
    policy: administration([
      { accountId: users.operator.accountId, tenants: ['east'], operations: ['createTenant'], roles: ['dealer_staff'] },
    ]),
    invitations: invitations({
      operators: [],
      delegates: [{ role: 'dealer_admin', operations: ['issueInvitation'], roles: ['dealer_staff'] }],
    }),
  }));
  const { operator, outsider } = f.users;
  f.member('north-operator', 'north', operator.accountId, ['dealer_admin']);
  const session = (await f.owner.open(operator.request, { expectedAccount: operator.accountId }))!;
  assert.ok(session);
  const asked = { expectedAccount: operator.accountId, context: session.context, ...opening(outsider.accountId) };

  await assert.rejects(f.owner.openTenant(operator.request, asked), refused);
  assert.deepEqual(f.tenants(), ['east', 'north'], 'the first step stands');
  assert.deepEqual(f.receipts(), [{ tenant: 'east', operation: 'createTenant' }]);
  assert.deepEqual(f.claims(), ['@platform'], 'the key is claimed with the tenant');

  // What stopped the invitation is mended outside the request; the same key and intent finish it.
  f.member('east-operator', 'east', operator.accountId, ['dealer_admin']);
  const done = await f.owner.openTenant(operator.request, asked);
  assert.equal(done.tenantId, 'east');
  assert.equal(typeof done.invitation.token, 'string');
  assert.deepEqual(f.tenants(), ['east', 'north'], 'no second tenant');
  assert.deepEqual(f.receipts(), [
    { tenant: 'east', operation: 'createTenant' },
    { tenant: 'east', operation: 'issueInvitation' },
  ]);

  // A finished opening answers again with what it did, without the token, and writes nothing.
  const again = await f.owner.openTenant(operator.request, asked);
  assert.equal(again.version, done.version);
  assert.equal(again.invitation.result.receiptId, done.invitation.result.receiptId);
  assert.equal(again.invitation.token, undefined);
  assert.equal(f.receipts().length, 2);
  assert.equal(f.claims().length, 1);
});

async function stoppedOpening(t: TestContext) {
  const f = await fixture(t, (users) => ({
    policy: administration([
      { accountId: users.operator.accountId, tenants: ['east'], operations: ['createTenant'], roles: ['dealer_staff'] },
    ]),
    invitations: invitations({
      operators: [],
      delegates: [{ role: 'dealer_admin', operations: ['issueInvitation'], roles: ['dealer_staff'] }],
    }),
  }));
  const { operator, outsider } = f.users;
  f.member('north-operator', 'north', operator.accountId, ['dealer_admin']);
  const session = (await f.owner.open(operator.request, { expectedAccount: operator.accountId }))!;
  const asked = { expectedAccount: operator.accountId, context: session.context, ...opening(outsider.accountId) };
  await assert.rejects(f.owner.openTenant(operator.request, asked), refused);
  return { f, operator, asked };
}

test('a retry with the same key and fresh instants resumes the opening instead of conflicting', async (t) => {
  const { f, operator, asked } = await stoppedOpening(t);
  f.member('east-operator', 'east', operator.accountId, ['dealer_admin']);
  // A reload asks again with its own clock: the instants are not part of what the key names.
  const later = { ...asked, invitation: { ...asked.invitation, redeemUntil: Date.now() + 90_000, validUntil: Date.now() + 100_000 } };
  const done = await f.owner.openTenant(operator.request, later);
  assert.equal(done.tenantId, 'east');
  assert.equal(typeof done.invitation.token, 'string');
  assert.equal(f.claims().length, 1);
});

test('a retry resumes an opening whose tenant changed between the attempts', async (t) => {
  const { f, operator, asked } = await stoppedOpening(t);
  f.member('east-operator', 'east', operator.accountId, ['dealer_admin']);
  // The tenant's row moved on (a suspension lifted, a profile saved): the replayed createTenant still names version 1.
  f.exec(`UPDATE "${tables.tenant}" SET version = '2' WHERE id = 'east'`);
  const done = await f.owner.openTenant(operator.request, asked);
  assert.equal(done.tenantId, 'east');
  assert.equal(done.version, '2', 'the invitation is pinned to the tenant as it is now');
  assert.equal(typeof done.invitation.token, 'string');
});

test('the same key with another intent is refused and writes nothing', async (t) => {
  const f = await fixture(t, (users) => ({
    policy: administration([
      { accountId: users.operator.accountId, tenants: ['east', 'west'], operations: ['createTenant'], roles: ['dealer_staff'] },
    ]),
    invitations: invitations({
      operators: [
        { accountId: users.operator.accountId, tenants: ['east', 'west'], operations: ['issueInvitation'], roles: ['dealer_staff'] },
      ],
    }),
  }));
  const { operator, outsider, target } = f.users;
  const session = (await f.owner.open(operator.request, { expectedAccount: operator.accountId }))!;
  const asked = { expectedAccount: operator.accountId, context: session.context, ...opening(outsider.accountId) };
  await f.owner.openTenant(operator.request, asked);
  const conflict = (error: unknown) => error instanceof TenantOpenKeyConflict && error.key === asked.key;
  await assert.rejects(f.owner.openTenant(operator.request, { ...asked, profile: 'dealer-profile-18' }), conflict);
  await assert.rejects(f.owner.openTenant(operator.request, { ...asked, tenant: { tenantId: 'west' } }), conflict);
  await assert.rejects(
    f.owner.openTenant(operator.request, { ...asked, invitation: { ...asked.invitation, accountId: target.accountId } }),
    conflict,
  );
  assert.deepEqual(f.tenants(), ['east', 'north']);
  assert.equal(f.receipts().length, 2);
  // The refusals spent nothing: the original intent still answers under its key.
  const same = await f.owner.openTenant(operator.request, asked);
  assert.equal(same.tenantId, 'east');
});

test('platform-role rules alone admit the opening, only while the role is held, read at the change', async (t) => {
  // Neither policy names the opener's account: its platform role is the whole grant, on both steps.
  const f = await fixture(t, () => ({
    policy: administration([{ platformRole: 'platform_admin', tenants: ['east'], operations: ['createTenant'], roles: ['dealer_staff'] }]),
    invitations: invitations({
      operators: [{ platformRole: 'platform_admin', tenants: ['east'], operations: ['issueInvitation'], roles: ['dealer_staff'] }],
    }),
  }));
  const { target, outsider } = f.users;
  f.exec(`INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('@platform', 'active', '1', 'platform')`);
  f.member('platform-member', '@platform', target.accountId, ['platform_admin']);
  assert.equal(await f.owner.open(outsider.request, { expectedAccount: outsider.accountId }), null);
  const session = (await f.owner.open(target.request, { expectedAccount: target.accountId }))!;
  assert.ok(session);
  const asked = { expectedAccount: target.accountId, context: session.context, ...opening(outsider.accountId) };

  f.exec(`UPDATE "${tables.membership}" SET roles_json = '["reviewer"]', version = '2' WHERE id = 'platform-member'`);
  await assert.rejects(f.owner.openTenant(target.request, asked), refused);
  assert.deepEqual(f.tenants(), ['north']);
  assert.deepEqual(f.receipts(), []);
  assert.deepEqual(f.claims(), []);

  // A refused opening claims nothing: the key still opens once the role is held again.
  f.exec(`UPDATE "${tables.membership}" SET roles_json = '["platform_admin"]', version = '3' WHERE id = 'platform-member'`);
  const done = await f.owner.openTenant(target.request, asked);
  assert.equal(done.tenantId, 'east');
  assert.deepEqual(f.receipts(), [
    { tenant: 'east', operation: 'createTenant' },
    { tenant: 'east', operation: 'issueInvitation' },
  ]);
});
