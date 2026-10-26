import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import type { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSqliteTenantAdministration } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import type { InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { TenantInvitationFailure } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import { INVITATION_TABLES, provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  INVITATION_ISSUER_OPERATIONS,
  type InvitationAcceptanceResult,
  type InvitationExecutionReply,
  type InvitationIntent,
  type InvitationPair,
  type InvitationRequest,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const safeFailure =
  (outcome: 'not_applied' | 'unknown' = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof TenantInvitationFailure);
    assert.equal(error.code, 'tenant_invitation_unavailable');
    assert.equal(error.message, 'The invitation operation could not be confirmed.');
    assert.equal(error.outcome, outcome);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'outcome']);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
const pairIntent = (pair: InvitationPair) => ({
  tenantId: pair.invitation.tenantId,
  expectedTenantVersion: pair.invitation.expectedTenantVersion,
  invitationId: pair.invitation.invitationId,
  expectedInvitationVersion: pair.invitation.version,
  membershipId: pair.membership.membershipId,
  expectedMembershipVersion: pair.membership.version,
});
const count = (db: DatabaseSync, table: string) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n;
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(
    [TENANT_TABLES.tenant, TENANT_TABLES.membership, INVITATION_TABLES.invitation, journal.receipt, 'business_record'].map((table) =>
      db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    ),
  );
