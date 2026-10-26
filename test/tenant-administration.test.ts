import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  openSqliteTenantAdministration,
  TenantAdministrationFailure,
  type AdministrationRequest,
  type TenantAdministration,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import {
  ADMINISTRATION_OPERATIONS,
  type AdministrationIntent,
  type AdministrationPolicy,
} from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const safe =
  (outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof TenantAdministrationFailure);
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, 'The administration operation could not be confirmed.');
    assert.equal('cause' in error, false);
    return true;
  };
async function fixture(t: TestContext) {
  const f = await tenantAdministrationFixture(t);
  const policy: AdministrationPolicy = {
    id: 'operators',
    version: 'v1',
    maxMembershipLifetimeMs: 86_400_000,
    operators: [
      {
        accountId: f.users.operator.accountId,
        tenants: ['north', 'south'],
        operations: ADMINISTRATION_OPERATIONS,
        roles: ['reader', 'manager'],
      },
    ],
  };
  const options = { path: f.path, binding: f.binding, auth: f.auth, policy, deployment: 'test' };
  const service = await openSqliteTenantAdministration(options);
  f.addCleanup(service.retire);
  let context = '';
  const admit = async (owner = service) => {
    const session = await owner.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
    assert.ok(session);
    context = session.context;
    return context;
  };
  await admit();
  let attempt = 0;
  const input = (intent: AdministrationIntent, idempotencyKey = `attempt-${++attempt}`): AdministrationRequest => ({
    expectedAccount: f.users.operator.accountId,
    context,
    idempotencyKey,
    intent,
  });
  const execute = (intent: AdministrationIntent, key?: string) => service.execute(f.users.operator.request, input(intent, key));
  const count = (table: string) => f.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n;
  return { ...f, service, policy, options, input, execute, count, admit };
}

test('five operator operations commit exact metadata, receipt and audit without creating operator access', async (t) => {
  const f = await fixture(t);
  const created = await f.execute({ operation: 'createTenant', tenantId: 'north' });
  assert.deepEqual(JSON.parse(JSON.stringify(created.change)), {
    operation: 'createTenant',
    before: null,
    after: { tenant: { tenantId: 'north', status: 'active', version: '1' } },
  });
  const grant = await f.execute({
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: f.users.target.accountId,
    roles: ['reader'],
    validUntil: Date.now() + 60_000,
  });
  const member = grant.change.after.membership!;
  assert.equal(member.version, '1');
  assert.equal(member.accountId, f.users.target.accountId);
  const replacement = await f.execute({
    operation: 'replaceMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: member.membershipId,
    expectedMembershipVersion: '1',
    roles: ['reader', 'manager'],
    validUntil: Date.now() + 70_000,
  });
  assert.equal(replacement.change.after.membership!.version, '2');
  const suspended = await f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' });
  assert.equal(suspended.change.after.tenant.version, '2');
  const revoke = await f.execute({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '2',
    membershipId: member.membershipId,
    expectedMembershipVersion: '2',
  });
  assert.equal(revoke.change.after.membership!.version, '3');
  assert.equal(revoke.change.after.membership!.status, 'revoked');
  assert.equal(f.count(journal.receipt), 5);
  assert.equal(f.count(TENANT_TABLES.membership), 1);
  assert.equal(
    f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}" WHERE account_id=?`).get(f.users.operator.accountId)!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT value FROM business_record').get()!.value, 'original');
  const audit = f.db.prepare(`SELECT * FROM "${journal.receipt}" WHERE id=?`).get(revoke.receiptId)!;
  assert.equal(audit.policy_id, 'operators');
  assert.equal(audit.deployment, 'test');
  assert.ok(typeof audit.session_id === 'string');
  assert.deepEqual(JSON.parse(String(audit.change_json)), JSON.parse(JSON.stringify(revoke.change)));
  assert.ok(Object.isFrozen(revoke.change.after.membership!.roles));
});

