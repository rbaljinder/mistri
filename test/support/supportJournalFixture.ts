/** Code-owned historical support journal samples; no authentication or database setup. */
const openedAt = '2026-09-14T12:00:00.000Z',
  opened = Date.parse(openedAt);
const closedAt = '2026-09-14T12:10:00.000Z';
const policy = { id: 'support', version: '1', grants: [{ platformRole: 'operator', tenants: ['north'], dealerRoles: ['reviewer'] }] };
const requested = { operation: 'openSupport', tenantId: 'north', dealerRole: 'reviewer', reason: 'Investigate reported issue' };
function pair() {
  return {
    membership: {
      membershipId: 'support-new',
      tenantId: 'north',
      accountId: 'account',
      kind: 'support',
      version: '1',
      status: 'active',
      roles: ['reviewer'],
      validUntil: opened + 1800000,
      parentId: 'platform-parent',
      parentVersion: '2',
      platformVersion: '3',
    },
    session: {
      id: 'support-new',
      tenantId: 'north',
      accountId: 'account',
      operatorName: 'Operator',
      dealerRole: 'reviewer',
      parentMembershipId: 'platform-parent',
      parentMembershipVersion: '2',
      platformVersion: '3',
      reason: requested.reason,
      openedAt,
      validUntil: opened + 1800000,
      nativeSessionId: 'native-session',
      deployment: 'deployment',
      policyId: policy.id,
      policyVersion: policy.version,
      openReceiptId: 'open-receipt',
      endedAt: null as string | null,
      endReason: null as string | null,
    },
  };
}
const opening = () => ({ operation: 'openSupport', after: pair(), replaced: null });
function close(before: ReturnType<typeof pair>, at = closedAt, reason = 'exit') {
  const after = structuredClone(before);
  after.membership.status = 'revoked';
  after.membership.version = String(BigInt(before.membership.version) + 1n);
  after.session.endedAt = at;
  after.session.endReason = reason;
  return after;
}
function exit() {
  const before = pair();
  return { operation: 'exitSupport', before, after: close(before) };
}
const exitIntent = { operation: 'exitSupport', tenantId: 'north', supportId: 'support-new', expectedSupportVersion: '1' };
function replacement() {
  const old = pair();
  old.membership.membershipId = old.session.id = 'support-old';
  old.membership.tenantId = old.session.tenantId = 'south';
  old.membership.roles = ['old-role'];
  old.session.dealerRole = 'old-role';
  old.membership.parentId = old.session.parentMembershipId = 'old-parent';
  old.session.nativeSessionId = 'previous-login';
  old.session.openReceiptId = 'previous-receipt';
  old.session.policyVersion = 'old-policy';
  old.session.reason = 'Older issue';
  old.session.openedAt = '2026-09-14T11:50:00.000Z';
  old.membership.validUntil = old.session.validUntil = opened;
  return { operation: 'openSupport', after: pair(), replaced: { before: old, after: close(old, openedAt, 'superseded') } };
}
function journal(change = opening() as ReturnType<typeof opening> | ReturnType<typeof exit> | ReturnType<typeof replacement>) {
  return {
    receipt: {
      actorId: 'account',
      tenantId: 'north',
      operation: change.operation,
      operationVersion: 1,
      idempotencyKey: 'attempt',
      id: change.operation === 'openSupport' ? 'open-receipt' : 'exit-receipt',
      fingerprint: 'fingerprint',
      resultJson: JSON.stringify(change),
      requestId: 'request',
      completedAt: change.operation === 'openSupport' ? openedAt : closedAt,
    },
    audit: {
      policyId: policy.id,
      policyVersion: policy.version,
      deployment: 'deployment',
      sessionId: 'native-session',
      changeJson: JSON.stringify(change),
    },
  };
}

export { opened, closedAt, policy, requested, opening, exit, exitIntent, replacement, journal };