const unchanged = (db: DatabaseSync, before: string) => {
  // Compare the complete private image without including digest-bearing rows in diagnostics.
  assert.equal(snapshot(db) === before, true, 'all invitation, membership, journal and business rows must be unchanged');
};
function pairState(db: DatabaseSync, pair: InvitationPair) {
  return structuredClone({
    invitation: db
      .prepare(`SELECT status, version FROM "${INVITATION_TABLES.invitation}" WHERE invitation_id = ?`)
      .get(pair.invitation.invitationId),
    membership: db.prepare(`SELECT status, version FROM "${TENANT_TABLES.membership}" WHERE id = ?`).get(pair.membership.membershipId),
  });
}
const state = (invitation: string, membership: string, version = '2') => ({
  invitation: { status: invitation, version },
  membership: { status: membership, version },
});
function journalPairs(db: DatabaseSync, expected: number) {
  assert.equal(count(db, journal.receipt), expected);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM "${journal.receipt}" WHERE change_json = result_json`).get()!.n, expected);
  assert.deepEqual(structuredClone(db.prepare('SELECT * FROM business_record').all()), [{ id: 'one', value: 'original' }]);
}
function accepted(reply: InvitationExecutionReply): InvitationAcceptanceResult {
  assert.equal(Object.hasOwn(reply, 'token'), false);
  assert.ok('status' in reply.result);
  assert.deepEqual(
    Object.keys(reply.result).sort(),
    [
      'receiptId',
      'requestId',
      'completedAt',
      'replayed',
      'invitationId',
      'tenantId',
      'membershipId',
      'membershipVersion',
      'roles',
      'validUntil',
      'status',
    ].sort(),
  );
  assert.equal(reply.result.status, 'accepted');
  assert.equal(reply.result.membershipVersion, '2');
  return reply.result;
}

async function fixture(t: TestContext, options: { maxLifetimeMs?: number; nearNativeExpiry?: boolean } = {}) {
  const f = await tenantAdministrationFixture(t);
  provisionSqliteTenantInvitations(f.path, f.binding);
  f.db.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north', 'active', '1', 'tenant')`);
  let instant = Date.now();
  if (options.nearNativeExpiry) {
    const native = captureAppAuthRuntime(f.auth);
    const issuer = await native.sessionInstance(f.users.operator.request);
    const recipient = await native.sessionInstance(f.users.target.request);
    assert.ok(issuer && recipient);
    instant = Math.min(issuer.expiresAt, recipient.expiresAt) - 50;
  }
  const invitations: InvitationPolicy = {
    id: 'lifetime-inviters',
    version: 'v1',
    maxMembershipLifetimeMs: 600_000,
    maxRedemptionLifetimeMs: 120_000,
    maxPendingPerTenant: 10,
    operators: [
      { accountId: f.users.operator.accountId, tenants: ['north'], operations: INVITATION_ISSUER_OPERATIONS, roles: ['reader', 'manager'] },
    ],
  };
  const ownerOptions = {
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    invitations,
    deployment: 'invitation-lifetime',
    now: () => instant,
    maxLifetimeMs: options.maxLifetimeMs ?? 300_000,
  };
  const owner = await openSqliteTenantAdministration(ownerOptions);
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  const api = owner.invitations;
  const session = await api.openIssuer(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(session);
  const input = (intent: InvitationIntent, idempotencyKey: string): InvitationRequest => ({
    expectedAccount: session.accountId,
    context: session.context,
    idempotencyKey,
    intent,
  });
  const issue = async (account = f.users.target) => {
    const request = input(
      {
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: account.accountId,
        roles: ['reader', 'manager'],
        redeemUntil: instant + 60_000,
        validUntil: instant + 120_000,
      },
      `issue-${account.accountId}`,
    );
    const reply = await api.execute(f.users.operator.request, request);
    assert.ok(typeof reply.token === 'string' && reply.token.length > 0);
    assert.ok('change' in reply.result);
    return { request, token: reply.token, pair: reply.result.change.after };
  };
  const acceptance = async (token: string, idempotencyKey = 'accept', account = f.users.target) => {
    const recipient = await api.openRecipient(account.request, {
      expectedAccount: account.accountId,
      invitationId: invitationTokenId(token),
    });
    const owned = { expectedAccount: recipient.accountId, context: recipient.context };
    const preview = await api.preview(account.request, { ...owned, token });
    return { ...owned, idempotencyKey, intent: preview.intent };
  };
  return {
    ...f,
    owner,
    ownerOptions,
    api,
    input,
    issue,
    acceptance,
    now: () => instant,
    setNow: (value: number) => {
      instant = value;
    },
  };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Invitation lifetime barrier timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const observe = <T>(pending: Promise<T>): Promise<PromiseSettledResult<T>> =>
  pending.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
function fulfilled<T>(result: PromiseSettledResult<T>): T {
  assert.equal(result.status, 'fulfilled');
  if (result.status !== 'fulfilled') throw new Error('Expected an applied invitation attempt');
  return result.value;
}
function refused(result: PromiseSettledResult<unknown>, outcome: 'not_applied' | 'unknown' = 'not_applied') {
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') safeFailure(outcome)(result.reason);
}

// Like tenant-administration-lifetime, these top-level cases run serially in
// their own Node process. Hooks borrow the real writer and always restore it.
async function withMaintenance(
  hooks: {
    before?: () => void;
    entered?: (db: DatabaseSync) => void;
    beforeCommit?: (db: DatabaseSync) => void | Promise<void>;
    afterCommit?: () => void | Promise<void>;
  },
  work: () => Promise<void>,
) {
  const original = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  SqliteAdapter.prototype.runtimeMaintenanceTransaction = async function <T>(
    verify: (db: DatabaseSync) => void,
    run: (db: DatabaseSync, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    hooks.before?.();
    const result = await original.call(this, verify, async (db, operations, assertCurrent) => {
      hooks.entered?.(db);
      const value = await run(db, operations, assertCurrent);
      await hooks.beforeCommit?.(db);
      return value;
    });
    await hooks.afterCommit?.();
    return result as T;
  };
  try {
    await work();
  } finally {
    SqliteAdapter.prototype.runtimeMaintenanceTransaction = original;
  }
}

async function ordered(firstCall: () => Promise<InvitationExecutionReply>, secondCall: () => Promise<InvitationExecutionReply>) {
  const staged = gate(),
    release = gate();
  let transactions = 0,
    callbacks = 0,
    secondSettled = false;
  let results!: [PromiseSettledResult<InvitationExecutionReply>, PromiseSettledResult<InvitationExecutionReply>];
  await withMaintenance(
    {
      before: () => {
        transactions++;
      },
      beforeCommit: async () => {
        if (++callbacks === 1) {
          staged.release();
          await bounded(release.wait);
        }
      },
    },
    async () => {
      const first = observe(firstCall());
      let second: Promise<PromiseSettledResult<InvitationExecutionReply>> | undefined;
      try {
        await bounded(staged.wait);
        second = observe(secondCall()).then((result) => {
          secondSettled = true;
          return result;
        });
        await turn();
        assert.equal(secondSettled, false);
        assert.equal(transactions, 1, 'the second attempt must wait behind the staged writer');
        release.release();
        results = await bounded(Promise.all([first, second]));
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
  assert.equal(transactions, 2, 'both attempts must reach the shared writer in order');
  return results;
}

test('invitation lifetime: distinct acceptance attempts serialize to one activation and one receipt', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    first = await f.acceptance(issued.token);
  const second = { ...first, idempotencyKey: 'other-accept' };
  const results = await ordered(
    () => f.api.execute(f.users.target.request, { ...first, token: issued.token }),
    () => f.api.execute(f.users.target.request, { ...second, token: issued.token }),
  );
  const result = accepted(fulfilled(results[0]));
  refused(results[1]);
  assert.equal(result.replayed, false);
  assert.deepEqual(pairState(f.db, issued.pair), state('accepted', 'active'));
  journalPairs(f.db, 2);
  assert.equal(await f.api.status(f.users.target.request, second), null);
  assert.deepEqual(structuredClone(await f.api.status(f.users.target.request, first)), { ...structuredClone(result), replayed: true });
});

test('invitation lifetime: queued same-key acceptance replays exactly without another activation', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  const results = await ordered(
    () => f.api.execute(f.users.target.request, { ...request, token: issued.token }),
    () => f.api.execute(f.users.target.request, request),
  );
  const first = accepted(fulfilled(results[0])),
    replay = accepted(fulfilled(results[1]));
  assert.equal(first.replayed, false);
  assert.deepEqual(structuredClone(replay), { ...structuredClone(first), replayed: true });
  const before = snapshot(f.db);
  await assert.rejects(
    f.api.execute(f.users.target.request, { ...request, intent: { ...request.intent, expectedMembershipVersion: '2' } }),
    safeFailure(),
  );
  assert.deepEqual(await f.api.status(f.users.target.request, request), replay);
  unchanged(f.db, before);
  assert.deepEqual(pairState(f.db, issued.pair), state('accepted', 'active'));
  journalPairs(f.db, 2);
});

for (const operation of ['revokeInvitation', 'reissueInvitation'] as const) {
  for (const acceptanceFirst of [true, false]) {
    test(`invitation lifetime: ${acceptanceFirst ? 'accept then' : 'accept queued behind'} ${operation} has a single CAS winner`, async (t) => {
      const f = await fixture(t),
        issued = await f.issue(),
        request = await f.acceptance(issued.token);
      const issuerIntent: InvitationIntent =
        operation === 'reissueInvitation'
          ? { operation, ...pairIntent(issued.pair), roles: ['reader'], redeemUntil: f.now() + 60_000, validUntil: f.now() + 120_000 }
          : { operation, ...pairIntent(issued.pair) };
      const issuerRequest = f.input(issuerIntent, 'manage-race');
      const accept = () => f.api.execute(f.users.target.request, { ...request, token: issued.token });
      const manage = () => f.api.execute(f.users.operator.request, issuerRequest);
      const results = await ordered(acceptanceFirst ? accept : manage, acceptanceFirst ? manage : accept);
      const winner = fulfilled(results[0]);
      refused(results[1]);
      assert.equal(winner.result.replayed, false);
      assert.deepEqual(pairState(f.db, issued.pair), acceptanceFirst ? state('accepted', 'active') : state('revoked', 'revoked'));
      journalPairs(f.db, 2);
      const before = snapshot(f.db);
      const winnerStatus = acceptanceFirst
        ? await f.api.status(f.users.target.request, request)
        : await f.api.status(f.users.operator.request, issuerRequest);
      assert.deepEqual(structuredClone(winnerStatus), { ...structuredClone(winner.result), replayed: true });
      if (acceptanceFirst) {
        accepted(winner);
        assert.equal(await f.api.status(f.users.operator.request, issuerRequest), null);
        assert.equal(count(f.db, INVITATION_TABLES.invitation), 1);
        assert.equal(count(f.db, TENANT_TABLES.membership), 1);
      } else {
        assert.equal(await f.api.status(f.users.target.request, request), null);
        await assert.rejects(
          f.api.preview(f.users.target.request, {
            expectedAccount: request.expectedAccount,
            context: request.context,
            token: issued.token,
          }),
          safeFailure(),
        );
        assert.ok('change' in winner.result);
        if (operation === 'reissueInvitation') {
          assert.ok(typeof winner.token === 'string' && winner.token.length > 0);
          assert.equal(winner.token === issued.token, false);
          const replacement = winner.result.change.after;
          assert.notEqual(replacement.invitation.invitationId, issued.pair.invitation.invitationId);
          assert.notEqual(replacement.membership.membershipId, issued.pair.membership.membershipId);
          assert.deepEqual(pairState(f.db, replacement), state('pending', 'invited', '1'));
          assert.equal(count(f.db, INVITATION_TABLES.invitation), 2);
          assert.equal(count(f.db, TENANT_TABLES.membership), 2);
          unchanged(f.db, before);
          const fresh = await f.acceptance(winner.token, 'accept-replacement');
          const result = accepted(await f.api.execute(f.users.target.request, { ...fresh, token: winner.token }));
          assert.deepEqual(result.roles, ['reader']);
          assert.equal(result.membershipId, replacement.membership.membershipId);
          assert.deepEqual(pairState(f.db, issued.pair), state('revoked', 'revoked'));
          journalPairs(f.db, 3);
          return;
        }
        assert.equal(Object.hasOwn(winner, 'token'), false);
        assert.equal(count(f.db, INVITATION_TABLES.invitation), 1);
        assert.equal(count(f.db, TENANT_TABLES.membership), 1);
      }
      unchanged(f.db, before);
    });
  }
}

for (const operation of ['acceptInvitation', 'reissueInvitation'] as const) {
  test(`invitation lifetime: ${operation} rolls paired effects back when receipt insertion fails`, async (t) => {
    const f = await fixture(t),
      issued = await f.issue(),
      acceptance = await f.acceptance(issued.token);
    const request =
      operation === 'acceptInvitation'
        ? acceptance
        : f.input(
            { operation, ...pairIntent(issued.pair), roles: ['reader'], redeemUntil: f.now() + 60_000, validUntil: f.now() + 120_000 },
            'reissue-rollback',
          );
    const incoming = operation === 'acceptInvitation' ? f.users.target.request : f.users.operator.request;
    const execution = { ...request, ...(operation === 'acceptInvitation' ? { token: issued.token } : {}) };
    const before = snapshot(f.db);
    let writer: DatabaseSync | undefined,
      injected = false,
      staged: ReturnType<typeof pairState> | undefined;
    let stagedCounts: unknown[] = [],
      stagedPairs: unknown[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.prepare = function (sql: string) {
        if (this === writer && sql.startsWith(`INSERT INTO main."${journal.receipt}"`) && !injected) {
          injected = true;
          staged = pairState(this, issued.pair);
          stagedCounts = [
            this.isTransaction,
            count(this, INVITATION_TABLES.invitation),
            count(this, TENANT_TABLES.membership),
            count(this, journal.receipt),
            count(this, journal.receipt),
          ];
          stagedPairs = structuredClone(
            prepare
              .call(
                this,
                `SELECT i.status AS invitation, i.version AS invitationVersion,
            m.status AS membership, m.version AS membershipVersion FROM "${INVITATION_TABLES.invitation}" i
            JOIN "${TENANT_TABLES.membership}" m ON m.id = i.membership_id ORDER BY i.rowid`,
              )
              .all(),
          );
          throw new Error('PRIVATE_INVITATION_RECEIPT_INSERT');
        }
        return prepare.call(this, sql);
      };
      await withMaintenance(
        {
          entered: (db) => {
            writer = db;
          },
        },
        async () => {
          await assert.rejects(f.api.execute(incoming, execution), safeFailure());
        },
      );
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    assert.equal(injected, true);
    const replacing = operation === 'reissueInvitation';
    assert.deepEqual(staged, replacing ? state('revoked', 'revoked') : state('accepted', 'active'));
    assert.deepEqual(stagedCounts, [true, replacing ? 2 : 1, replacing ? 2 : 1, 1, 1]);
    assert.deepEqual(
      stagedPairs,
      replacing
        ? [
            { invitation: 'revoked', invitationVersion: '2', membership: 'revoked', membershipVersion: '2' },
            { invitation: 'pending', invitationVersion: '1', membership: 'invited', membershipVersion: '1' },
          ]
        : [{ invitation: 'accepted', invitationVersion: '2', membership: 'active', membershipVersion: '2' }],
    );
    unchanged(f.db, before);
    assert.equal(await f.api.status(incoming, request), null);
    assert.deepEqual(pairState(f.db, issued.pair), state('pending', 'invited', '1'));
    const retried = await f.api.execute(incoming, execution);
    assert.equal(retried.result.replayed, false);
    if (!replacing) accepted(retried);
    journalPairs(f.db, 2);
  });
}

test('invitation lifetime: real lost COMMIT acknowledgement is unknown and a fresh owner recovers the exact durable acceptance', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  let writer: DatabaseSync | undefined,
    injected = false,
    committed = false;
  const exec = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function (sql: string) {
      const result = exec.call(this, sql);
      if (this === writer && sql === 'COMMIT' && !injected) {
        injected = true;
        committed = !this.isTransaction;
        throw new Error('PRIVATE_INVITATION_COMMIT_ACKNOWLEDGEMENT');
      }
      return result;
    };
    await withMaintenance(
      {
        entered: (db) => {
          writer = db;
        },
      },
      async () => {
        await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safeFailure('unknown'));
      },
    );
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  assert.equal(injected, true);
  assert.equal(committed, true);
  await f.owner.retire();
  journalPairs(f.db, 2);
  assert.deepEqual(pairState(f.db, issued.pair), state('accepted', 'active'));
  const stored = f.db
    .prepare(`SELECT * FROM "${journal.receipt}" WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`)
    .get(f.users.target.accountId, 'acceptInvitation', request.idempotencyKey);
  assert.ok(stored);
  const historical = JSON.parse(stored.result_json as string).after as InvitationPair;
  const expected = {
    receiptId: stored.id,
    requestId: stored.request_id,
    completedAt: stored.completed_at,
    replayed: true,
    invitationId: historical.invitation.invitationId,
    tenantId: historical.membership.tenantId,
    membershipId: historical.membership.membershipId,
    membershipVersion: historical.membership.version,
    roles: historical.membership.roles,
    validUntil: historical.membership.validUntil,
    status: 'accepted',
  };
  // Recovery must precede fresh redemption checks even in a new deployment and
  // after both absolute invitation and membership expiries have passed.
  f.setNow(issued.pair.invitation.validUntil);
  const fresh = await openSqliteTenantAdministration({ ...f.ownerOptions, deployment: 'invitation-recovery' });
  f.addCleanup(fresh.retire);
  assert.ok(fresh.invitations);
  const session = await fresh.invitations.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: issued.pair.invitation.invitationId,
  });
  const recovery = { ...request, context: session.context };
  const before = snapshot(f.db);
  const status = await fresh.invitations.status(f.users.target.request, recovery);
  assert.deepEqual(structuredClone(status), expected);
  const replay = await fresh.invitations.execute(f.users.target.request, recovery);
  assert.deepEqual(structuredClone(accepted(replay)), expected);
  const visible = JSON.stringify([status, replay, stored, f.db.prepare(`SELECT * FROM "${journal.receipt}"`).all()]);
  assert.equal(visible.includes(issued.token), false);
  assert.equal(visible.includes('PRIVATE_INVITATION_COMMIT_ACKNOWLEDGEMENT'), false);
  unchanged(f.db, before);
});

