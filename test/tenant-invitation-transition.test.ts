import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  invitationUuid,
  invitationRevision,
  planInvitationTransition,
} from '../packages/mistri/src/server/tenant/tenantInvitationTransition.js';

const invitationId = '12345678-1234-4234-8234-123456789012';
const row = { invitationId, version: '9007199254740993', status: 'pending' };
const request = { invitationId, expectedVersion: row.version, status: 'accepted' as const };
test('shared storage assertions retain UUID4 length and exact revision boundaries', () => {
  invitationUuid(invitationId);
  for (const value of [
    invitationId + '\n',
    invitationId.slice(0, -1) + '\n',
    invitationId.replace('-4234-', '-1234-'),
    invitationId.replace('-8234-', '-7234-'),
    invitationId.slice(1),
    invitationId + '0',
    null,
  ])
    assert.throws(() => invitationUuid(value));
  for (const value of ['1', '9'.repeat(128)]) invitationRevision(value);
  for (const value of ['', '0', '01', '-1', '1\n', '\n1', '1\r', '1 ', '9'.repeat(129), 1]) assert.throws(() => invitationRevision(value));
  const version = '1' + '0'.repeat(127);
  assert.equal(
    planInvitationTransition({ ...row, version }, { ...request, expectedVersion: version }).nextVersion,
    '1' + '0'.repeat(126) + '1',
  );
});
test('invitation lifecycle permits only pending acceptance/revocation with exact captured revisions', () => {
  for (const status of ['accepted', 'revoked'] as const) {
    const input = { ...request, status },
      current = { ...row };
    const plan = planInvitationTransition(current, input);
    input.expectedVersion = '1';
    current.version = '1';
    assert.deepEqual(plan, { invitationId, expectedVersion: row.version, status, nextVersion: '9007199254740994' });
    assert.ok(Object.isFrozen(plan));
  }
});
test('missing, foreign, stale, terminal and revision-overflow invitations refuse', () => {
  for (const current of [
    null,
    { ...row, invitationId: '22345678-1234-4234-8234-123456789012' },
    { ...row, version: '1' },
    { ...row, status: 'accepted' },
    { ...row, status: 'revoked' },
  ])
    assert.throws(() => planInvitationTransition(current, request));
  for (const version of ['0', '01', '-1', '1\n', '9'.repeat(128)])
    assert.throws(() => planInvitationTransition({ ...row, version }, { ...request, expectedVersion: version }));
  for (const status of ['pending', 'expired', 'active'])
    assert.throws(() => planInvitationTransition(row, { ...request, status } as never));
});
test('transition capture rejects accessors/proxies/extra fields without invoking user code', () => {
  let calls = 0;
  const getter = {
    ...request,
    get expectedVersion() {
      calls++;
      return row.version;
    },
  };
  assert.throws(() => planInvitationTransition(row, getter));
  assert.equal(calls, 0);
  assert.throws(() => planInvitationTransition(new Proxy(row, {}), request));
  assert.throws(() => planInvitationTransition(row, { ...request, roles: ['admin'] } as never));
});
