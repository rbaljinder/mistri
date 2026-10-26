import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureStoredTenantInvitation,
  decodeInvitationRow,
  invitationBinding,
  invitationFields,
  invitationRowValues,
} from '../packages/mistri/src/server/tenant/tenantInvitationStoreContract.js';

const row = () => ({
  invitationId: '36c77f92-cf69-412d-ade3-3971490fb83a',
  version: '1',
  tenantId: 'north',
  membershipId: '21a53156-f274-4622-8a68-3f0b82c2c45a',
  accountId: 'recipient',
  inviterId: 'operator',
  issuanceOperation: 'issueInvitation' as const,
  roles: ['writer', 'reader'],
  expectedTenantVersion: '1',
  policyId: 'operators',
  policyVersion: 'v1',
  createdAt: 100,
  redeemUntil: 200,
  validUntil: 300,
  status: 'pending' as const,
  digest: 'ab'.repeat(32),
});

test('invitation SQL row codec retains exact field order and canonical roles', () => {
  const original = row(),
    values = invitationRowValues(original);
  original.roles.push('admin');
  original.validUntil = 999;
  const decoded = decodeInvitationRow(Object.fromEntries(invitationFields.map((field, index) => [field, values[index]])));
  assert.deepEqual(decoded.roles, ['reader', 'writer']);
  assert.equal(decoded.validUntil, 300);
  assert.equal(decoded.digest, 'ab'.repeat(32));
  assert.ok(Object.isFrozen(values));
  assert.ok(Object.isFrozen(decoded.roles));
});
test('SQL row decoding refuses noncanonical JSON, unsafe/string times and getter data', () => {
  const raw = { ...row(), roles: '["reader","writer"]' };
  for (const roles of ['["writer","reader"]', '[ "reader", "writer" ]', '["reader","reader"]', '{}', 'null', 'bad'])
    assert.throws(() => decodeInvitationRow({ ...raw, roles }));
  for (const validUntil of [Number.MAX_SAFE_INTEGER + 1, '300', null, 199])
    assert.throws(() => decodeInvitationRow({ ...raw, validUntil }));
  let calls = 0;
  assert.throws(() =>
    decodeInvitationRow({
      ...raw,
      get digest() {
        calls++;
        return raw.digest;
      },
    }),
  );
  assert.equal(calls, 0);
  assert.throws(() => decodeInvitationRow({ ...raw, extra: 1 }));
});
test('shared row and binding capture preserve existing realm/binding restrictions', () => {
  assert.throws(() => captureStoredTenantInvitation({ ...row(), tenantId: '@platform' }));
  assert.throws(() => captureStoredTenantInvitation({ ...row(), digest: 'ab'.repeat(32) + '\n' }));
  const original = { appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } };
  const binding = invitationBinding(original);
  original.source.id = 'changed';
  assert.equal(binding.source.id, 'business');
  assert.ok(Object.isFrozen(binding));
  assert.throws(() => invitationBinding({ ...original, source: { id: 'bad-name', connection: 'alias' } }));
});
