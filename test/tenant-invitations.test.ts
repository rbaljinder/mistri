import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { openSqliteTenantAdministration, TenantAdministrationFailure } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_OPERATIONS, type AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TenantInvitationFailure } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import type { InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { INVITATION_TABLES, provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { invitationTokenId } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { readSqliteTenantMembershipsSnapshot, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  INVITATION_ISSUER_OPERATIONS,
  type InvitationIntent,
  type InvitationPair,
  type InvitationRequest,
  type InvitationAcceptanceResult,
  type InvitationResult,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const safe =
  (outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof TenantInvitationFailure);
    assert.equal(error.code, 'tenant_invitation_unavailable');
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, 'The invitation operation could not be confirmed.');
    assert.equal('cause' in error, false);
    return true;
  };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function recipientResult(value: InvitationResult | InvitationAcceptanceResult): asserts value is InvitationAcceptanceResult {
  assert.ok('status' in value);
  assert.deepEqual(
    Object.keys(value).sort(),
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
  assert.equal(value.status, 'accepted');
}
const pairIntent = (pair: InvitationPair) => ({
  tenantId: pair.invitation.tenantId,
  expectedTenantVersion: pair.invitation.expectedTenantVersion,
  invitationId: pair.invitation.invitationId,
  expectedInvitationVersion: pair.invitation.version,
  membershipId: pair.membership.membershipId,
  expectedMembershipVersion: pair.membership.version,
});

async function fixture(t: TestContext, options: { admin?: boolean; maxPending?: number } = {}) {
  const f = await tenantAdministrationFixture(t);
  provisionSqliteTenantInvitations(f.path, f.binding);
  f.db.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant')`);
  let instant = Date.now(),
    sequence = 0;
  const now = () => instant;
  const invitations: InvitationPolicy = {
    id: 'inviters',
    version: 'v1',
    maxMembershipLifetimeMs: 600_000,
    maxRedemptionLifetimeMs: 120_000,
    maxPendingPerTenant: options.maxPending ?? 10,
    operators: [
      {
        accountId: f.users.operator.accountId,
        tenants: ['north', 'south'],
        operations: INVITATION_ISSUER_OPERATIONS,
        roles: ['reader', 'manager'],
      },
    ],
  };
  const policy: AdministrationPolicy = {
    id: 'administrators',
    version: 'v1',
    maxMembershipLifetimeMs: 600_000,
    operators: [
      {
        accountId: f.users.operator.accountId,
        tenants: ['north', 'south'],
        operations: ADMINISTRATION_OPERATIONS,
        roles: ['reader', 'manager'],
      },
    ],
  };
  const ownerOptions = {
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    invitations,
    ...(options.admin === false ? {} : { policy }),
    deployment: 'invitation-tests',
    now,
  };
  const owner = await openSqliteTenantAdministration(ownerOptions);
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  const api = owner.invitations;
  const issuerSession = await api.openIssuer(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(issuerSession);
  const issuer = { expectedAccount: f.users.operator.accountId, context: issuerSession.context };
  const recipientContexts = new Map<string, { expectedAccount: string; context: string }>();
  const recipientOwner = async (token: string) => {
    const invitationId = invitationTokenId(token);
    let recipient = recipientContexts.get(invitationId);
    if (!recipient) {
      const session = await api.openRecipient(f.users.target.request, { expectedAccount: f.users.target.accountId, invitationId });
      recipient = { expectedAccount: session.accountId, context: session.context };
      recipientContexts.set(invitationId, recipient);
    }
    return recipient;
  };
  const input = (intent: InvitationIntent, idempotencyKey = `attempt-${++sequence}`): InvitationRequest => ({
    ...issuer,
    idempotencyKey,
    intent,
  });
  const issueIntent = (accountId = f.users.target.accountId) => ({
    operation: 'issueInvitation' as const,
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId,
    roles: ['reader', 'manager'],
    redeemUntil: now() + 60_000,
    validUntil: now() + 120_000,
  });
  const issue = async (intent = issueIntent()) => {
    const request = input(intent),
      reply = await api.execute(f.users.operator.request, request);
    assert.equal(typeof reply.token, 'string');
    assert.ok(reply.token);
    assert.ok('change' in reply.result);
    return { request, result: reply.result, token: reply.token, pair: reply.result.change.after };
  };
  const preview = async (token: string) => api.preview(f.users.target.request, { ...(await recipientOwner(token)), token });
  const acceptance = async (token: string) => {
    const view = await preview(token);
    return { ...(await recipientOwner(token)), idempotencyKey: `accept-${++sequence}`, intent: view.intent };
  };
  const count = (table: string) => f.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n;
  const snapshot = () =>
    [INVITATION_TABLES.invitation, TENANT_TABLES.membership, journal.receipt].map((table) =>
      plain(f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()),
    );
  const discover = (accountId = f.users.target.accountId) => {
    f.db.exec('BEGIN');
    try {
      return readSqliteTenantMembershipsSnapshot(
        f.db,
        f.binding,
        { appId: f.binding.appId, accountId, source: f.binding.source, deployment: ownerOptions.deployment },
        now,
      );
    } finally {
      f.db.exec('ROLLBACK');
    }
  };
  const administer = async (intent: Parameters<typeof owner.execute>[1]['intent']) => {
    const session = await owner.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
    assert.ok(session);
    return owner.execute(f.users.operator.request, {
      expectedAccount: session.accountId,
      context: session.context,
      idempotencyKey: `admin-${++sequence}`,
      intent,
    });
  };
  return {
    ...f,
    owner,
    ownerOptions,
    api,
    invitations,
    issuer,
    input,
    issueIntent,
    issue,
    preview,
    acceptance,
    count,
    snapshot,
    discover,
    administer,
    now,
    advance: (value: number) => {
      assert.ok(value >= instant);
      instant = value;
    },
  };
}

test('issuer listings filter complete role ceilings before pagination and disclose no secret or digest', async (t) => {
  const f = await fixture(t);
  const manager = await f.issue({ ...f.issueIntent(), roles: ['manager'] });
  const reader = await f.issue({ ...f.issueIntent(f.users.outsider.accountId), roles: ['reader'] });
  const narrowed: InvitationPolicy = {
    ...f.invitations,
    operators: [
      { accountId: f.users.operator.accountId, tenants: ['north', 'south'], operations: ['issueInvitation'], roles: ['reader', 'manager'] },
      { accountId: f.users.operator.accountId, tenants: ['north'], operations: ['revokeInvitation'], roles: ['manager'] },
      { accountId: f.users.operator.accountId, tenants: ['north'], operations: ['reissueInvitation'], roles: ['reader'] },
    ],
  };
  const next = await openSqliteTenantAdministration({ ...f.ownerOptions, invitations: narrowed });
  f.addCleanup(next.retire);
  const api = next.invitations!;
  const session = await api.openIssuer(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(session);
  const input = { expectedAccount: session.accountId, context: session.context };
  const targets = await api.targets(f.users.operator.request, { ...input, limit: 1 });
  assert.equal(targets.items[0].tenantId, 'north');
  assert.equal(targets.next, 'north');
  const later = await api.targets(f.users.operator.request, { ...input, limit: 1, after: targets.next });
  assert.deepEqual(
    later.items.map((item) => item.tenantId),
    ['south'],
  );
  assert.equal(later.next, null);
  const replaced = await api.list(f.users.operator.request, { ...input, tenantId: 'north', operation: 'reissueInvitation', limit: 1 });
  assert.deepEqual(
    replaced.items.map((item) => item.invitation.invitationId),
    [reader.pair.invitation.invitationId],
  );
  assert.equal(replaced.next, null);
  const revoked = await api.list(f.users.operator.request, { ...input, tenantId: 'north', operation: 'revokeInvitation', limit: 1 });
  assert.deepEqual(
    revoked.items.map((item) => item.invitation.invitationId),
    [manager.pair.invitation.invitationId],
  );
  const serialized = JSON.stringify([targets, later, replaced, revoked]);
  assert.equal(serialized.includes(manager.token), false);
  assert.equal(serialized.includes(reader.token), false);
  assert.equal(serialized.includes('digest'), false);
  await assert.rejects(api.list(f.users.operator.request, { ...input, tenantId: 'south', operation: 'revokeInvitation' }), safe());
  const recipient = await api.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: manager.pair.invitation.invitationId,
  });
  await assert.rejects(api.targets(f.users.target.request, { expectedAccount: recipient.accountId, context: recipient.context }), safe());
});

test('unlinked legacy invited reservations keep their ordinary administrative revoke path', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(`INSERT INTO "${TENANT_TABLES.membership}" VALUES (?, 'north', ?, 'invited', '1', ?, ?, 'member', NULL, NULL, NULL)`)
    .run('legacy-reservation', f.users.target.accountId, JSON.stringify(['reader']), f.now() + 60_000);
  const result = await f.administer({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: 'legacy-reservation',
    expectedMembershipVersion: '1',
  });
  assert.equal(result.change.after.membership?.status, 'revoked');
  assert.equal(result.change.invitation, undefined);
  assert.equal(f.count(INVITATION_TABLES.invitation), 0);
});

test('real issue reserves an invited membership without discovery or business writes', async (t) => {
  const f = await fixture(t, { admin: false }),
    issued = await f.issue();
  assert.equal(issued.result.replayed, false);
  assert.equal(issued.result.change.before, null);
  assert.equal(issued.pair.invitation.status, 'pending');
  assert.equal(issued.pair.membership.status, 'invited');
  assert.equal(issued.pair.invitation.inviterId, f.users.operator.accountId);
  assert.equal(issued.pair.invitation.accountId, f.users.target.accountId);
  assert.equal(issued.pair.membership.membershipId, issued.pair.invitation.membershipId);
  assert.equal(
    issued.pair.invitation.validUntil,
    issued.request.intent.operation === 'issueInvitation' ? issued.request.intent.validUntil : 0,
  );
  assert.equal(f.count(INVITATION_TABLES.invitation), 1);
  assert.equal(f.count(TENANT_TABLES.membership), 1);
  assert.equal(f.count(journal.receipt), 1);
  assert.deepEqual(f.discover(), []);
  assert.deepEqual(f.discover(f.users.operator.accountId), []);
  assert.equal(f.db.prepare('SELECT value FROM business_record').get()!.value, 'original');
  assert.equal(f.authDb.prepare('SELECT emailVerified FROM user WHERE id=?').get(f.users.target.accountId)!.emailVerified, 0);
  assert.ok(Object.isFrozen(issued.result.change.after.invitation.roles));
});

test('recipient preview and acceptance commit once, refresh discovery and recover exact results without a token', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    view = await f.preview(issued.token);
  assert.deepEqual([...view.roles].sort(), [...issued.pair.invitation.roles].sort());
  assert.equal(view.redeemUntil, issued.pair.invitation.redeemUntil);
  assert.equal(view.validUntil, issued.pair.invitation.validUntil);
  const request = await f.acceptance(issued.token);
  const accepted = await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  recipientResult(accepted.result);
  assert.equal(accepted.result.invitationId, issued.pair.invitation.invitationId);
  assert.equal(accepted.result.membershipVersion, '2');
  assert.equal(Object.hasOwn(accepted, 'token'), false);
  assert.equal(f.discover()[0].membershipId, issued.pair.membership.membershipId);
  const replay = await f.api.execute(f.users.target.request, request);
  const status = await f.api.status(f.users.target.request, request);
  recipientResult(replay.result);
  assert.ok(status);
  recipientResult(status);
  assert.deepEqual(plain(replay.result), { ...plain(accepted.result), replayed: true });
  assert.deepEqual(status, replay.result);
  assert.equal(f.count(journal.receipt), 2);
  assert.equal(await f.api.status(f.users.target.request, { ...request, idempotencyKey: 'not-submitted' }), null);
});