for (const invalidation of ['inviter ban', 'recipient session revocation'] as const) {
  test(`invitation lifetime: ${invalidation} after final async proof rolls acceptance back on the actual writer`, async (t) => {
    const f = await fixture(t),
      issued = await f.issue(),
      request = await f.acceptance(issued.token);
    const native = captureAppAuthRuntime(f.auth),
      proof = await native.sessionInstance(f.users.target.request);
    assert.ok(proof);
    const before = snapshot(f.db);
    let staged: ReturnType<typeof pairState> | undefined,
      stagedJournal: unknown[] = [],
      changes: number | bigint = 0;
    await withMaintenance(
      {
        beforeCommit: (db) => {
          staged = pairState(db, issued.pair);
          stagedJournal = [db.isTransaction, count(db, journal.receipt), count(db, journal.receipt)];
          // The callback has returned from every async native proof. Only the
          // adapter's synchronous verify/COMMIT boundary remains on this writer.
          changes =
            invalidation === 'inviter ban'
              ? f.authDb.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').run(f.users.operator.accountId).changes
              : f.authDb.prepare('DELETE FROM session WHERE id = ? AND userId = ?').run(proof.sessionId, proof.identity.id).changes;
        },
      },
      async () => {
        await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safeFailure());
      },
    );
    assert.equal(changes, 1);
    assert.deepEqual(staged, state('accepted', 'active'));
    assert.deepEqual(stagedJournal, [true, 2, 2]);
    unchanged(f.db, before);
    if (invalidation === 'inviter ban') {
      assert.equal(native.lookupEligibleAccount(f.users.operator.accountId), null);
      assert.equal(await f.api.status(f.users.target.request, request), null);
    } else {
      assert.equal(await native.sessionInstance(f.users.target.request), null);
      await assert.rejects(f.api.status(f.users.target.request, request), safeFailure());
    }
    journalPairs(f.db, 1);
  });
}

