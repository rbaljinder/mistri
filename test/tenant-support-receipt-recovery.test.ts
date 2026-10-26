/** Genuine SQLite/native-auth history owner. Seeded receipts are historical
 * storage fixtures, never evidence that support opening/admission is implemented. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSqliteSupportReceiptRecovery } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { SupportReceiptRecoveryFailure } from '../packages/mistri/src/server/tenant/tenantSupportReceiptRecovery.js';
import { createSqliteTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { createSqliteSupportAudit, provisionSqliteSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { supportAuditKey, SUPPORT_AUDIT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { supportFingerprint } from '../packages/mistri/src/server/tenant/tenantSupportChange.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { opening, requested, policy } from './support/supportJournalFixture.js';

async function fixture(t: TestContext) {
  const f = await tenantAdministrationFixture(t),
    key = supportAuditKey('synthetic-support-history-key-at-least-thirty-two-bytes');
  const app = parseAppConfig(
    {
      id: f.binding.appId,
      name: 'Historical support fixture',
      sources: { [f.binding.source.id]: { connection: f.binding.source.connection } },
      resources: { business_record: { owner: 'global' } },
      views: { records: { kind: 'list', from: 'business_record', realm: 'tenant' } },
      home: 'records',
      auth: {
        rows: 'tenant',
        tenancy: { platform: { label: 'Lender' } },
        roles: { operator: { realm: 'platform', read: true }, reviewer: { realm: 'tenant', read: true } },
      },
    },
    'support history fixture',
  );
  provisionSqliteSupportAudit(f.path, f.binding, key);
  const native = captureAppAuthRuntime(f.auth),
    user = f.users.operator;
  const original = await native.sessionInstance(user.request);
  assert.ok(original);
  // Genuine current login, but older than the opening-only five-minute window.
  f.authDb.prepare('UPDATE session SET createdAt=? WHERE id=?').run(new Date(Date.now() - 600000).toISOString(), original.sessionId);
  const proof = await native.sessionInstance(user.request);
  assert.ok(proof);
  const change = opening(),
    at = Date.now() - 600000;
  change.after.membership.accountId = change.after.session.accountId = user.accountId;
  change.after.membership.validUntil = change.after.session.validUntil = at + 300000; // Already expired history.
  change.after.session.openedAt = new Date(at).toISOString();
  change.after.session.nativeSessionId = proof.sessionId;
  const receipt = {
    actorId: user.accountId,
    tenantId: 'north',
    operation: 'openSupport',
    operationVersion: 1,
    idempotencyKey: 'history-attempt',
    id: change.after.session.openReceiptId,
    requestId: 'history-request',
    fingerprint: supportFingerprint({
      binding: f.binding,
      deployment: 'deployment',
      actorId: user.accountId,
      nativeSessionId: proof.sessionId,
      policy,
      intent: requested,
    }),
    completedAt: change.after.session.openedAt,
    resultJson: JSON.stringify(change),
  };
  const operations = new TransactionOperations();
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const { endedAt: _ended, endReason: _reason, ...session } = change.after.session;
    await createSqliteSupportAudit(f.db, operations, f.binding, key).open(session, {
      kind: 'open',
      at: session.openedAt,
      requestId: receipt.requestId,
      actorId: user.accountId,
      tenantVersion: '1',
      supportMembershipVersion: '1',
      parentMembershipVersion: session.parentMembershipVersion,
      platformVersion: session.platformVersion,
      resource: null,
      operation: null,
      keyJson: null,
      detailJson: '{}',
      commandReceiptId: null,
    });
    await createSqliteTenantAdministrationJournal(f.db, operations, f.binding).commit(receipt, {
      policyId: policy.id,
      policyVersion: policy.version,
      deployment: 'deployment',
      sessionId: proof.sessionId,
      changeJson: receipt.resultJson,
    });
    await operations.finish();
    f.db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    f.db.exec('ROLLBACK');
    throw error;
  }
  const options = { path: f.path, binding: f.binding, auth: f.auth, deployment: 'deployment' };
  const privateOptions = { app, policy: structuredClone(policy), key };
  const owner = await openSqliteSupportReceiptRecovery(options, privateOptions);
  f.addCleanup(owner.retire);
  const attempt = {
    expectedAccount: user.accountId,
    idempotencyKey: receipt.idempotencyKey,
    intent: requested as {
      operation: 'openSupport';
      tenantId: string;
      dealerRole: string;
      reason: string;
    },
  };
  return { ...f, owner, options, privateOptions, proof, attempt, receipt, change };
}

test('support history uses genuine old native login without opening-age or support-expiry renewal', async (t) => {
  const f = await fixture(t);
  const reply = await f.owner.status(f.users.operator.request, f.attempt);
  assert.deepEqual(Object.keys(f.owner).sort(), ['retire', 'status']);
  assert.ok(reply && Object.isFrozen(reply));
  assert.equal(reply.stage, 'support-receipt-recovery');
  assert.equal(reply.authorization, 'pending');
  assert.equal(reply.receiptId, f.receipt.id);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.change)), f.change);
  assert.equal(await f.owner.status(f.users.operator.request, { ...f.attempt, idempotencyKey: 'missing' }), null);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM __mistri_tenant_membership WHERE kind='support'").get()!.n, 0);
  assert.equal(f.db.prepare("SELECT value FROM business_record WHERE id='one'").get()!.value, 'original');
  await assert.rejects(f.owner.status(f.users.outsider.request, f.attempt), SupportReceiptRecoveryFailure);
  assert.equal(
    await f.owner.status(f.users.outsider.request, {
      ...f.attempt,
      expectedAccount: f.users.outsider.accountId,
    }),
    null,
  ); // Own missing scope reveals no other-account receipt.
});

test('support history binds exact intent, current native session, App, policy and deployment', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.status(f.users.operator.request, {
      ...f.attempt,
      intent: { ...f.attempt.intent, reason: 'Different intent' },
    }),
    SupportReceiptRecoveryFailure,
  );
  const foreign = await openSqliteSupportReceiptRecovery({ ...f.options, deployment: 'new-deployment' }, f.privateOptions);
  f.addCleanup(foreign.retire);
  await assert.rejects(foreign.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
  f.privateOptions.app.name = 'mutated';
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
  f.privateOptions.app.name = 'Historical support fixture';
  f.privateOptions.policy.version = 'different';
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
});

test('support history refuses a corrupted MAC header and copied auth before any new store ownership', async (t) => {
  const f = await fixture(t);
  await assert.rejects(openSqliteSupportReceiptRecovery({ ...f.options, auth: { ...f.auth } }, f.privateOptions));
  f.db.prepare(`UPDATE "${tables.session}" SET reason=reason || char(0) || 'tail' WHERE id=?`).run(f.change.after.session.id);
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
});

/** Intercept only an actual support-header get on the owned writer; leave
 * native auth SQL and all results untouched. No fake session/proof is supplied. */