test('acceptance receipt survives token and membership expiry plus later direct membership revocation', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  const accepted = await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  await f.administer({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: issued.pair.membership.membershipId,
    expectedMembershipVersion: '2',
  });
  f.advance(issued.pair.invitation.validUntil);
  await assert.rejects(f.preview(issued.token), safe());
  const status = await f.api.status(f.users.target.request, request);
  const replay = await f.api.execute(f.users.target.request, request);
  assert.equal(status!.receiptId, accepted.result.receiptId);
  assert.equal(replay.result.receiptId, status!.receiptId);
  assert.ok(status);
  recipientResult(status);
  recipientResult(replay.result);
  assert.equal(status.status, 'accepted', 'recovery describes the historical commit');
  assert.equal(f.db.prepare(`SELECT status FROM "${TENANT_TABLES.membership}"`).get()!.status, 'revoked');
  assert.deepEqual(f.discover(), []);
  assert.equal(f.count(journal.receipt), 3);
});

test('restart and fresh recipient context recover expired acceptance across deployment and source-alias changes', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  const accepted = await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  await f.owner.retire();
  f.advance(f.now() + 300_001);
  const owner = await openSqliteTenantAdministration({
    ...f.ownerOptions,
    deployment: 'restarted',
    binding: { ...f.binding, source: { ...f.binding.source, connection: 'renamed' } },
  });
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  await assert.rejects(owner.invitations.status(f.users.target.request, request), safe());
  const session = await owner.invitations.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: request.intent.invitationId,
  });
  const recovery = { ...request, context: session.context };
  const status = await owner.invitations.status(f.users.target.request, recovery);
  const replay = await owner.invitations.execute(f.users.target.request, recovery);
  assert.ok(status);
  recipientResult(status);
  recipientResult(replay.result);
  assert.equal(status.receiptId, accepted.result.receiptId);
  assert.equal(status.replayed, true);
  assert.deepEqual(status, replay.result);
  assert.equal(Object.hasOwn(replay, 'token'), false);
  assert.deepEqual(f.discover(), []);
  assert.equal(f.count(journal.receipt), 2);
});