test('exact concurrent delivery and restart recover one result, while conflicting reuse has no effects', async (t) => {
  const f = await fixture(t);
  const input = f.input({ operation: 'createTenant', tenantId: 'north' }, 'same-attempt');
  const results = await Promise.all(Array.from({ length: 4 }, () => f.service.execute(f.users.operator.request, input)));
  assert.equal(new Set(results.map((result) => result.receiptId)).size, 1);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(f.count(journal.receipt), 1);
  const status = await f.service.status(f.users.operator.request, input);
  assert.equal(status!.receiptId, results[0].receiptId);
  assert.equal(status!.replayed, true);
  assert.equal(await f.service.status(f.users.operator.request, { ...input, idempotencyKey: 'unused' }), null);
  await f.service.retire();
  const restarted = await openSqliteTenantAdministration({
    ...f.options,
    deployment: 'new-deployment',
    binding: { ...f.binding, source: { ...f.binding.source, connection: 'renamed' } },
  });
  f.addCleanup(restarted.retire);
  const context = await f.admit(restarted);
  await assert.rejects(restarted.status(f.users.operator.request, input), safe());
  assert.equal((await restarted.status(f.users.operator.request, { ...input, context }))!.receiptId, results[0].receiptId);
  const change = f.input(
    { operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' },
    'status-attempt',
  );
  await restarted.execute(f.users.operator.request, change);
  await assert.rejects(
    restarted.execute(f.users.operator.request, { ...change, intent: { ...change.intent, status: 'closed' } as AdministrationIntent }),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 2);
  assert.equal(f.db.prepare(`SELECT status FROM "${TENANT_TABLES.tenant}"`).get()!.status, 'suspended');
});

test('tenant and member revisions both fence edits; closed and revoked states remain terminal', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  const granting: AdministrationIntent = {
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: f.users.target.accountId,
    roles: ['reader'],
    validUntil: Date.now() + 80_000,
  };
  const granted = await f.execute(granting);
  const member = granted.change.after.membership!;
  await assert.rejects(f.execute(granting), safe()); // one non-revoked membership per tenant/account
  await f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' });
  await f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '2', status: 'active' });
  const revoke: AdministrationIntent = {
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: member.membershipId,
    expectedMembershipVersion: '1',
  };
  await assert.rejects(f.execute(revoke), safe());
  await assert.rejects(f.execute({ ...revoke, expectedTenantVersion: '3', expectedMembershipVersion: '2' }), safe());
  await f.execute({ ...revoke, expectedTenantVersion: '3' });
  await assert.rejects(
    f.execute({
      operation: 'replaceMembership',
      tenantId: 'north',
      expectedTenantVersion: '3',
      membershipId: member.membershipId,
      expectedMembershipVersion: '2',
      roles: ['manager'],
      validUntil: Date.now() + 80_000,
    }),
    safe(),
  );
  await f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '3', status: 'closed' });
  await assert.rejects(
    f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '4', status: 'active' }),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 6);
  const recovered = await f.service.status(f.users.operator.request, f.input(granting, 'attempt-2'));
  assert.equal(recovered!.change.after.membership!.status, 'active', 'historical result, not a false claim about current access');
});

test('native/global/business roles do not grant operator authority or disclose receipts', async (t) => {
  const f = await fixture(t);
  const input = f.input({ operation: 'createTenant', tenantId: 'north' });
  await f.service.execute(f.users.operator.request, input);
  f.authDb.prepare('UPDATE user SET role=? WHERE id=?').run('admin', f.users.outsider.accountId);
  f.db
    .prepare(
      `INSERT INTO "${TENANT_TABLES.membership}" VALUES ('outsider-member','north',?,'active','1','["manager"]',?, 'member', NULL, NULL, NULL)`,
    )
    .run(f.users.outsider.accountId, Date.now() + 90_000);
  const outsider = { ...input, expectedAccount: f.users.outsider.accountId };
  await assert.rejects(f.service.execute(f.users.outsider.request, outsider), safe());
  await assert.rejects(f.service.status(f.users.outsider.request, outsider), safe());
  await assert.rejects(
    f.service.execute(f.users.operator.request, { ...input, intent: { operation: 'createTenant', tenantId: 'outside-ceiling' } }),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 1);
});

test('target native identity, role and expiry ceilings refuse without receipts', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  const grant: AdministrationIntent = {
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: f.users.target.accountId,
    roles: ['reader'],
    validUntil: Date.now() + 60_000,
  };
  for (const change of [
    { accountId: 'target@example.test' },
    { accountId: 'absent' },
    { roles: ['owner'] },
    { validUntil: Date.now() - 1 },
    { validUntil: Date.now() + 2 * 86_400_000 },
  ]) {
    await assert.rejects(f.execute({ ...grant, ...change }), safe());
  }
  f.authDb.prepare('DELETE FROM user WHERE id=?').run(f.users.target.accountId);
  await assert.rejects(f.execute(grant), safe());
  assert.equal(f.count(journal.receipt), 1);
  assert.equal(f.count(TENANT_TABLES.membership), 0);
});

test('lower role ceiling cannot replace or revoke higher access; invitations cannot be activated by replacement', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  f.db
    .prepare(`INSERT INTO "${TENANT_TABLES.membership}" VALUES ('high','north',?,'active','1','["owner"]',?, 'member', NULL, NULL, NULL)`)
    .run(f.users.target.accountId, Date.now() + 90_000);
  const replace: AdministrationIntent = {
    operation: 'replaceMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: 'high',
    expectedMembershipVersion: '1',
    roles: ['reader'],
    validUntil: Date.now() + 80_000,
  };
  await assert.rejects(f.execute(replace), safe());
  await assert.rejects(
    f.execute({
      operation: 'revokeMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      membershipId: 'high',
      expectedMembershipVersion: '1',
    }),
    safe(),
  );
  f.db.prepare(`UPDATE "${TENANT_TABLES.membership}" SET status='invited', roles_json='["reader"]' WHERE id='high'`).run();
  await assert.rejects(f.execute(replace), safe());
  assert.equal(f.count(journal.receipt), 1);
});