for (const boundary of ['redemption expiry', 'native session expiry', 'backward clock'] as const) {
  test(`invitation lifetime: exact ${boundary} at the final writer fence rolls back the staged pair and journal`, async (t) => {
    // Near native expiry, both genuine sessions remain admissible for setup;
    // the recipient's own absolute deadline is the final acceptance boundary.
    const f = await fixture(t, { nearNativeExpiry: boundary === 'native session expiry' });
    const targetProof = await captureAppAuthRuntime(f.auth).sessionInstance(f.users.target.request);
    assert.ok(targetProof);
    const issued = await f.issue(),
      request = await f.acceptance(issued.token),
      started = f.now();
    if (boundary === 'native session expiry') assert.ok(targetProof.expiresAt < issued.pair.invitation.redeemUntil);
    const before = snapshot(f.db);
    let staged: ReturnType<typeof pairState> | undefined,
      stagedJournal: unknown[] = [];
    await withMaintenance(
      {
        beforeCommit: (db) => {
          staged = pairState(db, issued.pair);
          stagedJournal = [db.isTransaction, count(db, journal.receipt), count(db, journal.receipt)];
          f.setNow(
            boundary === 'redemption expiry'
              ? issued.pair.invitation.redeemUntil
              : boundary === 'native session expiry'
                ? targetProof.expiresAt
                : started - 1,
          );
        },
      },
      async () => {
        await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safeFailure());
      },
    );
    assert.deepEqual(staged, state('accepted', 'active'));
    assert.deepEqual(stagedJournal, [true, 2, 2]);
    unchanged(f.db, before);
    assert.deepEqual(pairState(f.db, issued.pair), state('pending', 'invited', '1'));
    journalPairs(f.db, 1);
  });
}