test('concurrent exact issuance produces one token handoff and one durable receipt', async (t) => {
  const f = await fixture(t),
    request = f.input(f.issueIntent(), 'same-issue');
  const replies = await Promise.all([f.api.execute(f.users.operator.request, request), f.api.execute(f.users.operator.request, request)]);
  assert.equal(new Set(replies.map((reply) => reply.result.receiptId)).size, 1);
  assert.equal(replies.filter((reply) => Object.hasOwn(reply, 'token')).length, 1);
  assert.equal(replies.filter((reply) => !reply.result.replayed).length, 1);
  const status = await f.api.status(f.users.operator.request, request);
  assert.equal(status!.receiptId, replies[0].result.receiptId);
  assert.equal(Object.hasOwn(status!, 'token'), false);
  assert.equal(f.count(TENANT_TABLES.membership), 1);
  assert.equal(f.count(journal.receipt), 1);
});

test('duplicate issuance cannot overwrite either a pending reservation or accepted membership', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  for (const accepted of [false, true]) {
    if (accepted) {
      const request = await f.acceptance(issued.token);
      await f.api.execute(f.users.target.request, { ...request, token: issued.token });
    }
    const before = f.snapshot();
    await assert.rejects(f.api.execute(f.users.operator.request, f.input(f.issueIntent())), safe());
    assert.deepEqual(f.snapshot(), before);
  }
  await assert.rejects(
    f.api.execute(
      f.users.operator.request,
      f.input({
        operation: 'reissueInvitation',
        ...pairIntent(issued.pair),
        roles: ['reader'],
        redeemUntil: f.now() + 60_000,
        validUntil: f.now() + 120_000,
      }),
    ),
    safe(),
  );
  assert.equal(f.count(INVITATION_TABLES.invitation), 1);
});