function afterHeader(t: TestContext, run: () => void) {
  const prepare = DatabaseSync.prototype.prepare;
  let fired = false;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (!fired && sql.includes(`FROM main."${tables.session}" WHERE id = ?`)) {
      const get = statement.get;
      t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
        const row = get.apply(statement, args);
        if (!fired) {
          fired = true;
          run();
        }
        return row;
      });
    }
    return statement;
  });
  return () => fired;
}

test('native deletion after actual header read discards recovered history', async (t) => {
  const f = await fixture(t);
  const fired = afterHeader(t, () => {
    f.authDb.prepare('DELETE FROM session WHERE id=?').run(f.proof.sessionId);
  });
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
  assert.equal(fired(), true);
});

test('retirement during genuine writer work drains it and permanently refuses new history reads', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let retirement: Promise<void> | undefined,
    settled = false;
  const fired = afterHeader(t, () => {
    retirement = f.owner.retire().then(() => {
      settled = true;
    });
    assert.equal(settled, false);
  });
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
  assert.equal(fired(), true);
  await retirement;
  assert.equal(settled, true);
  await assert.rejects(f.owner.status(f.users.operator.request, f.attempt), SupportReceiptRecoveryFailure);
});

test('new native login and aborted requests cannot recover another login attempt', async (t) => {
  const f = await fixture(t);
  const response = await f.callNative('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'operator@example.test', password: 'tenant-administration-operator-password-123' }),
  });
  assert.equal(response.response.status, 200);
  const cookie = response.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const request = { headers: { cookie, origin: f.origin } } as IncomingMessage;
  const proof = await captureAppAuthRuntime(f.auth).sessionInstance(request);
  assert.ok(proof);
  assert.notEqual(proof.sessionId, f.proof.sessionId);
  await assert.rejects(f.owner.status(request, f.attempt), SupportReceiptRecoveryFailure);
  await assert.rejects(
    f.owner.status({ headers: f.users.operator.request.headers, aborted: true } as IncomingMessage, f.attempt),
    SupportReceiptRecoveryFailure,
  );
});
