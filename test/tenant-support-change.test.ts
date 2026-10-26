/** Pure historical contracts: no native session, policy admission or transaction. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureSupportChange,
  captureSupportPolicy,
  supportFingerprint,
  supportGranted,
  validateSupportJournalPair,
} from '../packages/mistri/src/server/tenant/tenantSupportChange.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { validatePair } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalContract.js';
import { captureAdministrationIntent } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';

import { opened, closedAt, policy, requested, opening, exit, exitIntent, replacement, journal } from './support/supportJournalFixture.js';

test('support historical open, cross-dealer supersession and exit are detached and immutable', () => {
  for (const [change, intent] of [
    [opening(), requested],
    [replacement(), requested],
    [exit(), exitIntent],
  ] as const) {
    const result = captureSupportChange(change, intent);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.after.session) && Object.isFrozen(result.after.membership.roles));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), change);
    const { receipt, audit } = journal(change);
    validateSupportJournalPair(receipt, audit);
  }
  const value = opening(),
    result = captureSupportChange(value, requested);
  value.after.membership.roles[0] = 'admin';
  assert.deepEqual(result.after.membership.roles, ['reviewer']);
});

test('every linked membership field and actual session metadata validation is enforced', () => {
  const mutations: ((value: ReturnType<typeof opening>) => void)[] = [
    (value) => {
      value.after.membership.membershipId = 'other';
    },
    (value) => {
      value.after.membership.tenantId = 'south';
    },
    (value) => {
      value.after.membership.accountId = 'other';
    },
    (value) => {
      value.after.membership.kind = 'member';
    },
    (value) => {
      value.after.membership.parentId = 'other';
    },
    (value) => {
      value.after.membership.parentVersion = '3';
    },
    (value) => {
      value.after.membership.platformVersion = '4';
    },
    (value) => {
      value.after.membership.roles = ['reviewer', 'admin'];
    },
    (value) => {
      value.after.membership.roles = ['admin'];
    },
    (value) => {
      value.after.membership.version = '01';
    },
    (value) => {
      value.after.membership.version = '2';
    },
    (value) => {
      value.after.membership.status = 'revoked';
    },
    (value) => {
      value.after.membership.validUntil++;
    },
    (value) => {
      value.after.session.nativeSessionId = '';
    },
    (value) => {
      value.after.session.openReceiptId = '';
    },
    (value) => {
      value.after.session.policyId = '';
    },
    (value) => {
      value.after.session.openedAt = '2026-09-14';
    },
    (value) => {
      value.after.session.openedAt = 'invalid';
    },
    (value) => {
      value.after.session.reason = ' ';
    },
    (value) => {
      value.after.session.reason = 'x'.repeat(501);
    },
    (value) => {
      value.after.session.endedAt = closedAt;
    },
    (value) => {
      value.after.membership.validUntil = value.after.session.validUntil = opened;
    },
    (value) => {
      value.after.membership.validUntil = value.after.session.validUntil = opened + 1800001;
    },
    (value) => {
      Object.assign(value.after.session, { extra: true });
    },
  ];
  for (const mutate of mutations) {
    const value = opening();
    mutate(value);
    assert.throws(() => captureSupportChange(value, requested), TenantContextError);
  }
});

test('closures permit only exact version/status/end changes, never historical role or identity edits', () => {
  for (const mutate of [
    (value: ReturnType<typeof exit>) => {
      value.after.membership.version = '3';
    },
    (value: ReturnType<typeof exit>) => {
      value.after.session.reason = 'changed';
    },
    (value: ReturnType<typeof exit>) => {
      value.after.session.nativeSessionId = 'other';
    },
    (value: ReturnType<typeof exit>) => {
      value.after.session.endReason = 'superseded';
    },
    (value: ReturnType<typeof exit>) => {
      value.after.session.endedAt = '2026-09-14T11:00:00.000Z';
    },
    (value: ReturnType<typeof exit>) => {
      value.after.session.endedAt = '2026-09-14';
    },
    (value: ReturnType<typeof exit>) => {
      value.before.membership.status = 'revoked';
    },
  ]) {
    const value = exit();
    mutate(value);
    assert.throws(() => captureSupportChange(value, exitIntent), TenantContextError);
  }
  for (const mutate of [
    (value: ReturnType<typeof replacement>) => {
      value.replaced.after.session.endedAt = closedAt;
    },
    (value: ReturnType<typeof replacement>) => {
      value.replaced.after.session.endReason = 'exit';
    },
    (value: ReturnType<typeof replacement>) => {
      value.replaced.before.membership.accountId = value.replaced.before.session.accountId = 'other';
      value.replaced.after.membership.accountId = value.replaced.after.session.accountId = 'other';
    },
  ]) {
    const value = replacement();
    mutate(value);
    assert.throws(() => captureSupportChange(value, requested), TenantContextError);
  }
  assert.throws(() => captureSupportChange(exit(), { ...exitIntent, expectedSupportVersion: '2' }), TenantContextError);
});

test('receipt/audit pair rejects mismatched scope, attribution, output or completion time', () => {
  for (const field of ['actorId', 'tenantId', 'operation', 'id', 'completedAt'] as const) {
    const { receipt, audit } = journal();
    receipt[field] = 'different';
    assert.throws(() => validateSupportJournalPair(receipt, audit), TenantContextError);
  }
  for (const field of ['policyId', 'policyVersion', 'deployment', 'sessionId'] as const) {
    const { receipt, audit } = journal();
    audit[field] = 'different';
    assert.throws(() => validateSupportJournalPair(receipt, audit), TenantContextError);
  }
  for (const text of ['{', '{}', 'null', JSON.stringify(exit()), ' '.repeat(65537)]) {
    const { receipt, audit } = journal();
    audit.changeJson = text;
    assert.throws(() => validateSupportJournalPair(receipt, audit), TenantContextError);
  }
  const { receipt, audit } = journal();
  receipt.operationVersion = 2;
  assert.throws(() => validateSupportJournalPair(receipt, audit), TenantContextError);
  // An exit runs where it runs: after a restart, in another deployment than the opening's.
  const closing = journal(exit());
  validateSupportJournalPair(closing.receipt, { ...closing.audit, deployment: 'restarted-deployment' });
  assert.throws(() => validateSupportJournalPair(closing.receipt, { ...closing.audit, policyVersion: 'other' }), TenantContextError);
});

test('support policy and fingerprint capture exact UTF-8 ordered scope, without granting roles', () => {
  const grants = [
    { platformRole: '\u{10000}', tenants: ['south', 'north'], dealerRoles: ['viewer', 'reviewer'] },
    { platformRole: '\ue000', tenants: 'all' as const, dealerRoles: ['reviewer'] },
  ];
  const captured = captureSupportPolicy({ ...policy, grants });
  assert.deepEqual(
    captured.grants.map((grant) => grant.platformRole),
    ['\ue000', '\u{10000}'],
  );
  // Sets are ordered, so the same policy written twice has one fingerprint.
  assert.deepEqual(JSON.parse(JSON.stringify(captured.grants[1])), {
    platformRole: '\u{10000}',
    tenants: ['north', 'south'],
    dealerRoles: ['reviewer', 'viewer'],
  });
  assert.equal(captured.grants[0].tenants, 'all');
  const scope = {
    binding: { appId: 'app', source: { id: 'business', connection: 'business-connection' }, storeId: 'store' },
    deployment: 'deployment',
    actorId: 'account',
    nativeSessionId: 'native-session',
    policy: { ...policy, grants },
    intent: requested,
  };
  const original = supportFingerprint(scope);
  assert.equal(supportFingerprint({ ...scope, policy: { ...policy, grants: [...grants].reverse() } }), original);
  for (const field of ['deployment', 'actorId', 'nativeSessionId'] as const) {
    assert.notEqual(supportFingerprint({ ...scope, [field]: 'changed' }), original);
  }
  for (const field of ['appId', 'storeId'] as const)
    assert.notEqual(supportFingerprint({ ...scope, binding: { ...scope.binding, [field]: 'changed' } }), original);
  for (const field of ['id', 'connection'] as const)
    assert.notEqual(
      supportFingerprint({ ...scope, binding: { ...scope.binding, source: { ...scope.binding.source, [field]: 'changed' } } }),
      original,
    );
  assert.notEqual(supportFingerprint({ ...scope, intent: { ...requested, reason: requested.reason + ' detail' } }), original);
  assert.throws(() => supportFingerprint({ ...scope, intent: { ...requested, reason: requested.reason + ' ' } }), TenantContextError);
  assert.notEqual(supportFingerprint({ ...scope, policy: { ...policy, version: '2', grants } }), original);
  const grant = policy.grants[0];
  for (const input of [
    { ...policy, grants: [] },
    { ...policy, grants: [grant, grant] },
    // One grant per platform role: a second would merge reach from two places.
    { ...policy, grants: [grant, { ...grant, tenants: ['south'] }] },
    { ...policy, grants: Array(1) },
    { ...policy, allowAll: true },
    { ...policy, grants: [{ ...grant, tenants: ['@platform'] }] },
    { ...policy, grants: [{ ...grant, tenants: [] }] },
    { ...policy, grants: [{ ...grant, tenants: ['north', 'north'] }] },
    { ...policy, grants: [{ ...grant, tenants: 'every' }] },
    { ...policy, grants: [{ ...grant, tenants: '*' }] },
    { ...policy, grants: [{ ...grant, platformRole: '*' }] },
    { ...policy, grants: [{ ...grant, dealerRoles: ['*'] }] },
    { ...policy, grants: [{ ...grant, dealerRoles: [] }] },
    { ...policy, grants: [{ ...grant, dealerRoles: ['reviewer', 'reviewer'] }] },
    { ...policy, grants: [{ platformRole: 'operator', tenantId: 'north', dealerRole: 'reviewer' }] },
  ]) {
    assert.throws(() => captureSupportPolicy(input), TenantContextError);
  }
});

test('a support grant matches whole: one platform role, one dealer, one dealer role, never a union', () => {
  const captured = captureSupportPolicy({
    id: 'support',
    version: '1',
    grants: [
      { platformRole: 'reviewer', tenants: ['north'], dealerRoles: ['dealer_staff'] },
      { platformRole: 'lender_admin', tenants: 'all', dealerRoles: ['dealer_admin'] },
    ],
  });
  assert.equal(supportGranted(captured, ['reviewer'], 'north', 'dealer_staff'), true);
  assert.equal(supportGranted(captured, ['reviewer'], 'south', 'dealer_staff'), false);
  assert.equal(supportGranted(captured, ['reviewer'], 'north', 'dealer_admin'), false);
  // Holding both roles never lends the admin grant's role to the reviewer grant's dealer list, or back.
  assert.equal(supportGranted(captured, ['reviewer', 'lender_admin'], 'south', 'dealer_admin'), true);
  assert.equal(supportGranted(captured, ['reviewer', 'lender_admin'], 'south', 'dealer_staff'), false);
  assert.equal(supportGranted(captured, [], 'north', 'dealer_staff'), false);
});

test('hostile change/policy input cannot execute getters or proxy hooks', () => {
  let calls = 0;
  const getter = {
    get operation() {
      calls++;
      return 'openSupport';
    },
  };
  const proxy = new Proxy(opening(), {
    ownKeys() {
      calls++;
      return [];
    },
  });
  assert.throws(() => captureSupportChange(getter, requested), TenantContextError);
  assert.throws(() => captureSupportChange(proxy, requested), TenantContextError);
  assert.throws(
    () =>
      captureSupportPolicy({
        ...policy,
        get grants() {
          calls++;
          return [];
        },
      }),
    TenantContextError,
  );
  assert.equal(calls, 0);
});

test('journal dispatch validates support history without widening ordinary administration', () => {
  for (const change of [opening(), replacement(), exit()]) {
    const { receipt, audit } = journal(change);
    validatePair(receipt, audit);
    assert.throws(() => captureAdministrationIntent({ operation: change.operation, tenantId: 'north' }), TenantContextError);
    const bad = structuredClone(change);
    bad.after.session.nativeSessionId = 'foreign';
    assert.throws(() => validatePair({ ...receipt, resultJson: JSON.stringify(bad) }, audit), TenantContextError);
  }
  const { receipt, audit } = journal();
  // The low-level legacy vocabulary is not a new universal allowlist.
  validatePair({ ...receipt, operation: 'tenant.create', resultJson: '{}' }, { ...audit, changeJson: '{}' });
});