test('conflicting same-key terms refuse while role-order normalization replays the original intent', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    before = f.snapshot();
  assert.equal(issued.request.intent.operation, 'issueInvitation');
  const intent = issued.request.intent as Extract<InvitationIntent, { operation: 'issueInvitation' }>;
  const replay = await f.api.execute(f.users.operator.request, {
    ...issued.request,
    intent: { ...intent, roles: [...intent.roles].reverse() },
  });
  assert.equal(replay.result.receiptId, issued.result.receiptId);
  assert.equal(Object.hasOwn(replay, 'token'), false);
  for (const change of [{ roles: ['reader'] }, { redeemUntil: intent.redeemUntil - 1 }, { validUntil: intent.validUntil - 1 }]) {
    await assert.rejects(f.api.execute(f.users.operator.request, { ...issued.request, intent: { ...intent, ...change } }), safe());
  }
  assert.deepEqual(f.snapshot(), before);
});

test('token and digest are absent from preview, receipts, audits and status including acceptance recovery', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    preview = await f.preview(issued.token);
  const request = await f.acceptance(issued.token);
  const accepted = await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  const status = await f.api.status(f.users.target.request, request);
  recipientResult(accepted.result);
  assert.ok(status);
  recipientResult(status);
  const issuerStatus = await f.api.status(f.users.operator.request, issued.request);
  const receipts = f.db.prepare(`SELECT * FROM "${journal.receipt}"`).all();
  const row = f.db.prepare(`SELECT * FROM "${INVITATION_TABLES.invitation}"`).get()!;
  assert.match(String(row.digest), /^[a-f0-9]{64}$/);
  const visible = JSON.stringify([issued.result, preview, accepted, status, issuerStatus, receipts]);
  assert.equal(visible.includes(issued.token), false);
  assert.equal(visible.includes(String(row.digest)), false);
  assert.doesNotMatch(visible, /"(?:token|secret|digest|tokenDigest)"\s*:/);
  assert.equal(JSON.stringify(row).includes(issued.token), false);
  const acceptanceReceipt = receipts.find((receipt) => receipt.id === accepted.result.receiptId)!;
  assert.equal(acceptanceReceipt.actor_id, f.users.target.accountId);
  assert.equal(JSON.stringify([preview, accepted, status]).includes(f.users.operator.accountId), false);
  assert.doesNotMatch(
    JSON.stringify([preview, accepted, status]),
    /"(?:change|inviterId|policyId|policyVersion|sessionId|deployment)"\s*:/,
  );
});