test('oversized receipt rolls back metadata and leaves the writer reusable', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  const roles = Array.from({ length: 100 }, (_, i) => `${i}-${'x'.repeat(240)}`);
  await f.service.retire();
  const service = await openSqliteTenantAdministration({
    ...f.options,
    policy: { ...f.policy, operators: [{ ...f.policy.operators[0], roles }] },
  });
  f.addCleanup(service.retire);
  await f.admit(service);
  await assert.rejects(
    service.execute(
      f.users.operator.request,
      f.input({
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: f.users.target.accountId,
        roles,
        validUntil: Date.now() + 60_000,
      }),
    ),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 1);
  assert.equal(f.count(TENANT_TABLES.membership), 0);
  await service.execute(f.users.operator.request, f.input({ operation: 'createTenant', tenantId: 'south' }));
  assert.equal(f.count(journal.receipt), 2);
});

test('acquisition never provisions, creates missing files, adopts wrong bindings or uses a structural auth fake', async (t) => {
  const f = await fixture(t);
  const missing = join(f.directory, 'missing.db');
  for (const options of [
    { ...f.options, path: missing },
    { ...f.options, path: f.auth.store },
    { ...f.options, binding: { ...f.binding, storeId: 'wrong' } },
    { ...f.options, auth: { ...f.auth } },
  ]) {
    await assert.rejects(openSqliteTenantAdministration(options), safe());
  }
  assert.equal(existsSync(missing), false);
  f.db.exec(`DROP TABLE "${journal.receipt}"; DROP TABLE "${journal.meta}"`);
  await assert.rejects(openSqliteTenantAdministration(f.options), safe());
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_admin_%'").get()!.n, 0);
});

test('synchronous capture rejects hooks and observes neither later intent nor policy mutation', async (t) => {
  const f = await fixture(t);
  let hooks = 0;
  const input = f.input({ operation: 'createTenant', tenantId: 'north' });
  const hostile = { ...input };
  Object.defineProperty(hostile, 'intent', {
    enumerable: true,
    get: () => {
      hooks++;
      return input.intent;
    },
  });
  await assert.rejects(f.service.execute(f.users.operator.request, hostile), safe());
  assert.equal(hooks, 0);
  const pending = f.service.execute(f.users.operator.request, input);
  (input.intent as { tenantId: string }).tenantId = 'south';
  (f.policy.operators[0].tenants as string[]).splice(0);
  assert.equal((await pending).change.after.tenant.tenantId, 'north');
  assert.equal(f.count(journal.receipt), 1);
  assert.equal(typeof (f.service as TenantAdministration & { transaction?: unknown }).transaction, 'undefined');
});

test('concurrent different status intents have one CAS winner and no losing audit', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  const results = await Promise.allSettled(
    ['suspended', 'closed'].map((status) =>
      f.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: status as 'suspended' | 'closed' }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  safe()(loser.reason);
  assert.equal(f.count(journal.receipt), 2);
  assert.equal(f.count(journal.receipt), 2);
  assert.equal(f.db.prepare(`SELECT version FROM "${TENANT_TABLES.tenant}" WHERE id='north'`).get()!.version, '2');
});

test('historical result validation refuses malformed, cross-tenant and widened-role images', async (t) => {
  const f = await fixture(t);
  await f.execute({ operation: 'createTenant', tenantId: 'north' });
  const input = f.input({
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: f.users.target.accountId,
    roles: ['reader'],
    validUntil: Date.now() + 60_000,
  });
  const result = await f.service.execute(f.users.operator.request, input);
  const original = JSON.parse(JSON.stringify(result.change));
  const corrupt = [
    null,
    {},
    { ...original, unexpected: true },
    { ...original, operation: 'createTenant' },
    { ...original, before: null },
    { ...original, after: { ...original.after, tenant: { ...original.after.tenant, tenantId: 'south' } } },
    ...[
      { roles: ['owner'] },
      { accountId: f.users.outsider.accountId },
      { version: '2' },
      { status: 'invited' },
      { validUntil: original.after.membership.validUntil + 1 },
      { tenantId: 'south' },
    ].map((change) => ({ ...original, after: { ...original.after, membership: { ...original.after.membership, ...change } } })),
  ];
  for (const change of corrupt) {
    f.db.prepare(`UPDATE "${journal.receipt}" SET result_json=? WHERE id=?`).run(JSON.stringify(change), result.receiptId);
    await assert.rejects(f.service.status(f.users.operator.request, input), safe('unknown'));
  }
  f.db.prepare(`UPDATE "${journal.receipt}" SET result_json=? WHERE id=?`).run(JSON.stringify(original), result.receiptId);
  assert.equal((await f.service.status(f.users.operator.request, input))!.receiptId, result.receiptId);
  assert.equal(f.count(journal.receipt), 2);
});