test('invitation lifetime: queued acceptance retains its deadline while a prior committed reply is held', async (t) => {
  const f = await fixture(t, { maxLifetimeMs: 100 });
  const firstIssue = await f.issue(),
    secondIssue = await f.issue(f.users.outsider);
  const firstRequest = await f.acceptance(firstIssue.token);
  const secondRequest = await f.acceptance(secondIssue.token, 'queued-accept', f.users.outsider);
  const started = f.now(),
    committed = gate(),
    release = gate();
  let transactions = 0,
    callbacks = 0;
  await withMaintenance(
    {
      before: () => {
        transactions++;
      },
      entered: () => {
        callbacks++;
      },
      afterCommit: async () => {
        committed.release();
        await bounded(release.wait);
      },
    },
    async () => {
      const first = observe(f.api.execute(f.users.target.request, { ...firstRequest, token: firstIssue.token }));
      let second: Promise<PromiseSettledResult<InvitationExecutionReply>> | undefined;
      try {
        await bounded(committed.wait);
        f.setNow(started + 10);
        second = observe(f.api.execute(f.users.outsider.request, { ...secondRequest, token: secondIssue.token }));
        await turn();
        assert.equal(transactions, 1);
        f.setNow(started + 100);
        release.release();
        const results = await bounded(Promise.all([first, second]));
        refused(results[0], 'unknown');
        refused(results[1]);
        assert.equal(callbacks, 1, 'expired queued acceptance must fail verification before its transaction callback');
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
  assert.deepEqual(pairState(f.db, firstIssue.pair), state('accepted', 'active'));
  assert.deepEqual(pairState(f.db, secondIssue.pair), state('pending', 'invited', '1'));
  journalPairs(f.db, 3);
  await f.owner.retire();
  const fresh = await openSqliteTenantAdministration({ ...f.ownerOptions, deployment: 'queue-recovery', maxLifetimeMs: 300_000 });
  f.addCleanup(fresh.retire);
  assert.ok(fresh.invitations);
  const recipient = await fresh.invitations.openRecipient(f.users.outsider.request, {
    expectedAccount: f.users.outsider.accountId,
    invitationId: secondIssue.pair.invitation.invitationId,
  });
  const retry = { ...secondRequest, context: recipient.context };
  assert.equal(await fresh.invitations.status(f.users.outsider.request, retry), null);
  const result = accepted(await fresh.invitations.execute(f.users.outsider.request, { ...retry, token: secondIssue.token }));
  assert.equal(result.replayed, false);
  assert.deepEqual(pairState(f.db, secondIssue.pair), state('accepted', 'active'));
  journalPairs(f.db, 4);
});