test('wrong native recipient cannot preview, accept or recover another account attempt', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  const outsider = await f.api.openRecipient(f.users.outsider.request, {
    expectedAccount: f.users.outsider.accountId,
    invitationId: issued.pair.invitation.invitationId,
  });
  const wrong = { expectedAccount: outsider.accountId, context: outsider.context };
  await assert.rejects(f.api.preview(f.users.outsider.request, { ...wrong, token: issued.token }), safe());
  await assert.rejects(f.api.execute(f.users.outsider.request, { ...request, ...wrong, token: issued.token }), safe());
  await assert.rejects(f.api.execute(f.users.outsider.request, { ...request, token: issued.token }), safe());
  await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  await assert.rejects(f.api.status(f.users.outsider.request, request), safe());
  assert.equal(await f.api.status(f.users.outsider.request, { ...request, ...wrong }), null);
  assert.equal(f.count(journal.receipt), 2);
});

test('fresh acceptance requires the correct token and rejects token-bearing durable intents or status requests', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token),
    before = f.snapshot();
  await assert.rejects(f.api.execute(f.users.target.request, request), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: 'invalid' }), safe());
  await assert.rejects(
    f.api.execute(f.users.target.request, {
      ...request,
      intent: { ...request.intent, token: issued.token } as unknown as InvitationIntent,
      token: issued.token,
    }),
    safe(),
  );
  await assert.rejects(f.api.status(f.users.target.request, { ...request, token: issued.token } as InvitationRequest), safe());
  assert.deepEqual(f.snapshot(), before);
});

test('exact redemption expiry denies fresh preview and acceptance without releasing the pending reservation', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token),
    before = f.snapshot();
  f.advance(issued.pair.invitation.redeemUntil);
  await assert.rejects(f.preview(issued.token), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safe());
  await assert.rejects(f.api.execute(f.users.operator.request, f.input(f.issueIntent())), safe());
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.discover(), []);
  assert.equal(await f.api.status(f.users.target.request, request), null);
});

test('explicit revoke atomically terminates the pending pair and invalidates its token', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    acceptance = await f.acceptance(issued.token);
  const request = f.input({ operation: 'revokeInvitation', ...pairIntent(issued.pair) });
  const revoked = await f.api.execute(f.users.operator.request, request);
  assert.ok('change' in revoked.result);
  assert.equal(revoked.result.change.after.invitation.status, 'revoked');
  assert.equal(revoked.result.change.after.membership.status, 'revoked');
  assert.equal(revoked.result.change.after.invitation.version, '2');
  await assert.rejects(f.preview(issued.token), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...acceptance, token: issued.token }), safe());
  assert.equal((await f.api.status(f.users.operator.request, request))!.receiptId, revoked.result.receiptId);
  assert.equal(f.count(journal.receipt), 2);
  assert.deepEqual(f.discover(), []);
});

