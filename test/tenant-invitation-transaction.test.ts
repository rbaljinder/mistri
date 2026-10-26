/** Pure before-image parity. Native transaction/SQL paths use the serial invitation suites. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  createSqliteInvitationTransaction,
  invitationMembershipPair,
  invitationTenantImage,
} from '../packages/mistri/src/server/tenant/tenantInvitationTransaction.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureStoredTenantInvitation } from '../packages/mistri/src/server/tenant/tenantInvitationStoreContract.js';
import { createTenantInvitationOperations } from '../packages/mistri/src/server/tenant/tenantInvitationOperations.js';
import type { AppAuthRuntimeBinding } from '../packages/mistri/src/server/auth/auth.js';
import type { IncomingMessage } from 'node:http';
import { mintInvitationToken } from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';

const row = captureStoredTenantInvitation({
  invitationId: '36c77f92-cf69-412d-ade3-3971490fb83a',
  version: '1',
  tenantId: 'north',
  membershipId: '21a53156-f274-4622-8a68-3f0b82c2c45a',
  accountId: 'recipient',
  inviterId: 'operator',
  issuanceOperation: 'issueInvitation',
  roles: ['reader'],
  expectedTenantVersion: '1',
  policyId: 'p',
  policyVersion: 'v1',
  createdAt: 100,
  redeemUntil: 200,
  validUntil: 300,
  status: 'pending',
  digest: 'ab'.repeat(32),
});
const member = () => ({
  membershipId: row.membershipId,
  tenantId: row.tenantId,
  accountId: row.accountId,
  status: 'invited',
  version: '1',
  roles: '["reader"]',
  validUntil: row.validUntil,
});

test('invitation port tenant before-images preserve exact required-row checks', () => {
  const input = { tenantId: 'north', status: 'active', version: '1' };
  const image = invitationTenantImage(input, 'north');
  input.status = 'closed';
  assert.equal(image.status, 'active');
  assert.ok(Object.isFrozen(image));
  for (const value of [
    undefined,
    null,
    { ...input, tenantId: 'other' },
    { ...input, status: 'platform' },
    ...['0', '01', '1\n', '9'.repeat(129), 1].map((version) => ({ ...input, version })),
  ]) {
    assert.throws(() => invitationTenantImage(value, 'north'));
  }
  for (const status of ['active', 'suspended', 'closed']) assert.equal(invitationTenantImage({ ...input, status }, 'north').status, status);
});

test('invitation port pairs preserve linkage checks and never disclose stored digest', () => {
  const input = member(),
    pair = invitationMembershipPair(input, row);
  input.accountId = 'changed';
  assert.equal(pair.membership.accountId, row.accountId);
  assert.equal(Object.hasOwn(pair.invitation, 'digest'), false);
  assert.ok(Object.isFrozen(pair.membership));
  assert.ok(Object.isFrozen(pair.membership.roles));
  for (const change of [
    { membershipId: 'other' },
    { tenantId: 'other' },
    { accountId: 'other' },
    { status: 'active' },
    { status: 'revoked' },
    { validUntil: 301 },
    { roles: '[]' },
    { roles: '["writer"]' },
    { roles: '{}' },
    { version: '0' },
    { version: '01' },
    { version: '1\n' },
  ])
    assert.throws(() => invitationMembershipPair({ ...member(), ...change }, row));
  assert.throws(() => invitationMembershipPair(undefined, row));
});

test('invitation port before-image capture never executes accessors', () => {
  let calls = 0;
  assert.throws(() =>
    invitationTenantImage(
      {
        get tenantId() {
          calls++;
          return 'north';
        },
        status: 'active',
        version: '1',
      },
      'north',
    ),
  );
  assert.throws(() =>
    invitationMembershipPair(
      {
        ...member(),
        get roles() {
          calls++;
          return '["reader"]';
        },
      },
      row,
    ),
  );
  assert.equal(calls, 0);
});

test('facts guard: construction is inert and authorization loss fences SQL and returned data', () => {
  // Fake SQL proves callback sequencing only, not native store attestation.
  let queries = 0,
    observations = 0,
    revoked = false,
    revokeDuringRead = false;
  const db = {
    isTransaction: true,
    prepare() {
      queries++;
      if (revokeDuringRead) revoked = true;
      return { get: () => ({ tenantId: 'north', status: 'active', version: '1' }) };
    },
  } as unknown as DatabaseSync;
  const transaction = createSqliteInvitationTransaction(
    db,
    new TransactionOperations(),
    { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } },
    () => {
      observations++;
      if (revoked) throw new TenantContextError();
    },
    () => {},
  );
  assert.equal(queries, 0);
  assert.equal(observations, 0, 'eager factories must remain inert');
  assert.equal(transaction.tenant('north').tenantId, 'north');
  assert.equal(queries, 1);
  assert.equal(observations, 2);
  revoked = true;
  assert.throws(() => transaction.tenant('north'), TenantContextError);
  assert.equal(queries, 1, 'pre-read authorization failure must issue no SQL');
  revoked = false;
  revokeDuringRead = true;
  assert.throws(() => transaction.tenant('north'), TenantContextError);
  assert.equal(queries, 2, 'post-read authorization failure suppresses the row');
});

test('facts guard: async/nonvoid callbacks and closed owner transactions refuse before SQL', () => {
  for (const outcome of [true, 1, Promise.resolve(), Promise.reject(new Error('private rejection'))]) {
    let queries = 0;
    const db = {
      isTransaction: true,
      prepare() {
        queries++;
        throw new Error('must not read');
      },
    } as unknown as DatabaseSync;
    const transaction = createSqliteInvitationTransaction(
      db,
      new TransactionOperations(),
      { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } },
      () => outcome,
      () => {},
    );
    assert.throws(() => transaction.optionalTenant('north'), TenantContextError);
    assert.equal(queries, 0);
  }
  const db = {
    isTransaction: false,
    prepare() {
      throw new Error('must not read');
    },
  } as unknown as DatabaseSync;
  const transaction = createSqliteInvitationTransaction(
    db,
    new TransactionOperations(),
    { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } },
    () => {},
    () => {},
  );
  assert.throws(() => transaction.pendingCount('north'), TenantContextError);
});

test('inactive async owner awaits context observations and fact reads without async store fences', async () => {
  // Scheduling double only: no native authority or PG activation is asserted.
  for (const stop of ['none', 'opening', 'fact', 'eligibility']) {
    const request = { aborted: false } as IncomingMessage;
    const calls: string[] = [];
    const proof = { identity: { id: 'operator' }, sessionId: 'session', expiresAt: 1000 };
    const binding = { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } };
    const minted = mintInvitationToken(binding, row.invitationId, 'operator');
    const invitation = captureStoredTenantInvitation({ ...row, accountId: 'operator', digest: minted.digest });
    const auth = {
      synchronous: false,
      assertSessionCurrent() {},
      sessionInstance: async () => {
        calls.push('session');
        return proof;
      },
      observeSession: async () => {
        calls.push('observe');
        if (stop === 'opening') request.aborted = true;
      },
      lookupEligibleAccount() {
        throw new Error('async owner must never use synchronous native lookup');
      },
      lookupEligibleAccountCurrent: async (accountId: string) => {
        calls.push('eligible');
        if (stop === 'eligibility') request.aborted = true;
        return { accountId };
      },
    } as unknown as AppAuthRuntimeBinding;
    const owner = createTenantInvitationOperations({
      auth,
      binding,
      policy: {
        id: 'p',
        version: 'v1',
        maxMembershipLifetimeMs: 1000,
        maxRedemptionLifetimeMs: 500,
        maxPendingPerTenant: 10,
        operators: [{ accountId: 'operator', tenants: ['north'], roles: ['reader'], operations: ['issueInvitation'] }],
      },
      deployment: 'deployment',
      lifetime: 500,
      clock: () => 100,
      tracked: (work) => work(),
      uncertain: () => {},
      transact: async (checks, work) => {
        assert.equal(checks.active(), undefined, 'transaction lifetime verifier remains synchronous');
        return work(
          (active) => {
            const db = { isTransaction: true } as DatabaseSync;
            const transaction = createSqliteInvitationTransaction(
              db,
              new TransactionOperations(),
              { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } },
              active,
              () => {},
            );
            return {
              ...transaction,
              invitations: { ...transaction.invitations, read: async () => invitation },
              pair: async () => invitationMembershipPair({ ...member(), accountId: 'operator' }, invitation),
              tenant: async () => ({ tenantId: 'north', status: 'active' as const, version: '1' }),
              optionalTenant: async () => {
                assert.equal(active(), undefined);
                await Promise.resolve();
                calls.push('fact');
                if (stop === 'fact') request.aborted = true;
                return { tenantId: 'north', status: 'active' as const, version: '1' };
              },
            };
          },
          () => {},
        );
      },
    });
    const pending = owner.openIssuer(request, { expectedAccount: 'operator' });
    if (stop === 'opening') {
      await assert.rejects(pending);
      assert.deepEqual(calls, ['session', 'observe']);
      continue;
    }
    const session = await pending;
    assert.ok(session);
    assert.deepEqual(calls, ['session', 'observe', 'session', 'observe', 'observe']);
    const targets = owner.targets(request, { context: session.context, expectedAccount: 'operator' });
    if (stop === 'fact') await assert.rejects(targets);
    else assert.deepEqual({ ...(await targets).items[0].tenant }, { tenantId: 'north', status: 'active', version: '1' });
    assert.ok(calls.includes('fact'));
    if (stop === 'fact') continue;
    const recipient = await owner.openRecipient(request, { expectedAccount: 'operator', invitationId: row.invitationId });
    const preview = owner.preview(request, { context: recipient.context, expectedAccount: 'operator', token: minted.token });
    if (stop === 'eligibility') await assert.rejects(preview);
    else assert.equal((await preview).intent.membershipId, row.membershipId);
    assert.ok(calls.includes('eligible'));
  }
});