test('explicit reissue replaces expired reservations and refuses old tokens and cross-invitation contexts', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    oldAcceptance = await f.acceptance(issued.token);
  f.advance(issued.pair.invitation.redeemUntil);
  const request = f.input({
    operation: 'reissueInvitation',
    ...pairIntent(issued.pair),
    roles: ['reader'],
    redeemUntil: f.now() + 60_000,
    validUntil: f.now() + 120_000,
  });
  const reissued = await f.api.execute(f.users.operator.request, request);
  assert.ok(reissued.token);
  assert.ok('change' in reissued.result);
  assert.notEqual(reissued.token, issued.token);
  assert.notEqual(reissued.result.change.after.invitation.invitationId, issued.pair.invitation.invitationId);
  assert.notEqual(reissued.result.change.after.membership.membershipId, issued.pair.membership.membershipId);
  assert.equal(reissued.result.change.revoked!.membership.status, 'revoked');
  await assert.rejects(f.preview(issued.token), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...oldAcceptance, token: issued.token }), safe());
  const requestNew = await f.acceptance(reissued.token);
  assert.notEqual(requestNew.context, oldAcceptance.context);
  await assert.rejects(
    f.api.preview(f.users.target.request, {
      expectedAccount: oldAcceptance.expectedAccount,
      context: oldAcceptance.context,
      token: reissued.token,
    }),
    safe(),
  );
  await assert.rejects(
    f.api.execute(f.users.target.request, { ...requestNew, context: oldAcceptance.context, token: reissued.token }),
    safe(),
  );
  await assert.rejects(f.api.status(f.users.target.request, { ...requestNew, context: oldAcceptance.context }), safe());
  await f.api.execute(f.users.target.request, { ...requestNew, token: reissued.token });
  await assert.rejects(f.api.status(f.users.target.request, { ...requestNew, context: oldAcceptance.context }), safe());
  const status = await f.api.status(f.users.target.request, requestNew);
  assert.ok(status);
  recipientResult(status);
  assert.deepEqual(f.discover()[0].roles, ['reader']);
  assert.equal(f.count(INVITATION_TABLES.invitation), 2);
  assert.equal(f.count(journal.receipt), 3);
});

for (const state of ['banned', 'deleted'] as const)
  test(`${state} recorded inviter blocks fresh acceptance even after recipient preview`, async (t) => {
    const f = await fixture(t),
      issued = await f.issue(),
      request = await f.acceptance(issued.token),
      before = f.snapshot();
    if (state === 'banned') f.authDb.prepare('UPDATE user SET banned=1 WHERE id=?').run(f.users.operator.accountId);
    else f.authDb.prepare('DELETE FROM user WHERE id=?').run(f.users.operator.accountId);
    await assert.rejects(f.preview(issued.token), safe());
    await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safe());
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.discover(), []);
  });

test('issuer logout alone does not revoke account-bound invitation authority', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  const signedOut = await f.callNative('/api/auth/sign-out', { method: 'POST', headers: { cookie: f.users.operator.cookie }, body: '{}' });
  assert.equal(signedOut.response.status, 200);
  const request = await f.acceptance(issued.token);
  await f.api.execute(f.users.target.request, { ...request, token: issued.token });
  assert.equal(f.discover().length, 1);
  assert.equal(f.count(journal.receipt), 2);
  await assert.rejects(f.api.status(f.users.operator.request, issued.request), safe());
});

test('issuer, recipient and administration contexts remain separate with no implicit native or business role grants', async (t) => {
  const f = await fixture(t, { admin: false });
  assert.equal(await f.owner.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId }), null);
  f.authDb.prepare('UPDATE user SET role=? WHERE id=?').run('admin', f.users.outsider.accountId);
  f.db
    .prepare(
      `INSERT INTO "${TENANT_TABLES.membership}" VALUES ('outsider-member','north',?,'active','1','["manager"]',?, 'member', NULL, NULL, NULL)`,
    )
    .run(f.users.outsider.accountId, f.now() + 120_000);
  assert.equal(await f.api.openIssuer(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId }), null);
  const issued = await f.issue();
  const operatorRecipient = await f.api.openRecipient(f.users.operator.request, {
    expectedAccount: f.users.operator.accountId,
    invitationId: issued.pair.invitation.invitationId,
  });
  await assert.rejects(
    f.api.execute(f.users.operator.request, { ...f.input(f.issueIntent()), context: operatorRecipient.context }),
    safe(),
  );
  await assert.rejects(f.api.preview(f.users.operator.request, { ...f.issuer, token: issued.token }), safe());
  await assert.rejects(
    f.owner.execute(f.users.operator.request, {
      ...f.issuer,
      idempotencyKey: 'admin-forged',
      intent: { operation: 'createTenant', tenantId: 'west' },
    }),
    TenantAdministrationFailure,
  );
  assert.equal(f.count(journal.receipt), 1);
});

test('administration grant and context confer no invitation issuer authority', async (t) => {
  const f = await fixture(t);
  await f.owner.retire();
  const owner = await openSqliteTenantAdministration({
    ...f.ownerOptions,
    policy: { ...f.ownerOptions.policy!, operators: [{ ...f.ownerOptions.policy!.operators[0], accountId: f.users.outsider.accountId }] },
  });
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  const admin = await owner.open(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId });
  assert.ok(admin);
  assert.equal(await owner.invitations.openIssuer(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId }), null);
  await assert.rejects(
    owner.invitations.execute(f.users.outsider.request, {
      ...f.input(f.issueIntent()),
      expectedAccount: admin.accountId,
      context: admin.context,
    }),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 0);
});

test('restart rechecks exact issuance-operation grants and narrowed roles before accepting old invitations', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  await f.owner.retire();
  for (const rule of [
    { ...f.invitations.operators[0], operations: ['reissueInvitation'] as const },
    { ...f.invitations.operators[0], roles: ['reader'] },
  ]) {
    const owner = await openSqliteTenantAdministration({ ...f.ownerOptions, invitations: { ...f.invitations, operators: [rule] } });
    f.addCleanup(owner.retire);
    assert.ok(owner.invitations);
    const session = await owner.invitations.openRecipient(f.users.target.request, {
      expectedAccount: f.users.target.accountId,
      invitationId: issued.pair.invitation.invitationId,
    });
    const recipient = { expectedAccount: session.accountId, context: session.context };
    await assert.rejects(owner.invitations.preview(f.users.target.request, { ...recipient, token: issued.token }), safe());
    await assert.rejects(
      owner.invitations.execute(f.users.target.request, {
        ...recipient,
        idempotencyKey: 'accept-denied',
        intent: { operation: 'acceptInvitation', ...pairIntent(issued.pair) },
        token: issued.token,
      }),
      safe(),
    );
    await owner.retire();
  }
  assert.equal(f.count(journal.receipt), 1);
  assert.deepEqual(f.discover(), []);
});

test('policy identity change requires explicit reissue and preserves old receipt uncertainty', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  await f.owner.retire();
  const owner = await openSqliteTenantAdministration({ ...f.ownerOptions, invitations: { ...f.invitations, version: 'v2' } });
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  const issuer = await owner.invitations.openIssuer(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(issuer);
  const recipient = await owner.invitations.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: issued.pair.invitation.invitationId,
  });
  await assert.rejects(
    owner.invitations.preview(f.users.target.request, {
      expectedAccount: recipient.accountId,
      context: recipient.context,
      token: issued.token,
    }),
    safe(),
  );
  await assert.rejects(owner.invitations.status(f.users.operator.request, { ...issued.request, context: issuer.context }), safe());
  const reissued = await owner.invitations.execute(f.users.operator.request, {
    ...f.input({
      operation: 'reissueInvitation',
      ...pairIntent(issued.pair),
      roles: ['reader'],
      redeemUntil: f.now() + 60_000,
      validUntil: f.now() + 120_000,
    }),
    context: issuer.context,
  });
  assert.ok(reissued.token);
  assert.ok('change' in reissued.result);
  assert.equal(reissued.result.change.after.invitation.policyVersion, 'v2');
  const newRecipient = await owner.invitations.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: reissued.result.change.after.invitation.invitationId,
  });
  const view = await owner.invitations.preview(f.users.target.request, {
    expectedAccount: newRecipient.accountId,
    context: newRecipient.context,
    token: reissued.token,
  });
  assert.deepEqual(view.roles, ['reader']);
  assert.equal(f.count(journal.receipt), 2);
});

test('suspend and reactivate fences preexisting invitation revision until explicit reissue', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  await f.administer({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' });
  await f.administer({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '2', status: 'active' });
  await assert.rejects(f.preview(issued.token), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safe());
  const reissued = await f.api.execute(
    f.users.operator.request,
    f.input({
      operation: 'reissueInvitation',
      ...pairIntent(issued.pair),
      expectedTenantVersion: '3',
      roles: ['reader'],
      redeemUntil: f.now() + 60_000,
      validUntil: f.now() + 120_000,
    }),
  );
  assert.ok(reissued.token);
  assert.equal((await f.preview(reissued.token)).intent.expectedTenantVersion, '3');
  assert.equal(f.count(journal.receipt), 4);
});

test('direct administrative membership revoke also terminates its linked pending invitation', async (t) => {
  const f = await fixture(t),
    issued = await f.issue(),
    request = await f.acceptance(issued.token);
  await f.administer({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: issued.pair.membership.membershipId,
    expectedMembershipVersion: '1',
  });
  assert.equal(f.db.prepare(`SELECT status FROM "${INVITATION_TABLES.invitation}"`).get()!.status, 'revoked');
  assert.equal(f.db.prepare(`SELECT status FROM "${TENANT_TABLES.membership}"`).get()!.status, 'revoked');
  await assert.rejects(f.preview(issued.token), safe());
  await assert.rejects(f.api.execute(f.users.target.request, { ...request, token: issued.token }), safe());
  assert.equal(f.count(journal.receipt), 2);
});

test('administration-only owner atomically revokes linked pending tokens when invitation policy is disabled', async (t) => {
  const f = await fixture(t),
    issued = await f.issue();
  await f.owner.retire();
  const admin = await openSqliteTenantAdministration({ ...f.ownerOptions, invitations: undefined });
  f.addCleanup(admin.retire);
  assert.equal(admin.invitations, undefined);
  const session = await admin.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(session);
  const request = {
    expectedAccount: session.accountId,
    context: session.context,
    idempotencyKey: 'direct-revoke',
    intent: {
      operation: 'revokeMembership' as const,
      tenantId: 'north',
      expectedTenantVersion: '1',
      membershipId: issued.pair.membership.membershipId,
      expectedMembershipVersion: '1',
    },
  };
  const revoked = await admin.execute(f.users.operator.request, request);
  assert.equal(revoked.change.invitation!.before.status, 'pending');
  assert.equal(revoked.change.invitation!.after.status, 'revoked');
  assert.equal(f.db.prepare(`SELECT status FROM "${INVITATION_TABLES.invitation}"`).get()!.status, 'revoked');
  assert.equal(f.db.prepare(`SELECT status FROM "${TENANT_TABLES.membership}"`).get()!.status, 'revoked');
  assert.equal((await admin.status(f.users.operator.request, request))!.receiptId, revoked.receiptId);
  await admin.retire();
  const reopened = await openSqliteTenantAdministration(f.ownerOptions);
  f.addCleanup(reopened.retire);
  assert.ok(reopened.invitations);
  const recipient = await reopened.invitations.openRecipient(f.users.target.request, {
    expectedAccount: f.users.target.accountId,
    invitationId: issued.pair.invitation.invitationId,
  });
  await assert.rejects(
    reopened.invitations.preview(f.users.target.request, {
      expectedAccount: recipient.accountId,
      context: recipient.context,
      token: issued.token,
    }),
    safe(),
  );
  assert.equal(f.count(journal.receipt), 2);
});

test('expired reservations still count against pending ceiling until explicit revoke', async (t) => {
  const f = await fixture(t, { maxPending: 1 }),
    issued = await f.issue();
  f.advance(issued.pair.invitation.redeemUntil);
  await assert.rejects(f.api.execute(f.users.operator.request, f.input(f.issueIntent(f.users.outsider.accountId))), safe());
  assert.equal(f.count(INVITATION_TABLES.invitation), 1);
  assert.equal(f.count(journal.receipt), 1);
  await f.api.execute(f.users.operator.request, f.input({ operation: 'revokeInvitation', ...pairIntent(issued.pair) }));
  await f.issue(f.issueIntent(f.users.outsider.accountId));
  assert.equal(f.count(INVITATION_TABLES.invitation), 2);
  assert.equal(f.count(journal.receipt), 3);
});

test('issue requires eligible exact native recipient IDs without mailbox matching or partial writes', async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  for (const accountId of ['missing-account', 'target@example.test']) {
    await assert.rejects(f.api.execute(f.users.operator.request, f.input(f.issueIntent(accountId))), safe());
  }
  f.authDb.prepare('UPDATE user SET banned=1 WHERE id=?').run(f.users.target.accountId);
  await assert.rejects(f.api.execute(f.users.operator.request, f.input(f.issueIntent())), safe());
  assert.deepEqual(f.snapshot(), before);
});
